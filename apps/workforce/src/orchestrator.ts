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
import { hasWallet, usd, type Receipt, type SpendScope, type WalletGrant, type WalletSession } from './wallet.js';

/**
 * Money for the task. The owner gave the manager one root wallet; the manager hands each in-house
 * helper a smaller wallet for the one thing it buys, keeps the rest, and pays the outside security
 * firm's invoice itself (AgentPass never lets a wallet leave the organization). Amounts in cents.
 */
export interface BudgetPlan {
  rootWalletId: string;
  vendor_id: string;
  wallets: { design: number; hosting: number; analytics: number };
  /** Top-up policy: the manager never tops a wallet up beyond this share of its original size. */
  topup_cap_ratio: number;
}
export const DEFAULT_BUDGET_PLAN: Omit<BudgetPlan, 'rootWalletId'> = { vendor_id: 'service-vendor', wallets: { design: 15000, hosting: 10000, analytics: 5000 }, topup_cap_ratio: 1.2 };

export interface LedgerLine { agent: string; sku_id: string; quantity: number; amount_cents: number; grant_id: string; receipt_id: string }
export interface TopUp { agent: string; request_id: string; requested_cents: number; sku_ids: string[]; reason: string; decision: 'COUNTEROFFER' | 'REJECT'; offered_cents?: number; issued_grant_id?: string; manager_reason: string }
export interface BudgetResult {
  root_cents: number;
  wallet_cents: Record<string, number>;
  spent_cents: number;
  /** Remaining on the root wallet as AgentPass computes it from its ledger, read before revocation. */
  remaining_cents: number | null;
  ledger: LedgerLine[];
  /** Purchases AgentPass refused, with its code (BUDGET_EXCEEDED). */
  refused: { agent: string; sku_id: string; quantity: number; amount_cents: number; code: string }[];
  topups: TopUp[];
}

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
    | 'permission_granted' | 'deployment_completed' | 'analytics_analyzed' | 'fix_applied' | 'authority_revoked' | 'note'
    // money
    | 'wallet_delegated' | 'purchase_made' | 'budget_exceeded' | 'budget_requested' | 'budget_countered' | 'budget_rejected';
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
  /** Wallets by holder ('design', 'hosting', 'hosting-topup', 'analytics'); absent when the authority has no money (the mock). */
  wallets: Record<string, WalletGrant>;
  budget?: BudgetResult;
  /** Spending from a revoked wallet must fail too. */
  wallet_reuse_after_revoke: { agent: string; code: string }[];
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
  /** When present (and the authority has wallets), the helpers also buy what they need, within budget. */
  budget?: BudgetPlan;
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

  const wallets: Record<string, WalletGrant> = {};
  const result: WorkflowResult = { authority_source: authority.source, events, grants, revoked: [], reuse_after_revoke: [], wallets, wallet_reuse_after_revoke: [] };

  // ---- Money. Only when the authority has wallets (AgentPass does; the mock has none). ----
  const plan = input.budget && hasWallet(lead) ? input.budget : undefined;
  const leadWallet = lead as unknown as WalletSession;
  const budget: BudgetResult | undefined = plan ? { root_cents: 0, wallet_cents: {}, spent_cents: 0, remaining_cents: null, ledger: [], refused: [], topups: [] } : undefined;
  if (plan && budget) {
    const root = await leadWallet.balance(plan.rootWalletId);
    budget.root_cents = isError(root) ? 0 : root.data.remaining_cents ?? 0;
    result.budget = budget;
  }
  const walletOf = (name: string): WalletSession => sessions[name] as unknown as WalletSession;
  const spendScope = (cents: number, sku_ids: string[], minutes = 30): SpendScope => ({ vendor_id: plan!.vendor_id, sku_ids, total_budget_cents: cents, max_per_action_cents: cents, expires_at: later(minutes), max_delegation_depth: 0 });
  /** The manager hands a helper a wallet for the one thing it buys: a strict subset of the root wallet. */
  async function giveWallet(name: 'design' | 'hosting' | 'analytics', cents: number, sku_ids: string[]) {
    if (!plan || !budget) return;
    const w = await leadWallet.delegateWallet({ parent_grant_id: plan.rootWalletId, recipient_principal_id: sessions[name]!.principal_id, scope: spendScope(cents, sku_ids) });
    if (isError(w)) throw new Error(`wallet for ${name} failed: ${w.code} ${w.reason}`);
    wallets[name] = w.data; budget.wallet_cents[name] = cents;
    emit('wallet_delegated', 'lead-agent', `Gave ${name}-agent a ${usd(cents)} wallet for ${sku_ids.join(', ')} (of the ${usd(budget.root_cents)} root wallet)`);
  }
  /** A helper (or the manager) buys through AgentPass: quote, then the protected purchase. Refusals are part of the record. */
  async function buy(agent: string, session: WalletSession, grant_id: string, sku_id: string, quantity: number, why: string): Promise<Receipt | undefined> {
    if (!budget) return undefined;
    const q = await session.quote({ grant_id, sku_id, quantity, idempotency_key: `quote-${randomUUID()}` });
    if (isError(q)) { trace({ agent, kind: 'denied', text: `quote ${quantity} × ${sku_id} → ${q.status} ${q.code}: ${q.reason}`, code: q.code }); budget.refused.push({ agent, sku_id, quantity, amount_cents: 0, code: q.code }); return undefined; }
    trace({ agent, kind: 'call', text: `quote ${quantity} × ${sku_id}: ${usd(q.data.total_cents)} (${why})` });
    const r = await session.purchase({ grant_id, sku_id, quote_id: q.data.quote_id, idempotency_key: `buy-${randomUUID()}` });
    if (isError(r)) {
      trace({ agent, kind: 'denied', text: `buy ${quantity} × ${sku_id} for ${usd(q.data.total_cents)} → ${r.status} ${r.code}: ${r.reason}`, code: r.code });
      budget.refused.push({ agent, sku_id, quantity, amount_cents: q.data.total_cents, code: r.code });
      if (r.code === 'BUDGET_EXCEEDED') emit('budget_exceeded', agent, `AgentPass refused ${usd(q.data.total_cents)} for ${quantity} × ${sku_id}: over this wallet's budget`, r.code);
      return undefined;
    }
    budget.ledger.push({ agent, sku_id, quantity, amount_cents: r.data.amount_cents, grant_id, receipt_id: r.data.receipt_id });
    budget.spent_cents += r.data.amount_cents;
    emit('purchase_made', agent, `Bought ${quantity} × ${sku_id} for ${usd(r.data.amount_cents)} (${why}); receipt ${r.data.receipt_id}`);
    trace({ agent, kind: 'result', text: `bought ${quantity} × ${sku_id} for ${usd(r.data.amount_cents)}; order ${r.data.order_id}` });
    return r.data;
  }
  /**
   * A helper asks the manager for more money. The ask goes to AgentPass as a request under the root wallet;
   * the manager reads it and answers with a counteroffer (never more than its policy allows, never more
   * than the root wallet) or a rejection; the helper accepts, and the new wallet is a fresh grant.
   */
  async function askForMore(name: 'hosting' | 'analytics', cents: number, sku_ids: string[], reason: string): Promise<WalletGrant | undefined> {
    if (!plan || !budget) return undefined;
    const agent = `${name}-agent`;
    const session = walletOf(name);
    const asked = await session.requestBudget({ parent_grant_id: plan.rootWalletId, requested_scope: spendScope(cents, sku_ids, 15), reason });
    if (isError(asked)) { trace({ agent, kind: 'denied', text: `request ${usd(cents)} more → ${asked.status} ${asked.code}: ${asked.reason}`, code: asked.code }); return undefined; }
    emit('budget_requested', agent, `Asked the manager for ${usd(cents)} more (${sku_ids.join(', ')}): "${reason}"`);
    // Manager side: read the request through its own session and decide.
    const req = await leadWallet.getBudgetRequest(asked.data.request_id);
    if (isError(req)) return undefined;
    const original = budget.wallet_cents[name] ?? 0;
    const cap = Math.round(original * plan.topup_cap_ratio);
    const purchasable = req.data.requested_scope.sku_ids.every((s) => sku_ids.includes(s) && ['stock-photo', 'audit-hour', 'hosting-slot', 'data-query'].includes(s));
    const topup: TopUp = { agent, request_id: asked.data.request_id, requested_cents: cents, sku_ids, reason, decision: 'REJECT', manager_reason: '' };
    budget.topups.push(topup);
    if (!purchasable || cap <= 0) {
      topup.manager_reason = !purchasable ? `${sku_ids.join(', ')} is not something this task may buy` : 'no top-up policy for this helper';
      await leadWallet.respondBudget({ request_id: asked.data.request_id, decision: 'REJECT' });
      emit('budget_rejected', 'lead-agent', `Rejected ${agent}'s request for ${usd(cents)}: ${topup.manager_reason}`);
      return undefined;
    }
    const offer = Math.min(cents, cap);
    topup.decision = 'COUNTEROFFER'; topup.offered_cents = offer;
    topup.manager_reason = offer < cents ? `policy caps a top-up at ${Math.round(plan.topup_cap_ratio * 100)}% of the original ${usd(original)} wallet` : 'within policy';
    // The offer must sit inside the request on every dimension, expiry included.
    const r = await leadWallet.respondBudget({ request_id: asked.data.request_id, decision: 'COUNTEROFFER', offered_scope: { ...spendScope(offer, sku_ids, 15), expires_at: req.data.requested_scope.expires_at } });
    if (isError(r)) { topup.decision = 'REJECT'; topup.manager_reason = `${r.code}: ${r.reason}`; return undefined; }
    emit('budget_countered', 'lead-agent', `Counteroffered ${usd(offer)} to ${agent} (asked ${usd(cents)}): ${topup.manager_reason}`);
    const accepted = await session.acceptBudget({ request_id: asked.data.request_id, idempotency_key: `accept-${asked.data.request_id}` });
    if (isError(accepted)) { trace({ agent, kind: 'denied', text: `accept counteroffer → ${accepted.code}: ${accepted.reason}`, code: accepted.code }); return undefined; }
    topup.issued_grant_id = accepted.data.id;
    wallets[`${name}-topup`] = accepted.data;
    trace({ agent, kind: 'call', text: `accepted the manager's ${usd(offer)} counteroffer: new wallet ${accepted.data.id}` });
    return accepted.data;
  }

  emit('note', 'lead-agent', `Task received: build a polished landing page; improve design, audit security, deploy a preview, analyze signups. Authority: ${authority.source}.${budget ? ` Budget: ${usd(budget.root_cents)} root wallet.` : ''}`);

  // 1. Design: a pass for the UI files and a wallet for stock photos. It overreaches once (five photos), then buys two.
  const design = await spawn('design', credentials.design, { actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'] });
  if (plan) {
    await giveWallet('design', plan.wallets.design, ['stock-photo']);
    await buy('design-agent', walletOf('design'), wallets.design!.id, 'stock-photo', 5, 'hero and feature imagery');
    await buy('design-agent', walletOf('design'), wallets.design!.id, 'stock-photo', 2, 'hero and feature imagery');
  }
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
  // The outside firm gets no wallet (AgentPass keeps money inside the organization): the manager pays its invoice itself.
  if (plan) await buy('lead-agent', leadWallet, plan.rootWalletId, 'audit-hour', 2, "Sentinel Sec's review invoice");
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
  if (plan) {
    // Its $100 wallet does not cover two hosting slots ($120): AgentPass refuses, it asks the manager for more
    // (more than it needs), the manager counteroffers within policy, it accepts and buys on the new wallet.
    await giveWallet('hosting', plan.wallets.hosting, ['hosting-slot']);
    const first = await buy('hosting-agent', walletOf('hosting'), wallets.hosting!.id, 'hosting-slot', 2, 'two 60-minute preview slots');
    if (!first) {
      const more = await askForMore('hosting', 20000, ['hosting-slot'], 'Preview needs two 60-minute hosting slots ($120); this wallet holds $100');
      if (more) await buy('hosting-agent', walletOf('hosting'), more.id, 'hosting-slot', 2, 'two 60-minute preview slots, on the top-up wallet');
    }
  }
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
  if (plan) {
    // A $50 wallet for warehouse queries; then it asks for $500 to buy a raw export of people's records: rejected.
    await giveWallet('analytics', plan.wallets.analytics, ['data-query']);
    await buy('analytics-agent', walletOf('analytics'), wallets.analytics!.id, 'data-query', 1, 'signup funnel query');
    await askForMore('analytics', 50000, ['raw-dataset'], 'Buy a raw export of the visitor records (emails) for deeper analysis');
  }
  if (input.specialists.analytics) {
    result.analytics = unwrap(await input.specialists.analytics(analytics));
    emit('analytics_analyzed', 'analytics-agent', 'Computed aggregate metrics from the dataset (no raw rows)');
  }

  // Money left on the root wallet, as AgentPass sees it, before anything is revoked.
  if (plan && budget) {
    const left = await leadWallet.balance(plan.rootWalletId);
    budget.remaining_cents = isError(left) ? null : left.data.remaining_cents;
  }

  // 5. Revoke everything temporary (passes and wallets), then prove reuse fails.
  for (const [name, g] of Object.entries(grants)) {
    const r = await lead.revoke({ grant_id: g.id, reason: 'task complete' });
    if (!isError(r)) { result.revoked.push(g.id); emit('authority_revoked', 'lead-agent', `Revoked ${name}'s grant ${g.id}`); }
  }
  for (const [name, w] of Object.entries(wallets)) {
    const r = await lead.revoke({ grant_id: w.id, reason: 'task complete' });
    if (!isError(r)) { result.revoked.push(w.id); emit('authority_revoked', 'lead-agent', `Revoked ${name}'s wallet ${w.id}`); }
  }
  for (const [name, s] of Object.entries(sessions)) {
    const g = grants[name]!;
    const probe = await s.authorize({ grant_id: g.id, action: g.scope.actions[0]!, resource: g.scope.resources[0]!.replace('**', 'x') });
    if (isError(probe)) result.reuse_after_revoke.push({ agent: `${name}-agent`, code: probe.code });
    const w = wallets[name];
    if (w && hasWallet(s)) {
      const q = await s.quote({ grant_id: w.id, sku_id: w.scope.sku_ids[0]!, quantity: 1, idempotency_key: `probe-${randomUUID()}` });
      if (isError(q)) result.wallet_reuse_after_revoke.push({ agent: `${name}-agent`, code: q.code });
    }
  }
  if (probeSecurity) {
    const probe = await probeSecurity();
    if (probe && probe.status !== 'OK') result.reuse_after_revoke.push({ agent: 'security-agent', code: probe.code ?? 'SERVICE_UNAVAILABLE' });
  }
  return result;
}
