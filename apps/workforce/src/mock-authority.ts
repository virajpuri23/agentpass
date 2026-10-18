/**
 * MOCK authority for the workforce demo. Stand-in for Developer A's generic
 * action authority until docs/11-WORKFORCE-CONTRACT.md ships. It enforces the
 * rules the real service will (identity from credential, subset-only
 * delegation, live chain checks, revocation, structured recoverable
 * denials) in memory, and stamps every event `source: 'MOCK'`.
 *
 * Demo policy baked in: `deploy.production` is never delegated below the
 * owner, and a refused production deploy points at `deploy.preview`.
 */
import { randomUUID } from 'node:crypto';
import type {
  ApiError, ApiResult, AuditEvent, Authorization, ErrorCode, WorkforceAction, WorkforceAuthority,
  WorkforceGrant, WorkforceRequest, WorkforceScope, WorkforceSession,
} from './contract.js';
import { hasAction, isSubset, resourceAllowed } from './scope.js';

export interface MockPrincipal { id: string; organization_id: string; credential: string }

class Denial extends Error {
  constructor(readonly result: ApiError) { super(result.reason); }
}
const deny = (code: ErrorCode, reason: string, status: ApiError['status'] = 'DENIED'): never => {
  throw new Denial({ status, code, reason, ...(status === 'DENIED' ? { next_action: 'contact_owner' } : {}) });
};

export class MockWorkforceAuthority implements WorkforceAuthority {
  readonly source = 'MOCK' as const;
  private principals = new Map<string, MockPrincipal>(); // by credential
  private grants = new Map<string, WorkforceGrant>();
  private requests = new Map<string, WorkforceRequest>();
  private accepted = new Map<string, string>(); // idempotency key -> grant id
  private events: AuditEvent[] = [];
  constructor(private now: () => Date = () => new Date()) {}

  // ---- seeding (owner/admin side; not exposed to agents) ----
  addPrincipal(p: MockPrincipal) { this.principals.set(p.credential, p); return p; }
  issueRoot(input: { id?: string; issuer: string; subject: string; organization_id: string; scope: WorkforceScope }): WorkforceGrant {
    const g: WorkforceGrant = { id: input.id ?? `grant-${randomUUID()}`, issuer_principal_id: input.issuer, subject_principal_id: input.subject, parent_grant_id: null, organization_id: input.organization_id, scope: input.scope, revoked_at: null };
    this.grants.set(g.id, g);
    this.record(input.issuer, 'grant.issue', 'ISSUED', { grant_id: g.id });
    return g;
  }
  async audit() { return [...this.events]; }

  async connect(credential: string): Promise<ApiResult<WorkforceSession>> {
    const p = this.principals.get(credential);
    if (!p) return { status: 'DENIED', code: 'INVALID_CALLER', reason: 'Unknown credential' };
    return { status: 'OK', data: this.session(p) };
  }

  // ---- internals ----
  private record(principal_id: string, action: string, decision: AuditEvent['decision'], extra: Partial<AuditEvent> = {}) {
    this.events.push({ event_id: randomUUID(), timestamp: this.now().toISOString(), principal_id, action, decision, source: 'MOCK', ...extra });
  }
  private principalById(id: string) {
    for (const p of this.principals.values()) if (p.id === id) return p;
    return undefined;
  }
  private grant(id: string): WorkforceGrant {
    const g = this.grants.get(id);
    if (!g) deny('INVALID_REQUEST', `Unknown grant ${id}`);
    return g!;
  }
  /** Live chain, root first; every link must be unrevoked, unexpired and held by the stated subject. */
  private chain(grantId: string, subject?: string): WorkforceGrant[] {
    const out: WorkforceGrant[] = [];
    let g: WorkforceGrant | undefined = this.grant(grantId);
    if (subject && g.subject_principal_id !== subject) deny('INVALID_CALLER', 'Grant is not held by the caller');
    while (g) {
      if (g.revoked_at) deny('GRANT_REVOKED', `Grant ${g.id} was revoked`);
      if (Date.parse(g.scope.expires_at) <= this.now().getTime()) deny('GRANT_EXPIRED', `Grant ${g.id} has expired`);
      out.unshift(g);
      g = g.parent_grant_id ? this.grant(g.parent_grant_id) : undefined;
    }
    return out;
  }
  private issue(issuer: MockPrincipal, parent: WorkforceGrant, recipient: string, scope: WorkforceScope): WorkforceGrant {
    const sub = isSubset(scope, parent.scope);
    if (!sub.ok) deny('OUTSIDE_PARENT_SCOPE', sub.why);
    if (scope.actions.includes('deploy.production')) deny('OUTSIDE_PARENT_SCOPE', 'deploy.production is never delegated below the owner');
    if (!this.principalById(recipient)) deny('INVALID_REQUEST', `Unknown recipient ${recipient}`);
    const g: WorkforceGrant = { id: `grant-${randomUUID()}`, issuer_principal_id: issuer.id, subject_principal_id: recipient, parent_grant_id: parent.id, organization_id: parent.organization_id, scope, revoked_at: null };
    this.grants.set(g.id, g);
    this.record(issuer.id, 'grant.issue', 'ISSUED', { grant_id: g.id });
    return g;
  }
  private wrap<T>(fn: () => T): ApiResult<T> {
    try { return { status: 'OK', data: fn() }; }
    catch (e) { if (e instanceof Denial) return e.result; throw e; }
  }

