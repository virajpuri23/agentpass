/**
 * A release-crew specialist (security / design / QA). It holds only its own
 * provisioned credential and the slice its lead gave it. If its job costs
 * more than its slice, it asks the lead for a top-up with a justification,
 * then adapts to the decision: full top-up, smaller top-up, or no.
 */
import { randomUUID } from 'node:crypto';
import type { ApiResult, AuthorityRequest, Grant, PurchaseReceipt, SupplierQuote } from '../../../packages/contracts/src/index.js';
import { isError } from '../../agent-kit/src/authority-client.js';
import type { AgentContext } from '../../agent-kit/src/runtime.js';
import type { CrewRole, Envelope, ProbeKind } from '../../agent-kit/src/transport.js';
import { justification } from './roles.js';

const SUPPLIER = 'supplier-co';

export interface SpecialistOutcome {
  ok: boolean;
  stage: string;
  sku_id: string;
  needed_quantity: number;
  bought_quantity: number;
  amount_cents: number;
  topup?: { request_id: string; asked_cents: number; decision: string; granted_cents?: number };
  receipt?: PurchaseReceipt;
  failure?: ApiResult<unknown>;
}

async function myInitialGrant(ctx: AgentContext): Promise<Grant | undefined> {
  const mine = await ctx.authority.getMyGrants();
  if (isError(mine)) return undefined;
  // The provisioned grant is the one that can also quote; top-up grants are purchase-only.
  return (mine.data as { grants: Grant[] }).grants.find((g) => g.scope.actions.includes('supplier.quote.request') && !g.revoked_at);
}

async function quote(ctx: AgentContext, grant: Grant, sku_id: string, quantity: number) {
  return ctx.authority.executeAction({ grant_id: grant.id, action: 'supplier.quote.request', supplier_id: SUPPLIER, sku_id, quantity, idempotency_key: `q-${randomUUID()}` });
}

async function buy(ctx: AgentContext, grant_id: string, sku_id: string, q: SupplierQuote) {
  return ctx.authority.executeAction({ grant_id, action: 'supplier.purchase.execute', supplier_id: SUPPLIER, sku_id, quote_id: q.quote_id, idempotency_key: `p-${q.quote_id}` });
}

