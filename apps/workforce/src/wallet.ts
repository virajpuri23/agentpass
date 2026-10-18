/**
 * Money for the workforce demo (Developer B's adapter boundary, like contract.ts).
 *
 * AgentPass keeps money and file/deploy authority in separate grant families:
 * a purchasing grant carries a budget, a vendor and SKUs; a workforce grant
 * carries resources and paths. So every helper holds two things from the
 * manager: a pass (WorkforceScope) and a wallet (SpendScope). Budget is
 * enforced by AgentPass on every purchase against the whole chain's ledger
 * (a helper's wallet AND the manager's root wallet), and a helper that runs
 * short asks the manager for a top-up through the same request/counteroffer/
 * accept flow the pass negotiation uses. Purchases are simulated: the vendor
 * is an in-process stub with fixed prices; nothing is paid for real.
 */
import type { ApiResult, RequestStatus } from './contract.js';

export interface SpendScope {
  vendor_id: string;
  sku_ids: string[];
  total_budget_cents: number;
  max_per_action_cents: number;
  expires_at: string;
  max_delegation_depth: number;
}

export interface WalletGrant {
  id: string;
  issuer_principal_id: string;
  subject_principal_id: string;
  parent_grant_id: string | null;
  organization_id: string;
  scope: SpendScope;
  revoked_at: string | null;
}

export interface WalletRequest {
  id: string;
  requester_principal_id: string;
  parent_grant_id: string;
  requested_scope: SpendScope;
  offered_scope?: SpendScope;
  reason: string;
  status: RequestStatus;
  issued_grant_id?: string;
}

export interface Quote { quote_id: string; sku_id: string; quantity: number; unit_price_cents: number; total_cents: number; expires_at: string }
export interface Receipt { receipt_id: string; order_id: string; sku_id: string; quantity: number; amount_cents: number; grant_id: string }

/** A session that can also hold and spend wallets. Identity still comes from the credential that opened it. */
export interface WalletSession {
  delegateWallet(input: { parent_grant_id: string; recipient_principal_id: string; scope: SpendScope }): Promise<ApiResult<WalletGrant>>;
  /** Price check: a real quote from the vendor, authorized by AgentPass but costing nothing. */
  quote(input: { grant_id: string; sku_id: string; quantity: number; idempotency_key: string }): Promise<ApiResult<Quote>>;
  /** The protected spend: AgentPass checks per-action and remaining budget on every grant in the chain, then reserves and commits the amount. */
  purchase(input: { grant_id: string; sku_id: string; quote_id: string; idempotency_key: string }): Promise<ApiResult<Receipt>>;
  requestBudget(input: { parent_grant_id: string; requested_scope: SpendScope; reason: string }): Promise<ApiResult<{ request_id: string; status: RequestStatus }>>;
  getBudgetRequest(request_id: string): Promise<ApiResult<WalletRequest>>;
  respondBudget(input: { request_id: string; decision: 'COUNTEROFFER' | 'REJECT'; offered_scope?: SpendScope }): Promise<ApiResult<WalletRequest>>;
  acceptBudget(input: { request_id: string; idempotency_key: string }): Promise<ApiResult<WalletGrant>>;
  /** What this wallet can still spend, as AgentPass computes it from the chain's ledger (null when the chain is dead). */
  balance(grant_id: string): Promise<ApiResult<{ remaining_cents: number | null }>>;
}

export const hasWallet = (session: unknown): session is WalletSession =>
  !!session && typeof session === 'object' && typeof (session as WalletSession).purchase === 'function';

export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
