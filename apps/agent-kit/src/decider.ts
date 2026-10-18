/**
 * Agent decision points behind small interfaces so a Claude-backed decider
 * can replace the deterministic one later (deterministic first, by design).
 * Deciders only *propose*; AgentPass enforces every limit in code.
 */
import type { AuthorityRequest, AuthorityScope, Grant } from '../../../packages/contracts/src/index.js';

export interface ChildDecider {
  readonly kind: 'deterministic' | 'llm';
  /** Build the scope to request after an AUTHORITY_REQUIRED, given what the server said is missing. */
  requestScope(input: { required: AuthorityScope; desiredBudgetCents: number; now: Date }): { scope: AuthorityScope; reason: string };
  /** Decide whether to accept a counteroffer for the task at hand. */
  acceptOffer(input: { offered: AuthorityScope; neededCents: number }): boolean;
}

export interface ParentDecider {
  readonly kind: 'deterministic' | 'llm';
  /** Counteroffer within the parent's own grant and the child's request, or reject. */
  respond(input: { request: AuthorityRequest; parentGrant: Grant; now: Date }):
    { decision: 'COUNTEROFFER'; offered_scope: AuthorityScope } | { decision: 'REJECT'; reason: string };
}

const minutes = (now: Date, n: number) => new Date(now.getTime() + n * 60_000).toISOString();
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const intersect = <T>(a: T[], b: T[]) => a.filter((x) => b.includes(x));

/** Sourcing agent: asks for its desired budget (may exceed what the parent can give). */
export const deterministicChild: ChildDecider = {
  kind: 'deterministic',
  requestScope({ required, desiredBudgetCents, now }) {
    const budget = Math.max(desiredBudgetCents, required.max_per_action_cents);
    return {
      scope: {
        ...required,
        max_per_action_cents: budget,
        total_budget_cents: budget,
        expires_at: earlier(required.expires_at, minutes(now, 30)),
        max_delegation_depth: 0,
      },
      reason: `Purchase ${required.sku_ids.join(',')} from ${required.supplier_ids.join(',')} within an authoritative supplier quote`,
    };
  },
  acceptOffer({ offered, neededCents }) {
    return offered.actions.includes('supplier.purchase.execute') && offered.max_per_action_cents >= neededCents;
  },
};

/**
 * Buyer agent policy: never offer more than `capCents` per child purchase, never beyond
 * its own grant or the child's request, same supplier/SKU only, short expiry, no re-delegation.
 */
export function deterministicParent(opts: { capCents: number; offerMinutes: number }): ParentDecider {
  return {
    kind: 'deterministic',
    respond({ request, parentGrant, now }) {
      const asked = request.requested_scope;
      const own = parentGrant.scope;
      const actions = intersect(asked.actions, own.actions);
      const supplier_ids = intersect(asked.supplier_ids, own.supplier_ids);
      const sku_ids = intersect(asked.sku_ids, own.sku_ids);
      if (!actions.length || !supplier_ids.length || !sku_ids.length) {
        return { decision: 'REJECT', reason: 'Requested resources are outside the parent grant' };
      }
      const perAction = Math.min(asked.max_per_action_cents, own.max_per_action_cents, opts.capCents);
      const total = Math.min(asked.total_budget_cents, own.total_budget_cents, opts.capCents);
      if (perAction <= 0 || total <= 0) return { decision: 'REJECT', reason: 'No budget available to delegate' };
      return {
        decision: 'COUNTEROFFER',
        offered_scope: {
          actions, supplier_ids, sku_ids,
          max_per_action_cents: perAction,
          total_budget_cents: total,
          expires_at: earlier(earlier(asked.expires_at, own.expires_at), minutes(now, opts.offerMinutes)),
          max_delegation_depth: 0,
        },
      };
    },
  };
}
