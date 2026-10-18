/**
 * Lead coding agent (parent orchestrator).
 *
 * Receives the landing-page task and coordinates four specialists, each with
 * its OWN session and a grant that covers only its job. The lead never shares
 * its credential; it delegates subsets of its root grant, answers the hosting
 * agent's negotiation with a narrower counteroffer, collects results, applies
 * the security fix itself (the only writer allowed on src/lib), and revokes
 * every temporary grant when the work is done.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WorkforceAuthority, WorkforceGrant, WorkforceScope, WorkforceSession } from './contract.js';
import { isError, type AgentContext, type Trace } from './agent-base.js';
import { runHostingAgent, type HostingResult } from './agents/hosting.js';
import type { AnalyticsGateway } from './gateways/analytics.js';
import type { DeployGateway } from './gateways/deploy.js';
import type { RepoGateway } from './gateways/repo.js';

/** The lead's and the external security agent's credentials are provisioned by administrators; a missing
 *  specialist credential means the lead creates that specialist itself (AgentPass provision_child). */
export interface Credentials { lead: string; security?: string; design?: string; hosting?: string; analytics?: string }

/**
 * The external Security agent running as its own process (apps/workforce/src/security-service.ts).
 * The lead holds only this per-task token and the service's address, never the auditor's credential;
 * `authority_url` tells the service which AgentPass to use its own credential against.
 */
export interface SecurityServiceClient { url: string; token: string; authority_url: string }

export interface WorkflowEvent {
  at: string;
  kind: 'subagent_created' | 'authority_delegated' | 'external_contacted' | 'permission_denied' | 'narrower_requested'
    | 'permission_granted' | 'deployment_completed' | 'analytics_analyzed' | 'fix_applied' | 'authority_revoked' | 'note';
  agent: string;
  text: string;
  code?: string;
}

export interface WorkflowResult {
  authority_source: 'MOCK' | 'AGENTPASS';
  events: WorkflowEvent[];
  design?: unknown;
  security?: unknown;
  hosting?: HostingResult;
  analytics?: unknown;
  fix?: { file: string; applied: boolean };
  grants: Record<string, WorkforceGrant>;
  revoked: string[];
  /** Reusing a revoked grant must fail; recorded here as proof. */
  reuse_after_revoke: { agent: string; code: string }[];
}

export interface Specialists {
  design?: (ctx: AgentContext) => Promise<unknown>;
  security?: (ctx: AgentContext) => Promise<unknown>;
  analytics?: (ctx: AgentContext) => Promise<unknown>;
}

const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

