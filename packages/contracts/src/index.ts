/** AgentPass hackathon v1 wire contracts. Source of truth for both developers. */
export type PrincipalId = string;
export type OrganizationId = string;
export type GrantId = string;
export type RequestId = string;
export type QuoteId = string;
export type ISODateTime = string;

export type AgentAction =
  | 'supplier.quote.request'
  | 'supplier.purchase.execute'
  | 'supplier.margin.read'; // Supported only so seller can explicitly DENY it.

export interface AuthorityScope {
  actions: AgentAction[];
  supplier_ids: string[];
  sku_ids: string[];
  /** Integer USD cents; 0 for no paid actions. */
  max_per_action_cents: number;
  /** Aggregate effective ceiling across this grant and descendants. */
  total_budget_cents: number;
  expires_at: ISODateTime;
  max_delegation_depth: number;
}

export interface Principal {
  id: PrincipalId;
  organization_id: OrganizationId;
  kind: 'HUMAN' | 'AGENT' | 'SERVICE';
  role: 'OWNER' | 'BUYER' | 'SOURCING' | 'SUPPLIER' | 'SERVICE';
}

export interface Grant {
  id: GrantId;
  organization_id: OrganizationId;
  issuer_principal_id: PrincipalId;
  subject_principal_id: PrincipalId;
  parent_grant_id: GrantId | null;
  scope: AuthorityScope;
  revoked_at: ISODateTime | null;
}

export type RequestStatus =
  | 'PENDING'
  | 'COUNTEROFFERED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED';

export interface AuthorityRequest {
  id: RequestId;
  requester_principal_id: PrincipalId;
  parent_grant_id: GrantId;
  requested_scope: AuthorityScope;
  offered_scope?: AuthorityScope;
  reason: string;
  status: RequestStatus;
  issued_grant_id?: GrantId;
}

export interface AuthorityRequestInput {
  parent_grant_id: GrantId;
  requested_scope: AuthorityScope;
  reason: string;
}

export interface AuthorityResponseInput {
  decision: 'COUNTEROFFER' | 'REJECT';
  offered_scope?: AuthorityScope;
}

export interface ExecuteActionInput {
  grant_id: GrantId;
  action: AgentAction;
  supplier_id: string;
  sku_id: string;
  quantity?: number;
  quote_id?: QuoteId;
  idempotency_key: string;
}

export interface SupplierQuote {
  quote_id: QuoteId;
  supplier_id: string;
  sku_id: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  currency: 'USD';
  expires_at: ISODateTime;
}

export interface PurchaseReceipt {
  receipt_id: string;
  request_id: string;
  order_id: string;
  supplier_id: string;
  sku_id: string;
  quantity: number;
  amount_cents: number;
  currency: 'USD';
  grant_id: GrantId;
  outcome: 'COMPLETED';
  simulated: true;
}

export type ErrorCode =
  | 'INSUFFICIENT_SCOPE'
  | 'OUTSIDE_PARENT_SCOPE'
  | 'SELLER_POLICY_DENIED'
  | 'GRANT_REVOKED'
  | 'GRANT_EXPIRED'
  | 'BUDGET_EXCEEDED'
  | 'QUOTE_EXPIRED'
  | 'INVALID_CALLER'
  | 'INVALID_REQUEST'
  | 'ALREADY_EXECUTED'
  | 'SERVICE_UNAVAILABLE';

export interface ApiOK<T> { status: 'OK'; data: T }
export interface ApiError {
  status: 'AUTHORITY_REQUIRED' | 'DENIED' | 'ERROR';
  code: ErrorCode;
  reason: string;
  next_action?: 'request_authority' | 'retry' | 'contact_owner';
  required_scope?: AuthorityScope;
}
export type ApiResult<T> = ApiOK<T> | ApiError;

export interface AuditEvent {
  event_id: string;
  timestamp: ISODateTime;
  principal_id: PrincipalId;
  grant_id?: GrantId;
  action: string;
  decision: string;
  reason_code?: ErrorCode;
  request_id?: string;
  trace_id: string;
}

export interface SupplierQuoteRequest {
  buyer_principal_id: PrincipalId;
  supplier_id: string;
  sku_id: string;
  quantity: number;
  request_id: string;
}
export interface SupplierFulfillRequest {
  quote_id: QuoteId;
  buyer_principal_id: PrincipalId;
  request_id: string;
}
