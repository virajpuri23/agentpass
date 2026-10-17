/**
 * Sourcing agent (child). Holds only its own key and whatever grants it is
 * given. State machine:
 *   QUOTE -> TRY_PURCHASE -(AUTHORITY_REQUIRED)-> REQUEST -> WAIT_PARENT
 *         -> ACCEPT -> PURCHASE -> DONE
 * Idempotency keys are derived from the task so a retry never double-buys.
 */
import { randomUUID } from 'node:crypto';
import type { ApiResult, AuthorityRequest, Grant, PurchaseReceipt, SupplierQuote } from '../../../packages/contracts/src/index.js';
import type { AgentContext } from '../../agent-kit/src/runtime.js';
import { isError } from '../../agent-kit/src/authority-client.js';
import { deterministicChild, type ChildDecider } from '../../agent-kit/src/decider.js';
import type { AgentMessage, Envelope } from '../../agent-kit/src/transport.js';

type Task = Extract<AgentMessage, { type: 'TASK_ASSIGNED' }>;

export interface SourcingOutcome {
  ok: boolean;
  stage: string;
  quote?: SupplierQuote;
  request_id?: string;
  purchase_grant_id?: string;
  receipt?: PurchaseReceipt;
  failure?: ApiResult<unknown>;
}

export async function runSourcingTask(ctx: AgentContext, task: Task, opts: { decider?: ChildDecider; parent?: string; replyTimeoutMs?: number } = {}): Promise<SourcingOutcome> {
  const decider = opts.decider ?? deterministicChild;
  const parent = opts.parent ?? 'buyer-agent';
  const run = randomUUID().slice(0, 8);
  const { authority } = ctx;

  // 1. Trusted quote from the supplier, via AgentPass.
  const quoted = await authority.executeAction({
    grant_id: task.grant_id, action: 'supplier.quote.request', supplier_id: task.supplier_id, sku_id: task.sku_id,
    quantity: task.quantity, idempotency_key: `quote-${run}`,
  });
  if (isError(quoted)) return { ok: false, stage: 'QUOTE', failure: quoted };
  const quote = quoted.data as SupplierQuote;
  ctx.note(`Supplier quoted ${quote.quantity} x ${quote.sku_id} = $${(quote.total_cents / 100).toFixed(2)} (quote ${quote.quote_id})`);

  // 2. Try to buy with what we have.
  const purchaseKey = `purchase-${run}`;
  const buy = (grant_id: string) => authority.executeAction({
    grant_id, action: 'supplier.purchase.execute', supplier_id: task.supplier_id, sku_id: task.sku_id,
    quote_id: quote.quote_id, idempotency_key: purchaseKey,
  });
  const first = await buy(task.grant_id);
  if (!isError(first)) return { ok: true, stage: 'DONE', quote, receipt: first.data as PurchaseReceipt };
  if (first.status !== 'AUTHORITY_REQUIRED' || first.next_action !== 'request_authority' || !first.required_scope) {
    return { ok: false, stage: 'TRY_PURCHASE', quote, failure: first };
  }
  ctx.note(`Missing scope ${first.required_scope.actions.join(',')}; recovering via ${first.next_action}`);

  // 3. Ask the parent grant for purchase authority (child may ask for more than it will get).
  const ask = decider.requestScope({ required: first.required_scope, desiredBudgetCents: task.requested_budget_cents, now: new Date() });
  ctx.note(`Requesting $${(ask.scope.total_budget_cents / 100).toFixed(2)} purchase authority`, decider.kind);
  const parentGrantId = await parentGrantOf(ctx, task.grant_id);
  if (!parentGrantId) return { ok: false, stage: 'REQUEST', quote, failure: { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Delegated grant has no parent' } };
  const requested = await authority.requestAuthority({ parent_grant_id: parentGrantId, requested_scope: ask.scope, reason: ask.reason });
  if (isError(requested)) return { ok: false, stage: 'REQUEST', quote, failure: requested };
  const requestId = (requested.data as { request_id: string }).request_id;

  // 4. Tell the parent (a hint only), wait for its decision, then read the authoritative state.
  const corr = `authreq-${requestId}`;
  await ctx.link.send(parent, { type: 'AUTHORITY_REQUESTED', request_id: requestId, parent_grant_id: parentGrantId, requested_scope: ask.scope }, corr);
  await ctx.link.waitForReply(corr, opts.replyTimeoutMs ?? 30_000);
  const state = await authority.getAuthorityRequest(requestId);
  if (isError(state)) return { ok: false, stage: 'WAIT_PARENT', quote, request_id: requestId, failure: state };
  const request = state.data as AuthorityRequest;
  if (request.status !== 'COUNTEROFFERED' || !request.offered_scope) {
    return { ok: false, stage: 'WAIT_PARENT', quote, request_id: requestId, failure: { status: 'DENIED', code: 'INSUFFICIENT_SCOPE', reason: `Parent ${request.status.toLowerCase()} the request` } };
  }
  if (!decider.acceptOffer({ offered: request.offered_scope, neededCents: quote.total_cents })) {
    ctx.note(`Declined offer of $${(request.offered_scope.total_budget_cents / 100).toFixed(2)}: below quote`, decider.kind);
    return { ok: false, stage: 'ACCEPT', quote, request_id: requestId };
  }
  ctx.note(`Accepting counteroffer of $${(request.offered_scope.total_budget_cents / 100).toFixed(2)}`, decider.kind);

  // 5. Accept and buy with the narrower grant.
  const accepted = await authority.acceptAuthorityOffer({ request_id: requestId, idempotency_key: `accept-${requestId}` });
  if (isError(accepted)) return { ok: false, stage: 'ACCEPT', quote, request_id: requestId, failure: accepted };
  const grant = accepted.data as Grant;
  const bought = await buy(grant.id);
  if (isError(bought)) return { ok: false, stage: 'PURCHASE', quote, request_id: requestId, purchase_grant_id: grant.id, failure: bought };
  const receipt = bought.data as PurchaseReceipt;
  ctx.note(`Purchased: receipt ${receipt.receipt_id}, order ${receipt.order_id}, $${(receipt.amount_cents / 100).toFixed(2)}`);
  return { ok: true, stage: 'DONE', quote, request_id: requestId, purchase_grant_id: grant.id, receipt };
}

async function parentGrantOf(ctx: AgentContext, grantId: string): Promise<string | undefined> {
  const mine = await ctx.authority.getMyGrants();
  if (isError(mine)) return undefined;
  return (mine.data as { grants: Grant[] }).grants.find((g) => g.id === grantId)?.parent_grant_id ?? undefined;
}

/** Wires the agent to its message link: one task at a time, result goes back to the sender. */
export function serveSourcing(ctx: AgentContext, opts: { decider?: ChildDecider } = {}) {
  ctx.link.onMessage(async (env: Envelope) => {
    if (env.message.type === 'SHUTDOWN') {
      await ctx.authority.close();
      ctx.link.close();
      return;
    }
    if (env.message.type !== 'TASK_ASSIGNED') return;
    const outcome = await runSourcingTask(ctx, env.message, { ...opts, parent: env.from });
    await ctx.link.reply(env, { type: 'TASK_RESULT', ok: outcome.ok, summary: outcome as unknown as Record<string, unknown> });
  });
}
