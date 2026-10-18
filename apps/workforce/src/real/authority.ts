/**
 * The real thing: `WorkforceAuthority` over Developer A's AgentPass HTTP API
 * (docs/11-WORKFORCE-CONTRACT.md). One session per agent credential; every
 * call carries only that agent's bearer. Scope and decision translation
 * between B's adapter contract and A's wire contract happens here and
 * nowhere else, so the agents, gateways and the mock stay unchanged.
 *
 *   B action            A action                  B resource -> A paths
 *   analytics.aggregate analytics.aggregate.read   src/components/** -> src/components/
 *   analytics.raw       analytics.raw.read         package.json      -> package.json
 *   (others identical)                             preview/landing-page -> (no path; resource-level)
 */
import { workforceDecisionSchema, type WorkforceAction as AAction, type WorkforceActionInput, type WorkforceDecision, type WorkforceScope as AScope } from '../../../../packages/contracts/src/workforce.js';
import type {
  ApiError, ApiResult, AuditEvent, Authorization, WorkforceAction, WorkforceAuthority, WorkforceGrant, WorkforceRequest, WorkforceScope, WorkforceSession,
} from '../contract.js';
import { DEMO_RESOURCE } from './resource-adapter.js';

export interface ResourceIdentity { resource?: string; organization_id: string; owner_principal_id: string }

/** A session that can also run protected actions through AgentPass's gateway and provision children. */
export interface RealSession extends WorkforceSession {
  execute(input: { grant_id: string; action: WorkforceAction; resource: string; parameters: Record<string, unknown>; idempotency_key: string }): Promise<ApiResult<{ execution_id: string; result: Record<string, unknown> }>>;
  provisionChild(input: { parent_grant_id: string; scope: WorkforceScope; credential_hash: string; idempotency_key: string }): Promise<ApiResult<{ principal: { id: string }; grant: WorkforceGrant }>>;
}

const TO_A: Partial<Record<WorkforceAction, AAction>> = {
  'repo.read': 'repo.read', 'repo.write': 'repo.write', 'security.audit.run': 'security.audit.run',
  'deploy.preview': 'deploy.preview', 'deploy.production': 'deploy.production',
  'analytics.aggregate': 'analytics.aggregate.read', 'analytics.raw': 'analytics.raw.read',
};
const FROM_A = Object.fromEntries(Object.entries(TO_A).map(([b, a]) => [a, b])) as Record<AAction, WorkforceAction>;
const NON_PATH = new Set(['preview', 'production', 'landing-page']);