/** Specialists may return a bare result or an ApiResult envelope (failing closed); unwrap the latter. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'status' in value) {
    const r = value as { status: string; data?: unknown };
    return r.status === 'OK' ? r.data : value; // keep a denial envelope as-is so it is visible in the result
  }
  return value;
}

export async function runWorkflow(input: {
  authority: WorkforceAuthority;
  credentials: Credentials;
  rootGrantId: string;
  gateways: { repo: RepoGateway; deploy: DeployGateway; analytics: AnalyticsGateway };
  specialists: Specialists;
  /** When present, the Security agent is contacted over HTTP instead of running in this process. */
  securityService?: SecurityServiceClient;
  trace?: Trace;
  /** Live timeline: called for every WorkflowEvent as it is recorded. */
  onEvent?: (event: WorkflowEvent) => void;
}): Promise<WorkflowResult> {
  const { authority, credentials, gateways } = input;
  const events: WorkflowEvent[] = [];
  const emit = (kind: WorkflowEvent['kind'], agent: string, text: string, code?: string) => {
    const event: WorkflowEvent = { at: new Date().toISOString(), kind, agent, text, code };
    events.push(event);
    input.onEvent?.(event);
  };
  const trace: Trace = (l) => {
    input.trace?.(l);
    if (l.kind === 'denied') emit('permission_denied', l.agent, l.text, l.code);
  };

  const open = async (cred: string): Promise<WorkforceSession> => {
    const s = await authority.connect(cred);
    if (isError(s)) throw new Error(`connect failed: ${s.code}`);
    return s.data;
  };
  const lead = await open(credentials.lead);
  const grants: Record<string, WorkforceGrant> = {};
  const sessions: Record<string, WorkforceSession> = {};

  type TaskScope = Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>;
  const fullScope = (scope: TaskScope): WorkforceScope => ({ ...scope, expires_at: later(30), max_delegation_depth: 0, max_executions: 40 });
  async function spawn(name: 'design' | 'security' | 'hosting' | 'analytics', cred: string | undefined, scope: TaskScope, external = false) {
    const agent = `${name}-agent`;
    const full = fullScope(scope);
    if (external && !cred) throw new Error(`${agent} is an external principal: it needs its registered credential or a security service`);
    if (cred) {
      // A registered principal (seeded by an administrator, or an external company's agent): delegate to it.
      sessions[name] = await open(cred);
      emit(external ? 'external_contacted' : 'subagent_created', agent, external ? `Contacted external ${agent} (${(await sessions[name]!.me() as any).data?.organization_id}); it authenticates with its own credential` : `Started ${agent} with its own identity`);
      const g = await lead.delegate({ parent_grant_id: input.rootGrantId, recipient_principal_id: sessions[name]!.principal_id, scope: full });
      if (isError(g)) throw new Error(`delegate to ${agent} failed: ${g.code} ${g.reason}`);
      grants[name] = g.data;
      emit('authority_delegated', 'lead-agent', `Delegated to ${agent}: ${scope.actions.join(', ')} on ${scope.resources.join(', ')}`);
    } else {
      // No credential exists yet: the lead provisions a brand-new principal. The secret is generated here,
      // only its SHA-256 goes to AgentPass, and the specialist's session is opened with that secret.
      const provision = (lead as { provisionChild?: (i: unknown) => Promise<unknown> }).provisionChild;
      if (!provision) throw new Error(`no credential for ${agent} and the authority cannot provision children`);
      const secret = randomBytes(32).toString('base64url');
      const made = await (provision.call(lead, { parent_grant_id: input.rootGrantId, scope: full, credential_hash: createHash('sha256').update(secret).digest('hex'), idempotency_key: `spawn-${name}-${randomUUID()}` }) as Promise<any>);
      if (isError(made)) throw new Error(`provision ${agent} failed: ${made.code} ${made.reason}`);
      grants[name] = made.data.grant;
      sessions[name] = await open(secret);
      emit('subagent_created', agent, `Provisioned ${agent} as ${made.data.principal.id} with its own credential (only its hash was sent)`);
      emit('authority_delegated', 'lead-agent', `Delegated to ${agent}: ${scope.actions.join(', ')} on ${scope.resources.join(', ')}`);
    }
    return { name: agent, session: sessions[name]!, grant_id: grants[name]!.id, gateways, trace } satisfies AgentContext;
  }

  const result: WorkflowResult = { authority_source: authority.source, events, grants, revoked: [], reuse_after_revoke: [] };
  emit('note', 'lead-agent', `Task received: build a polished landing page; improve design, audit security, deploy a preview, analyze signups. Authority: ${authority.source}.`);

  // 1. Design
  const design = await spawn('design', credentials.design, { actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'] });
  if (input.specialists.design) result.design = unwrap(await input.specialists.design(design));

  // 2. Security (external company; read-only). Either a separate process reached over HTTP, or in-process with its own session.
  const securityScope: TaskScope = { actions: ['repo.read'], resources: ['src/**', 'package.json'] };
  let probeSecurity: (() => Promise<{ status: string; code?: string } | undefined>) | undefined;
  if (input.securityService) {
    const svc = input.securityService;
    const remote = async (path: string, body: Record<string, unknown>): Promise<any> => {
      const res = await fetch(new URL(path, svc.url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { 'content-type': 'application/json', 'x-task-token': svc.token }, body: JSON.stringify(body) });
      try { return await res.json(); } catch { return { status: 'ERROR', code: 'SERVICE_UNAVAILABLE', reason: `HTTP ${res.status}` }; }
    };
    const who = await remote('/identify', { authority_url: svc.authority_url });
    if (who.status !== 'OK') throw new Error(`security service identify failed: ${who.code} ${who.reason ?? ''}`);
    emit('external_contacted', 'security-agent', `Contacted external security-agent (${who.data.organization_id}) at ${svc.url}: a separate process that authenticates to AgentPass with its own credential; this process never holds it`);
    const g = await lead.delegate({ parent_grant_id: input.rootGrantId, recipient_principal_id: who.data.principal_id, scope: fullScope(securityScope) });
    if (isError(g)) throw new Error(`delegate to security-agent failed: ${g.code} ${g.reason}`);
    grants.security = g.data;
    emit('authority_delegated', 'lead-agent', `Delegated to security-agent: ${securityScope.actions.join(', ')} on ${securityScope.resources.join(', ')}`);
    const audit = await remote('/audit', { grant_id: g.data.id, authority_url: svc.authority_url });
    if (audit.status === 'OK') { for (const line of audit.data.trace ?? []) trace(line); result.security = audit.data.report; }
    else result.security = audit; // keep the refusal envelope visible in the result
    probeSecurity = async () => {
      const r = await remote('/probe', { grant_id: g.data.id, authority_url: svc.authority_url, action: 'repo.read', resource: 'src/x' });
      return r.status === 'OK' ? r.data : { status: 'ERROR', code: r.code ?? 'SERVICE_UNAVAILABLE' };
    };
  } else {
    const security = await spawn('security', credentials.security, securityScope, true);
    if (input.specialists.security) result.security = unwrap(await input.specialists.security(security));
  }
  if (result.security) {
    // The lead applies the fix itself: it is the only principal allowed to write src/lib.
    const report = result.security as { findings?: { file: string; rule: string }[] } | undefined;
    const xss = report?.findings?.find((f) => f.file === 'src/lib/newsletter.ts');
    if (xss) {
      const file = await gateways.repo.read(lead, input.rootGrantId, 'src/lib/newsletter.ts');
      if (!isError(file) && file.data.content.includes("'<strong>Thanks, ' + name + '!</strong>")) {
        const fixed = file.data.content.replace("'<strong>Thanks, ' + name + '!</strong>", "'<strong>Thanks, ' + escapeHtml(name) + '!</strong>");
        const w = await gateways.repo.write(lead, input.rootGrantId, 'src/lib/newsletter.ts', fixed);
        result.fix = { file: 'src/lib/newsletter.ts', applied: !isError(w) };
        emit('fix_applied', 'lead-agent', `Applied the security fix from the report: escapeHtml(name) in src/lib/newsletter.ts`);
      }
    }
  }

  // 3. Hosting: production will be refused; the lead answers the preview request.
  const hosting = await spawn('hosting', credentials.hosting, { actions: ['repo.read'], resources: ['src/**', 'package.json'] });
  result.hosting = await runHostingAgent(hosting, {
    parent_grant_id: input.rootGrantId,
    notifyParent: async (request_id) => {
      const req = await lead.getRequest(request_id);
      if (isError(req)) return;
      emit('narrower_requested', 'hosting-agent', `Requested ${req.data.requested_scope.actions.join(', ')}: "${req.data.reason}"`);
      // Policy: preview is fine, anything else is not. Offer exactly what was asked, shorter-lived.
      const okToGrant = req.data.requested_scope.actions.every((a) => a === 'deploy.preview');
      if (!okToGrant) { await lead.respond({ request_id, decision: 'REJECT' }); return; }
      const offered: WorkforceScope = { ...req.data.requested_scope, expires_at: later(15) };
      const r = await lead.respond({ request_id, decision: 'COUNTEROFFER', offered_scope: offered });
      if (!isError(r)) emit('permission_granted', 'lead-agent', `Counteroffered deploy.preview on preview, valid 15 minutes`);
    },
  });
  if (result.hosting.negotiation?.issued_grant_id) {
    grants['hosting-preview'] = { ...grants.hosting!, id: result.hosting.negotiation.issued_grant_id, scope: result.hosting.negotiation.offered! };
  }
  if (result.hosting.deployment) emit('deployment_completed', 'hosting-agent', `Preview live at ${result.hosting.deployment.url} (${result.hosting.deployment.provider})`);

  // 4. Analytics
  const analytics = await spawn('analytics', credentials.analytics, { actions: ['analytics.aggregate'], resources: ['landing-page'] });
  if (input.specialists.analytics) {
    result.analytics = unwrap(await input.specialists.analytics(analytics));
    emit('analytics_analyzed', 'analytics-agent', 'Computed aggregate metrics from the dataset (no raw rows)');
  }

  // 5. Revoke everything temporary, then prove reuse fails.
  for (const [name, g] of Object.entries(grants)) {
    const r = await lead.revoke({ grant_id: g.id, reason: 'task complete' });
    if (!isError(r)) { result.revoked.push(g.id); emit('authority_revoked', 'lead-agent', `Revoked ${name}'s grant ${g.id}`); }
  }
  for (const [name, s] of Object.entries(sessions)) {
    const g = grants[name]!;
    const probe = await s.authorize({ grant_id: g.id, action: g.scope.actions[0]!, resource: g.scope.resources[0]!.replace('**', 'x') });
    if (isError(probe)) result.reuse_after_revoke.push({ agent: `${name}-agent`, code: probe.code });
  }
  if (probeSecurity) {
    const probe = await probeSecurity();
    if (probe && probe.status !== 'OK') result.reuse_after_revoke.push({ agent: 'security-agent', code: probe.code ?? 'SERVICE_UNAVAILABLE' });
  }
  return result;
}
