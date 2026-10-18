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
import type { WorkforceAuthority, WorkforceGrant, WorkforceScope, WorkforceSession } from './contract.js';
import { isError, type AgentContext, type Trace } from './agent-base.js';
import { runHostingAgent, type HostingResult } from './agents/hosting.js';
import type { AnalyticsGateway } from './gateways/analytics.js';
import type { DeployGateway } from './gateways/deploy.js';
import type { RepoGateway } from './gateways/repo.js';

export interface Credentials { lead: string; design: string; security: string; hosting: string; analytics: string }

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

export async function runWorkflow(input: {
  authority: WorkforceAuthority;
  credentials: Credentials;
  rootGrantId: string;
  gateways: { repo: RepoGateway; deploy: DeployGateway; analytics: AnalyticsGateway };
  specialists: Specialists;
  trace?: Trace;
}): Promise<WorkflowResult> {
  const { authority, credentials, gateways } = input;
  const events: WorkflowEvent[] = [];
  const emit = (kind: WorkflowEvent['kind'], agent: string, text: string, code?: string) => { events.push({ at: new Date().toISOString(), kind, agent, text, code }); };
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

  async function spawn(name: 'design' | 'security' | 'hosting' | 'analytics', cred: string, scope: Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>, external = false) {
    const agent = `${name}-agent`;
    sessions[name] = await open(cred);
    emit(external ? 'external_contacted' : 'subagent_created', agent, external ? `Contacted external ${agent} (${(await sessions[name]!.me() as any).data?.organization_id}); it authenticates with its own credential` : `Started ${agent} with its own identity`);
    const g = await lead.delegate({ parent_grant_id: input.rootGrantId, recipient_principal_id: agent, scope: { ...scope, expires_at: later(30), max_delegation_depth: 0 } });
    if (isError(g)) throw new Error(`delegate to ${agent} failed: ${g.code} ${g.reason}`);
    grants[name] = g.data;
    emit('authority_delegated', 'lead-agent', `Delegated to ${agent}: ${scope.actions.join(', ')} on ${scope.resources.join(', ')}`);
    return { name: agent, session: sessions[name]!, grant_id: g.data.id, gateways, trace } satisfies AgentContext;
  }

  const result: WorkflowResult = { authority_source: authority.source, events, grants, revoked: [], reuse_after_revoke: [] };
  emit('note', 'lead-agent', `Task received: build a polished landing page; improve design, audit security, deploy a preview, analyze signups. Authority: ${authority.source}.`);

  // 1. Design
  const design = await spawn('design', credentials.design, { actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'] });
  if (input.specialists.design) result.design = await input.specialists.design(design);

  // 2. Security (external company; read-only)
  const security = await spawn('security', credentials.security, { actions: ['repo.read'], resources: ['src/**', 'package.json'] }, true);
  if (input.specialists.security) {
    result.security = await input.specialists.security(security);
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
    result.analytics = await input.specialists.analytics(analytics);
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
  return result;
}
