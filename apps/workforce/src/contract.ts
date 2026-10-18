/**
 * Workforce authority contract (Developer B's adapter boundary).
 *
 * Generic, resource-scoped actions for the coding-agent demo. Developer A is
 * extending AgentPass from purchase-only scopes to this shape; until
 * docs/11-WORKFORCE-CONTRACT.md is published, MockWorkforceAuthority
 * implements this interface and every output is labeled MOCK. Agents and
 * tool gateways only ever talk to this interface, so swapping in the real
 * API changes one factory, not the agents.
 *
 * Mirrors the frozen purchase contract's conventions: `{status:'OK',data}`
 * on success; `AUTHORITY_REQUIRED` (recoverable, with required_scope and
 * next_action) vs `DENIED` (not recoverable by the caller); identity comes
 * from the caller's credential, never from an argument.
 */

export type WorkforceAction =
  | 'repo.read'
  | 'repo.write'
  | 'deploy.preview'
  | 'deploy.production'
  | 'analytics.aggregate'
  | 'analytics.raw'
  | 'secrets.read';

export const WORKFORCE_ACTIONS: readonly WorkforceAction[] = [
  'repo.read', 'repo.write', 'deploy.preview', 'deploy.production', 'analytics.aggregate', 'analytics.raw', 'secrets.read',
];

/**
 * What a grant allows. `resources` are allow-list globs per action family:
 *  - repo.*       -> file paths relative to the project root ("src/components/**")
 *  - deploy.*     -> environment names ("preview")
 *  - analytics.*  -> dataset names ("landing-page")
 * Empty resources means NOTHING (never a wildcard), matching the purchase contract.
 */
export interface WorkforceScope {
  actions: WorkforceAction[];
  resources: string[];
  expires_at: string;
  max_delegation_depth: number;
}

export interface WorkforceGrant {
  id: string;
  issuer_principal_id: string;
  subject_principal_id: string;
  parent_grant_id: string | null;
  organization_id: string;
  scope: WorkforceScope;
  revoked_at: string | null;
}

export type RequestStatus = 'PENDING' | 'COUNTEROFFERED' | 'ACCEPTED' | 'REJECTED';

export interface WorkforceRequest {
  id: string;
  requester_principal_id: string;
  parent_grant_id: string;
  requested_scope: WorkforceScope;
  offered_scope?: WorkforceScope;
  reason: string;
  status: RequestStatus;
  issued_grant_id?: string;
}

export type ErrorCode =
  | 'INSUFFICIENT_SCOPE' | 'OUTSIDE_PARENT_SCOPE' | 'RESOURCE_DENIED' | 'GRANT_REVOKED' | 'GRANT_EXPIRED'
  | 'INVALID_CALLER' | 'INVALID_REQUEST' | 'ALREADY_EXECUTED' | 'SERVICE_UNAVAILABLE';

export interface ApiOK<T> { status: 'OK'; data: T }
export interface ApiError {
  status: 'AUTHORITY_REQUIRED' | 'DENIED' | 'ERROR';
  code: ErrorCode;
  reason: string;
  next_action?: 'request_authority' | 'retry' | 'contact_owner';
  /** For AUTHORITY_REQUIRED: the narrowest scope that would allow the attempt. */
  required_scope?: WorkforceScope;
  /** For AUTHORITY_REQUIRED: a permitted alternative the caller may request instead (e.g. deploy.preview). */
  alternative_scope?: WorkforceScope;
}
export type ApiResult<T> = ApiOK<T> | ApiError;

/** A positive authorization: the gateway may perform exactly this action on this resource, once. */
export interface Authorization {
  authorization_id: string;
  grant_id: string;
  principal_id: string;
  action: WorkforceAction;
  resource: string;
  chain: string[]; // grant ids, root first
}

export interface AuditEvent {
  event_id: string;
  timestamp: string;
  principal_id: string;
  grant_id?: string;
  action: string;
  resource?: string;
  decision: 'ALLOW' | 'DENY' | 'AUTHORITY_REQUIRED' | 'ISSUED' | 'REVOKED' | 'REQUESTED' | 'COUNTEROFFERED' | 'ACCEPTED' | 'REJECTED';
  reason_code?: ErrorCode;
  request_id?: string;
  source: 'MOCK' | 'AGENTPASS';
}

/** A caller-bound handle: every method acts as the principal whose credential opened it. */
export interface WorkforceSession {
  readonly principal_id: string;
  me(): Promise<ApiResult<{ principal_id: string; organization_id: string; grants: WorkforceGrant[] }>>;
  /** Issue a strict-subset grant to another principal under one of my grants. */
  delegate(input: { parent_grant_id: string; recipient_principal_id: string; scope: WorkforceScope }): Promise<ApiResult<WorkforceGrant>>;
  /** Ask the holder of `parent_grant_id` for scope I don't have. */
  requestAuthority(input: { parent_grant_id: string; requested_scope: WorkforceScope; reason: string }): Promise<ApiResult<{ request_id: string; status: RequestStatus }>>;
  getRequest(request_id: string): Promise<ApiResult<WorkforceRequest>>;
  /** Parent side: counteroffer (narrower) or reject. */
  respond(input: { request_id: string; decision: 'COUNTEROFFER' | 'REJECT'; offered_scope?: WorkforceScope }): Promise<ApiResult<WorkforceRequest>>;
  /** Requester side: accept a counteroffer; returns the issued grant. */
  accept(input: { request_id: string; idempotency_key: string }): Promise<ApiResult<WorkforceGrant>>;
  /** Check one concrete action before a gateway performs it. */
  authorize(input: { grant_id: string; action: WorkforceAction; resource: string }): Promise<ApiResult<Authorization>>;
  revoke(input: { grant_id: string; reason: string }): Promise<ApiResult<{ grant_id: string; revoked_at: string }>>;
}

export interface WorkforceAuthority {
  /** 'MOCK' until Developer A's implementation is wired in; every UI/log must show it. */
  readonly source: 'MOCK' | 'AGENTPASS';
  /** Open a session for whoever holds `credential`. Unknown credential -> INVALID_CALLER. */
  connect(credential: string): Promise<ApiResult<WorkforceSession>>;
  /** Read-only audit trail (demo UI and tests). */
  audit(): Promise<AuditEvent[]>;
}
