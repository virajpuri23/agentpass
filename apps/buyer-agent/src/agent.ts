/**
 * Buyer agent (parent). Holds the owner's root grant. It never shares its key:
 * it delegates a quote-only grant, asks the platform to spawn a sourcing
 * agent with that agent's own identity, and answers authority requests with
 * a narrower counteroffer chosen by its decider. AgentPass enforces limits.
 */
import type { AuthorityRequest, AuthorityScope, Grant } from '../../../packages/contracts/src/index.js';
import type { AgentContext } from '../../agent-kit/src/runtime.js';
import { isError } from '../../agent-kit/src/authority-client.js';
import { deterministicParent, type ParentDecider } from '../../agent-kit/src/decider.js';
import type { AgentMessage, Envelope, PurchaseTask } from '../../agent-kit/src/transport.js';

export const CHILD = 'sourcing-agent';
const QUOTE_ONLY_MINUTES = 10;

export interface BuyerOptions {
  decider?: ParentDecider;
  rootGrantId?: string;
  taskTimeoutMs?: number;
}

export function serveBuyer(ctx: AgentContext, opts: BuyerOptions = {}) {
  const decider = opts.decider ?? deterministicParent({ capCents: 90000, offerMinutes: 10 });
  const rootGrantId = opts.rootGrantId ?? 'grant-root-buyer';
  let root: Grant | undefined;

  async function loadRoot(): Promise<Grant> {
    const mine = await ctx.authority.getMyGrants();
    if (isError(mine)) throw new Error(`Cannot read own grants: ${mine.code}`);
    const grant = (mine.data as { grants: Grant[] }).grants.find((g) => g.id === rootGrantId);
    if (!grant) throw new Error(`Root grant ${rootGrantId} not held by this agent`);
    return grant;
  }

  async function start(env: Envelope, task: PurchaseTask) {
    root = await loadRoot();
    ctx.note(`Holding root grant ${root.id}: $${(root.scope.total_budget_cents / 100).toFixed(2)} for ${root.scope.sku_ids.join(',')}`);

    // Quote-only delegation: the child can look, not spend.
    const quoteOnly: AuthorityScope = {
      actions: ['supplier.quote.request'],
      supplier_ids: [task.supplier_id],
      sku_ids: [task.sku_id],
      max_per_action_cents: 0,
      total_budget_cents: 0,
      expires_at: new Date(Math.min(Date.now() + QUOTE_ONLY_MINUTES * 60_000, Date.parse(root.scope.expires_at))).toISOString(),
      max_delegation_depth: 0,
    };
    const delegated = await ctx.authority.delegateAuthority({ parent_grant_id: root.id, recipient_principal_id: CHILD, scope: quoteOnly });
    if (isError(delegated)) {
      await ctx.link.reply(env, { type: 'TASK_RESULT', ok: false, summary: { stage: 'DELEGATE', failure: delegated } });
      return;
    }
    const childGrant = delegated.data as Grant;
    ctx.note(`Delegated quote-only grant ${childGrant.id} to ${CHILD}`);

    // The platform (launcher) creates the child with its own credentials.
    const spawnCorr = `spawn-${childGrant.id}`;
    await ctx.link.send('launcher', { type: 'SPAWN_REQUESTED', agent: CHILD }, spawnCorr);
    await ctx.link.waitForReply(spawnCorr, 30_000);

    const taskCorr = `task-${childGrant.id}`;
    await ctx.link.send(CHILD, { type: 'TASK_ASSIGNED', grant_id: childGrant.id, ...task }, taskCorr);
    const result = await ctx.link.waitForReply(taskCorr, opts.taskTimeoutMs ?? 120_000);
    const summary = result.type === 'TASK_RESULT' ? result.summary : { stage: 'UNKNOWN' };
    await ctx.link.reply(env, {
      type: 'TASK_RESULT',
      ok: result.type === 'TASK_RESULT' && result.ok,
      summary: { ...summary, quote_only_grant_id: childGrant.id, root_grant_id: root.id },
    });
  }

  async function answerRequest(env: Envelope, requestId: string) {
    const read = await ctx.authority.getAuthorityRequest(requestId);
    if (isError(read)) {
      await ctx.link.reply(env, { type: 'AUTHORITY_RESPONDED', request_id: requestId, decision: 'REJECT' });
      return;
    }
    const request = read.data as AuthorityRequest;
    root = await loadRoot(); // live view: revoked/expired roots fail here or at AgentPass
    const decision = decider.respond({ request, parentGrant: root, now: new Date() });
    if (decision.decision === 'COUNTEROFFER') {
      ctx.note(`Child asked $${(request.requested_scope.total_budget_cents / 100).toFixed(2)}; counteroffering $${(decision.offered_scope.total_budget_cents / 100).toFixed(2)}`, decider.kind);
    } else {
      ctx.note(`Rejecting request: ${decision.reason}`, decider.kind);
    }
    const responded = await ctx.authority.respondAuthorityRequest({
      request_id: requestId,
      decision: decision.decision,
      ...(decision.decision === 'COUNTEROFFER' ? { offered_scope: decision.offered_scope } : {}),
    });
    await ctx.link.reply(env, {
      type: 'AUTHORITY_RESPONDED', request_id: requestId, decision: isError(responded) ? 'REJECT' : decision.decision,
    });
  }

  async function revoke(env: Envelope, grantId: string, reason: string) {
    const revoked = await ctx.authority.revokeAuthority({ grant_id: grantId, reason });
    if (!isError(revoked)) ctx.note(`Revoked ${grantId}: ${reason}`);
    await ctx.link.reply(env, { type: 'GRANT_REVOKED', grant_id: grantId, ok: !isError(revoked), ...(isError(revoked) ? { code: revoked.code } : {}) });
  }

  ctx.link.onMessage(async (env) => {
    const m: AgentMessage = env.message;
    try {
      switch (m.type) {
        case 'START': return await start(env, m.task);
        case 'AUTHORITY_REQUESTED': return await answerRequest(env, m.request_id);
        case 'REVOKE_REQUESTED': return await revoke(env, m.grant_id, m.reason);
        case 'SHUTDOWN':
          await ctx.link.send(CHILD, { type: 'SHUTDOWN' }, 'shutdown');
          await ctx.authority.close();
          ctx.link.close();
          return;
      }
    } catch (error) {
      ctx.note(`Error handling ${m.type}: ${(error as Error).message}`);
      if (m.type === 'START') await ctx.link.reply(env, { type: 'TASK_RESULT', ok: false, summary: { stage: 'START', error: (error as Error).message } });
    }
  });
}