/** B resource strings (globs / environment / dataset) -> A path prefixes. Non-file resources carry no path. */
export function toAPaths(resources: string[]): string[] {
  const out: string[] = [];
  for (const r of resources) {
    if (NON_PATH.has(r) || r === '**') continue;
    const p = r.endsWith('/**') ? `${r.slice(0, -3)}/` : r.replace(/\*+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function toAScope(scope: WorkforceScope, identity: ResourceIdentity, defaults: { max_executions: number }): AScope {
  return {
    actions: scope.actions.map((a) => TO_A[a]).filter((a): a is AAction => !!a),
    supplier_ids: [], sku_ids: [], max_per_action_cents: 0, total_budget_cents: 0,
    expires_at: scope.expires_at, max_delegation_depth: scope.max_delegation_depth,
    resources: [{ resource: identity.resource ?? DEMO_RESOURCE, organization_id: identity.organization_id, owner_principal_id: identity.owner_principal_id, paths: toAPaths(scope.resources) }],
    max_executions: scope.max_executions ?? defaults.max_executions,
  };
}

export function fromAScope(scope: AScope): WorkforceScope {
  const actions = scope.actions.map((a) => FROM_A[a]).filter((a): a is WorkforceAction => !!a);
  const resources: string[] = [];
  for (const r of scope.resources) for (const p of r.paths) resources.push(p.endsWith('/') ? `${p}**` : p);
  if (actions.includes('deploy.preview')) resources.push('preview');
  if (actions.includes('deploy.production')) resources.push('production');
  if (actions.some((a) => a.startsWith('analytics.'))) resources.push('landing-page');
  return { actions, resources: [...new Set(resources)], expires_at: scope.expires_at, max_delegation_depth: scope.max_delegation_depth, max_executions: scope.max_executions };
}

const isAScope = (s: unknown): s is AScope => !!s && typeof s === 'object' && Array.isArray((s as AScope).resources);
function mapGrant(g: any): WorkforceGrant {
  return { id: g.id, issuer_principal_id: g.issuer_principal_id, subject_principal_id: g.subject_principal_id, parent_grant_id: g.parent_grant_id ?? null, organization_id: g.organization_id, scope: isAScope(g.scope) ? fromAScope(g.scope) : { actions: [], resources: [], expires_at: g.scope?.expires_at ?? '', max_delegation_depth: 0 }, revoked_at: g.revoked_at ?? null };
}
function mapRequest(r: any): WorkforceRequest {
  return { id: r.id, requester_principal_id: r.requester_principal_id, parent_grant_id: r.parent_grant_id, requested_scope: fromAScope(r.requested_scope), offered_scope: r.offered_scope ? fromAScope(r.offered_scope) : undefined, reason: r.reason, status: r.status, issued_grant_id: r.issued_grant_id };
}

/** A's decision -> B's result envelope. "Recoverable with a named alternative" is B's AUTHORITY_REQUIRED. */
function mapDecision(d: WorkforceDecision): ApiError | undefined {
  if (d.status === 'ALLOW') return undefined;
  const recoverable = d.status === 'AUTHORITY_REQUIRED' || (d.status === 'DENY' && d.next_action === 'request_authority' && (d.required_scope || d.suggested_action));
  if (recoverable) {
    const required = d.required_scope ? fromAScope(d.required_scope) : undefined;
    const alternative = d.suggested_action && required ? { ...required, actions: [FROM_A[d.suggested_action]] } : undefined;
    return { status: 'AUTHORITY_REQUIRED', code: (d.code as ApiError['code']) || 'INSUFFICIENT_SCOPE', reason: d.reason, next_action: 'request_authority', required_scope: required, ...(alternative ? { alternative_scope: alternative } : {}) };
  }
  if (d.status === 'REQUEST_PENDING') return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: `${d.reason} (request ${d.request_id} pending)`, next_action: 'retry' };
  return { status: 'DENIED', code: (d.code as ApiError['code']) || 'INSUFFICIENT_SCOPE', reason: d.reason, next_action: d.next_action === 'retry' ? 'retry' : 'contact_owner' };
}

export interface RealAuthorityOptions {
  authorityUrl: string;
  identity: ResourceIdentity;
  /** Owner credential for reading AgentPass's own audit trail (optional). */
  ownerCredential?: string;
  defaultMaxExecutions?: number;
}

export class RealWorkforceAuthority implements WorkforceAuthority {
  readonly source = 'AGENTPASS' as const;
  private observed: AuditEvent[] = [];
  constructor(private opts: RealAuthorityOptions) {}

  private async call(credential: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.opts.authorityUrl), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try { return await res.json(); } catch { return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: `HTTP ${res.status}` }; }
  }
  private envelope<T>(r: any, map: (data: any) => T): ApiResult<T> {
    if (r?.status === 'OK') return { status: 'OK', data: map(r.data) };
    return { status: r?.status === 'DENIED' ? 'DENIED' : r?.status === 'AUTHORITY_REQUIRED' ? 'AUTHORITY_REQUIRED' : 'ERROR', code: r?.code ?? 'SERVICE_UNAVAILABLE', reason: r?.reason ?? 'Authority unavailable', ...(r?.next_action ? { next_action: r.next_action } : {}), ...(r?.required_scope && isAScope(r.required_scope) ? { required_scope: fromAScope(r.required_scope) } : {}) };
  }
  private record(principal_id: string, action: string, resource: string | undefined, decision: AuditEvent['decision'], extra: Partial<AuditEvent> = {}) {
    this.observed.push({ event_id: `obs-${this.observed.length + 1}`, timestamp: new Date().toISOString(), principal_id, action, resource, decision, source: 'AGENTPASS', ...extra });
  }

  async connect(credential: string): Promise<ApiResult<WorkforceSession>> {
    const me = await this.call(credential, '/v1/me');
    if (me?.status !== 'OK') return { status: 'DENIED', code: 'INVALID_CALLER', reason: me?.reason ?? 'Unknown credential' };
    return { status: 'OK', data: this.session(credential, me.data.principal_id as string) };
  }

  /** Decisions this client observed (with B's action names and resources) plus AgentPass's own audit log when an owner credential is configured. */
  async audit(): Promise<AuditEvent[]> {
    const own = [...this.observed];
    if (!this.opts.ownerCredential) return own;
    const r = await this.call(this.opts.ownerCredential, '/v1/audit').catch(() => undefined);
    const remote: AuditEvent[] = r?.status === 'OK' && Array.isArray(r.data) ? r.data.map((e: any) => ({
      event_id: e.event_id, timestamp: e.timestamp, principal_id: e.principal_id, grant_id: e.grant_id ?? undefined, action: e.action,
      decision: (['ALLOW', 'DENY', 'AUTHORITY_REQUIRED', 'ISSUED', 'REVOKED', 'REQUESTED', 'COUNTEROFFERED', 'ACCEPTED', 'REJECTED'].includes(e.decision) ? e.decision : 'DENY') as AuditEvent['decision'],
      reason_code: e.reason_code ?? undefined, request_id: e.request_id ?? undefined, source: 'AGENTPASS' as const,
    })) : [];
    return [...own, ...remote];
  }

  private session(credential: string, principal_id: string): RealSession {
    const self = this;
    const call = (path: string, body?: unknown) => self.call(credential, path, body);
    const toA = (scope: WorkforceScope) => toAScope(scope, self.opts.identity, { max_executions: self.opts.defaultMaxExecutions ?? 40 });
    const resourceId = self.opts.identity.resource ?? DEMO_RESOURCE;

    async function decide(path: string, input: WorkforceActionInput, bAction: WorkforceAction, bResource: string): Promise<{ decision?: WorkforceDecision; error?: ApiError }> {
      const raw = await call(path, input);
      const parsed = workforceDecisionSchema.safeParse(raw);
      if (parsed.success) {
        const d = parsed.data;
        const error = mapDecision(d);
        self.record(principal_id, bAction, bResource, d.status === 'ALLOW' ? 'ALLOW' : error?.status === 'AUTHORITY_REQUIRED' ? 'AUTHORITY_REQUIRED' : 'DENY', { grant_id: input.grant_id, reason_code: error?.code, request_id: d.execution_id ?? d.request_id });
        return { decision: d, error };
      }
      const error: ApiError = { status: raw?.status === 'AUTHORITY_REQUIRED' ? 'AUTHORITY_REQUIRED' : raw?.status === 'ERROR' ? 'ERROR' : 'DENIED', code: raw?.code ?? 'INVALID_REQUEST', reason: raw?.reason ?? 'Authority rejected the action' };
      self.record(principal_id, bAction, bResource, 'DENY', { grant_id: input.grant_id, reason_code: error.code });
      return { error };
    }

    /** B's resource string -> A's action parameters. */
    function parameters(action: WorkforceAction, resource: string, extra: Record<string, unknown>): Record<string, unknown> {
      switch (action) {
        case 'repo.read': return { path: resource };
        case 'repo.write': return { path: resource, content: String(extra.content ?? '') };
        case 'security.audit.run': return { paths: (extra.paths as string[]) ?? [resource] };
        case 'deploy.preview': return { environment: 'preview', artifact_digest: String(extra.artifact_digest ?? '') };
        case 'deploy.production': return { environment: 'production', artifact_digest: String(extra.artifact_digest ?? '') };
        case 'analytics.aggregate': return { metric: resource };
        case 'analytics.raw': return {};
        default: return {};
      }
    }
    const aInput = (grant_id: string, action: WorkforceAction, resource: string, extra: Record<string, unknown>, idempotency_key: string): WorkforceActionInput | undefined => {
      const a = TO_A[action];
      if (!a) return undefined;
      return { grant_id, action: a, resource: resourceId, parameters: parameters(action, resource, extra), idempotency_key } as WorkforceActionInput;
    };

    return {
      principal_id,
      me: async () => self.envelope(await call('/v1/me'), (d) => ({ principal_id: d.principal_id, organization_id: d.organization_id, grants: (d.grants ?? []).filter((g: any) => isAScope(g.scope)).map(mapGrant) })),
      delegate: async ({ parent_grant_id, recipient_principal_id, scope }) => {
        const r = self.envelope(await call(`/v1/grants/${encodeURIComponent(parent_grant_id)}/delegate`, { recipient_principal_id, scope: toA(scope) }), mapGrant);
        self.record(principal_id, 'grant.delegate', recipient_principal_id, r.status === 'OK' ? 'ISSUED' : 'DENY', { grant_id: r.status === 'OK' ? r.data.id : parent_grant_id, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
      requestAuthority: async ({ parent_grant_id, requested_scope, reason }) => {
        const r = self.envelope(await call('/v1/authority/requests', { parent_grant_id, requested_scope: toA({ ...requested_scope, max_executions: requested_scope.max_executions ?? 5 }), reason }), (d) => ({ request_id: d.request_id as string, status: (d.status ?? 'PENDING') as WorkforceRequest['status'] }));
        self.record(principal_id, 'authority.request', undefined, r.status === 'OK' ? 'REQUESTED' : 'DENY', { grant_id: parent_grant_id, request_id: r.status === 'OK' ? r.data.request_id : undefined, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
      getRequest: async (request_id) => self.envelope(await call(`/v1/authority/requests/${encodeURIComponent(request_id)}`), mapRequest),
      respond: async ({ request_id, decision, offered_scope }) => {
        const body = decision === 'COUNTEROFFER' ? { decision, offered_scope: offered_scope ? toA({ ...offered_scope, max_executions: offered_scope.max_executions ?? 5 }) : undefined } : { decision };
        const r = self.envelope(await call(`/v1/authority/requests/${encodeURIComponent(request_id)}/respond`, body), mapRequest);
        self.record(principal_id, 'authority.respond', undefined, r.status === 'OK' ? (decision === 'COUNTEROFFER' ? 'COUNTEROFFERED' : 'REJECTED') : 'DENY', { request_id, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
      accept: async ({ request_id, idempotency_key }) => {
        const r = self.envelope(await call(`/v1/authority/requests/${encodeURIComponent(request_id)}/accept`, { idempotency_key }), mapGrant);
        self.record(principal_id, 'authority.accept', undefined, r.status === 'OK' ? 'ACCEPTED' : 'DENY', { request_id, grant_id: r.status === 'OK' ? r.data.id : undefined, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
      /** Advisory: AgentPass's verify. A positive answer is not a reusable credential; side effects go through execute(). */
      authorize: async ({ grant_id, action, resource }) => {
        const input = aInput(grant_id, action, resource, { artifact_digest: '0'.repeat(64), paths: [resource] }, `verify-${Date.now()}`);
        if (!input) { self.record(principal_id, action, resource, 'DENY', { grant_id, reason_code: 'INSUFFICIENT_SCOPE' }); return { status: 'DENIED', code: 'INSUFFICIENT_SCOPE', reason: `${action} is not an AgentPass workforce action` }; }
        const { decision, error } = await decide('/v1/actions/verify', input, action, resource);
        if (error) return error;
        const auth: Authorization = { authorization_id: decision!.execution_id ?? `verify-${grant_id}-${action}`, grant_id, principal_id, action, resource, chain: [] };
        return { status: 'OK', data: auth };
      },
      execute: async ({ grant_id, action, resource, parameters: extra, idempotency_key }) => {
        const input = aInput(grant_id, action, resource, extra, idempotency_key);
        if (!input) return { status: 'DENIED', code: 'INSUFFICIENT_SCOPE', reason: `${action} is not an AgentPass workforce action` };
        const { decision, error } = await decide('/v1/actions/execute', input, action, resource);
        if (error) return error;
        return { status: 'OK', data: { execution_id: decision!.execution_id ?? '', result: decision!.result ?? {} } };
      },
      revoke: async ({ grant_id, reason }) => {
        const r = self.envelope(await call(`/v1/grants/${encodeURIComponent(grant_id)}/revoke`, { reason }), (d) => ({ grant_id: d.grant_id as string, revoked_at: d.revoked_at as string }));
        self.record(principal_id, 'grant.revoke', undefined, r.status === 'OK' ? 'REVOKED' : 'DENY', { grant_id, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
      provisionChild: async ({ parent_grant_id, scope, credential_hash, idempotency_key }) => {
        const r = self.envelope(await call(`/v1/grants/${encodeURIComponent(parent_grant_id)}/provision-child`, { scope: toA(scope), credential_hash, idempotency_key }), (d) => ({ principal: { id: d.principal.id as string }, grant: mapGrant(d.grant) }));
        self.record(principal_id, 'principal.provision', undefined, r.status === 'OK' ? 'ISSUED' : 'DENY', { grant_id: r.status === 'OK' ? r.data.grant.id : parent_grant_id, reason_code: r.status === 'OK' ? undefined : r.code });
        return r;
      },
    };
  }
}