  private session(p: MockPrincipal): WorkforceSession {
    const self = this;
    const wrap = <T>(fn: () => T) => Promise.resolve(self.wrap(fn));
    return {
      principal_id: p.id,
      me: () => wrap(() => ({ principal_id: p.id, organization_id: p.organization_id, grants: [...self.grants.values()].filter((g) => g.subject_principal_id === p.id) })),

      delegate: ({ parent_grant_id, recipient_principal_id, scope }) => wrap(() => {
        self.chain(parent_grant_id, p.id); // must be live and held by the caller
        return structuredClone(self.issue(p, self.grant(parent_grant_id), recipient_principal_id, scope));
      }),

      requestAuthority: ({ parent_grant_id, requested_scope, reason }) => wrap(() => {
        const parent = self.grant(parent_grant_id);
        self.chain(parent_grant_id, parent.subject_principal_id);
        if (parent.subject_principal_id === p.id) deny('INVALID_CALLER', 'Cannot request authority from your own grant');
        const isChild = [...self.grants.values()].some((g) => g.subject_principal_id === p.id && g.parent_grant_id === parent_grant_id && !g.revoked_at);
        if (!isChild || parent.organization_id !== p.organization_id) deny('INVALID_CALLER', 'Only an existing delegated child may request authority');
        const r: WorkforceRequest = { id: `req-${randomUUID()}`, requester_principal_id: p.id, parent_grant_id, requested_scope, reason, status: 'PENDING' };
        self.requests.set(r.id, r);
        self.record(p.id, 'authority.request', 'REQUESTED', { grant_id: parent_grant_id, request_id: r.id });
        return { request_id: r.id, status: r.status };
      }),

      getRequest: (request_id) => wrap(() => {
        const r = self.requests.get(request_id);
        if (!r) deny('INVALID_REQUEST', 'Unknown request');
        const parent = self.grant(r!.parent_grant_id);
        if (![r!.requester_principal_id, parent.subject_principal_id].includes(p.id)) deny('INVALID_CALLER', 'Request is private to its parties');
        return structuredClone(r!);
      }),

      respond: ({ request_id, decision, offered_scope }) => wrap(() => {
        const r = self.requests.get(request_id);
        if (!r) deny('INVALID_REQUEST', 'Unknown request');
        const parent = self.chain(r!.parent_grant_id, p.id).at(-1)!;
        if (r!.requester_principal_id === p.id) deny('INVALID_CALLER', 'Requester cannot approve its own request');
        if (r!.status !== 'PENDING') deny('INVALID_REQUEST', 'Request is no longer pending');
        if (decision === 'COUNTEROFFER') {
          if (!offered_scope) deny('INVALID_REQUEST', 'Counteroffer requires offered_scope');
          const sub = isSubset(offered_scope!, parent.scope);
          if (!sub.ok) deny('OUTSIDE_PARENT_SCOPE', sub.why);
          const within = isSubset(offered_scope!, { ...r!.requested_scope, max_delegation_depth: r!.requested_scope.max_delegation_depth + 1 });
          if (!within.ok) deny('OUTSIDE_PARENT_SCOPE', `offer exceeds the request: ${within.why}`);
          if (offered_scope!.actions.includes('deploy.production')) deny('OUTSIDE_PARENT_SCOPE', 'deploy.production is never delegated below the owner');
          r!.offered_scope = offered_scope; r!.status = 'COUNTEROFFERED';
        } else { r!.status = 'REJECTED'; }
        self.record(p.id, 'authority.respond', r!.status, { grant_id: r!.parent_grant_id, request_id });
        return structuredClone(r!);
      }),

      accept: ({ request_id, idempotency_key }) => wrap(() => {
        const prior = self.accepted.get(`${p.id}:${idempotency_key}`);
        if (prior) return structuredClone(self.grant(prior));
        const r = self.requests.get(request_id);
        if (!r) deny('INVALID_REQUEST', 'Unknown request');
        if (r!.requester_principal_id !== p.id) deny('INVALID_CALLER', 'Only the requester can accept');
        if (r!.status !== 'COUNTEROFFERED' || !r!.offered_scope) deny('INVALID_REQUEST', 'No counteroffer to accept');
        const parent = self.grant(r!.parent_grant_id);
        self.chain(parent.id, parent.subject_principal_id); // still live?
        const g = self.issue(self.principalById(parent.subject_principal_id)!, parent, p.id, r!.offered_scope!);
        r!.status = 'ACCEPTED'; r!.issued_grant_id = g.id;
        self.accepted.set(`${p.id}:${idempotency_key}`, g.id);
        self.record(p.id, 'authority.accept', 'ACCEPTED', { grant_id: g.id, request_id });
        return structuredClone(g);
      }),

      authorize: ({ grant_id, action, resource }) => wrap(() => {
        let chain: WorkforceGrant[];
        try { chain = self.chain(grant_id, p.id); }
        catch (e) { if (e instanceof Denial) self.record(p.id, action, 'DENY', { grant_id, resource, reason_code: e.result.code }); throw e; }
        const leaf = chain[chain.length - 1]!;
        if (!chain.every((g) => hasAction(g.scope, action))) {
          const required: WorkforceScope = { actions: [action], resources: [resource], expires_at: leaf.scope.expires_at, max_delegation_depth: 0 };
          const alt = action === 'deploy.production'
            ? { actions: ['deploy.preview' as const], resources: ['preview'], expires_at: leaf.scope.expires_at, max_delegation_depth: 0 }
            : undefined;
          self.record(p.id, action, 'AUTHORITY_REQUIRED', { grant_id, resource, reason_code: 'INSUFFICIENT_SCOPE' });
          throw new Denial({
            status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE',
            reason: alt ? `${action} is not delegated to this agent; ${alt.actions[0]} may be requested instead` : `Grant does not include ${action}`,
            next_action: 'request_authority', required_scope: required, ...(alt ? { alternative_scope: alt } : {}),
          });
        }
        if (!chain.every((g) => resourceAllowed(g.scope, resource))) {
          self.record(p.id, action, 'DENY', { grant_id, resource, reason_code: 'RESOURCE_DENIED' });
          deny('RESOURCE_DENIED', `${resource} is outside this grant's allowed resources`);
        }
        const a: Authorization = { authorization_id: randomUUID(), grant_id, principal_id: p.id, action, resource, chain: chain.map((g) => g.id) };
        self.record(p.id, action, 'ALLOW', { grant_id, resource });
        return a;
      }),

      revoke: ({ grant_id, reason }) => wrap(() => {
        const g = self.grant(grant_id);
        if (g.issuer_principal_id !== p.id && g.subject_principal_id !== p.id) deny('INVALID_CALLER', 'Only the issuer may revoke');
        g.revoked_at = g.revoked_at ?? self.now().toISOString();
        self.record(p.id, 'grant.revoke', 'REVOKED', { grant_id });
        void reason;
        return { grant_id, revoked_at: g.revoked_at };
      }),
    };
  }
}