export async function runTask(ctx: AgentContext, role: CrewRole, task: { sku_id: string; quantity: number }, lead: string): Promise<SpecialistOutcome> {
  const base = { sku_id: task.sku_id, needed_quantity: task.quantity, bought_quantity: 0, amount_cents: 0 };
  const grant = await myInitialGrant(ctx);
  if (!grant) return { ...base, ok: false, stage: 'GRANTS' };
  const slice = grant.scope.max_per_action_cents;

  const quoted = await quote(ctx, grant, task.sku_id, task.quantity);
  if (isError(quoted)) return { ...base, ok: false, stage: 'QUOTE', failure: quoted };
  const q = quoted.data as SupplierQuote;
  ctx.note(`Quote: ${q.quantity} x ${q.sku_id} = $${q.total_cents / 100}`);

  const first = await buy(ctx, grant.id, task.sku_id, q);
  if (!isError(first)) {
    const r = first.data as PurchaseReceipt;
    return { ...base, ok: true, stage: 'DONE', bought_quantity: r.quantity, amount_cents: r.amount_cents, receipt: r };
  }
  // Over my slice: ask the lead for exactly what the job costs, with a reason.
  const overSlice = first.code === 'BUDGET_EXCEEDED' || first.status === 'AUTHORITY_REQUIRED';
  if (!overSlice) return { ...base, ok: false, stage: 'PURCHASE', failure: first };
  const reason = justification(role, q.total_cents, slice);
  ctx.note(`Over my $${slice / 100} slice by $${(q.total_cents - slice) / 100}; asking the lead`, 'deterministic');
  const asked = await ctx.authority.requestAuthority({
    parent_grant_id: grant.parent_grant_id!,
    requested_scope: {
      actions: ['supplier.purchase.execute'], supplier_ids: [SUPPLIER], sku_ids: [task.sku_id],
      max_per_action_cents: q.total_cents, total_budget_cents: q.total_cents,
      expires_at: grant.scope.expires_at, max_delegation_depth: 0,
    },
    reason,
  });
  if (isError(asked)) return { ...base, ok: false, stage: 'REQUEST', failure: asked };
  const request_id = (asked.data as { request_id: string }).request_id;
  const corr = `topup-${request_id}`;
  await ctx.link.send(lead, { type: 'AUTHORITY_REQUESTED', request_id, parent_grant_id: grant.parent_grant_id!, requested_scope: { actions: ['supplier.purchase.execute'], supplier_ids: [SUPPLIER], sku_ids: [task.sku_id], max_per_action_cents: q.total_cents, total_budget_cents: q.total_cents, expires_at: grant.scope.expires_at, max_delegation_depth: 0 } }, corr);
  await ctx.link.waitForReply(corr, 10 * 60_000); // a person may be deciding

  const state = await ctx.authority.getAuthorityRequest(request_id);
  if (isError(state)) return { ...base, ok: false, stage: 'DECISION', failure: state };
  const req = state.data as AuthorityRequest;
  const topup = { request_id, asked_cents: q.total_cents, decision: req.status as string, granted_cents: req.offered_scope?.total_budget_cents };

  // Decide how much to buy and with which grant.
  let useGrant = grant.id, budget = slice;
  if (req.status === 'COUNTEROFFERED' && req.offered_scope) {
    const accepted = await ctx.authority.acceptAuthorityOffer({ request_id, idempotency_key: `accept-${request_id}` });
    if (isError(accepted)) return { ...base, ok: false, stage: 'ACCEPT', topup, failure: accepted };
    useGrant = (accepted.data as Grant).id;
    budget = req.offered_scope.total_budget_cents;
    ctx.note(budget >= q.total_cents ? `Top-up approved: $${budget / 100}` : `Smaller top-up: $${budget / 100}; buying what fits`);
  } else {
    ctx.note(`Top-up denied; buying what my $${slice / 100} slice covers`);
  }
  let finalQuote = q;
  if (budget < q.total_cents) {
    const fits = Math.floor(budget / q.unit_price_cents);
    if (fits < 1) return { ...base, ok: false, stage: 'FITS_NOTHING', topup };
    const requoted = await quote(ctx, grant, task.sku_id, fits);
    if (isError(requoted)) return { ...base, ok: false, stage: 'REQUOTE', topup, failure: requoted };
    finalQuote = requoted.data as SupplierQuote;
  }
  const bought = await buy(ctx, useGrant, task.sku_id, finalQuote);
  if (isError(bought)) return { ...base, ok: false, stage: 'PURCHASE', topup, failure: bought };
  const r = bought.data as PurchaseReceipt;
  return { ...base, ok: true, stage: 'DONE', bought_quantity: r.quantity, amount_cents: r.amount_cents, topup, receipt: r };
}

/** Probes the runner asks a specialist to attempt under its own identity. */
async function runProbe(ctx: AgentContext, probe: ProbeKind, p: Record<string, string>) {
  if (probe !== 'buy') return { status: 'ERROR' as const, code: 'INVALID_REQUEST' as const, reason: `Probe ${probe} not supported` };
  const grant = await myInitialGrant(ctx);
  if (!grant) {
    const r = await ctx.authority.getMyGrants();
    return isError(r) ? r : { status: 'ERROR' as const, code: 'INVALID_REQUEST' as const, reason: 'No grant' };
  }
  const quoted = await quote(ctx, grant, p.sku_id!, Number(p.quantity ?? 1));
  if (isError(quoted)) return quoted;
  return buy(ctx, grant.id, p.sku_id!, quoted.data as SupplierQuote);
}

export function serveSpecialist(ctx: AgentContext, role: CrewRole) {
  ctx.link.onMessage(async (env: Envelope) => {
    const m = env.message;
    if (m.type === 'CREW_TASK') {
      const outcome = await runTask(ctx, role, m, env.from);
      await ctx.link.reply(env, { type: 'TASK_RESULT', ok: outcome.ok, summary: outcome as unknown as Record<string, unknown> });
    } else if (m.type === 'PROBE_REQUESTED') {
      await ctx.link.reply(env, { type: 'PROBE_RESULT', probe: m.probe, result: await runProbe(ctx, m.probe, m.params) });
    } else if (m.type === 'SHUTDOWN') {
      await ctx.authority.close();
      ctx.link.close();
    }
  });
}
