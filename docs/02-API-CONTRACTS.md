# Frozen API and MCP Contract (v1 Hackathon)

**Freeze this document before coding in parallel.** TS types: `packages/contracts/src/index.ts`. Examples: `fixtures/`. Do not rename fields or endpoints without both developers agreeing.

## Authentication, principals and errors

- Every agent HTTP request: `Authorization: Bearer <unique demo agent API key>`; server maps key to actual `principal_id` and `organization_id`. No `agent_id` request field establishes caller identity.
- Root seeding and revocation: authenticated admin or authorized issuer role, never a child with just a grant ID.
- Authority ↔ supplier: **separate** `X-Service-Key` shared only by trusted backend services; keys stay in env, not LLM prompts.
- P0 tokens are centrally verified opaque grants. **Possession of grant ID alone is not authentication**.
- All amounts: integer USD cents. Time: ISO 8601 UTC. `idempotency_key` uniquely identifies one requested purchase for its authenticated principal.
- JSON response envelope for success: `{ "status": "OK", "data": ... }`; for denials/errors: `{ "status": "AUTHORITY_REQUIRED" | "DENIED" | "ERROR", "code": "...", "reason": "...", "next_action"?: "...", "required_scope"?: { ... } }`.
- Codes: `INSUFFICIENT_SCOPE`, `OUTSIDE_PARENT_SCOPE`, `SELLER_POLICY_DENIED`, `GRANT_REVOKED`, `GRANT_EXPIRED`, `BUDGET_EXCEEDED`, `QUOTE_EXPIRED`, `INVALID_CALLER`, `INVALID_REQUEST`, `ALREADY_EXECUTED`, `SERVICE_UNAVAILABLE`.
- `AUTHORITY_REQUIRED` is the *recoverable* insufficient-scope case, not a silent allow.

## Data objects

### Scope

```json
{
  "actions": ["supplier.quote.request", "supplier.purchase.execute"],
  "supplier_ids": ["supplier-co"],
  "sku_ids": ["PACK-500"],
  "max_per_action_cents": 90000,
  "total_budget_cents": 90000,
  "expires_at": "2026-10-18T17:30:00Z",
  "max_delegation_depth": 0
}
```

`total_budget_cents` is a limit, not a reservation; all executed payments count against the remaining budget of the grant **and every ancestor**. A quote-only grant may have 0 budget and `max_per_action_cents` 0. Delegation must be a subset of the source grant, with `expires_at <= parent.expires_at` and depth decreasing. An empty SKU/supplier array means **no permitted resources** (never wildcard); use explicit allowlists.

### Grant

```json
{
  "id": "grant-sourcing-purchase",
  "issuer_principal_id": "buyer-agent",
  "subject_principal_id": "sourcing-agent",
  "parent_grant_id": "grant-root-buyer",
  "organization_id": "buyer-co",
  "scope": { "actions": ["supplier.purchase.execute"], "supplier_ids": ["supplier-co"], "sku_ids": ["PACK-500"], "max_per_action_cents": 90000, "total_budget_cents": 90000, "expires_at": "2026-10-18T17:30:00Z", "max_delegation_depth": 0 },
  "revoked_at": null
}
```

## Authority HTTP endpoints (Developer A)

| Verb/path | Request | Response | Auth |
|---|---|---|---|
| `GET /health` | None | `{status:"OK"}` | Public local |
| `GET /v1/me` | None | `principal_id`, `organization_id`, `role` | Agent |
| `POST /v1/authority/requests` | `parent_grant_id`, `requested_scope`, `reason` | `request_id`, `status:"PENDING"` | Child requester |
| `GET /v1/authority/requests/:id` | None | Request, offer, status | Requester or parent |
| `POST /v1/authority/requests/:id/respond` | `{ decision:"COUNTEROFFER"|"REJECT", offered_scope? }` | Updated request | Authorized parent |
| `POST /v1/authority/requests/:id/accept` | `{ idempotency_key }` | Issued restricted grant | Requesting child |
| `POST /v1/grants/:id/delegate` | `{ recipient_principal_id, scope }` | Child grant | Authenticated parent subject |
| `POST /v1/grants/:id/revoke` | `{ reason }` | Revocation receipt | Issuer / approved owner |
| `POST /v1/actions/execute` | `grant_id`, `action`, `supplier_id`, `sku_id`, `quantity?`, `quote_id?`, `idempotency_key` | Quote or receipt, or structured denial | Authenticated grant subject |
| `GET /v1/audit` | Optional filters | Chronological events | Admin only |

`respond(COUNTEROFFER)` must validate offered scope against issuer's **live** authority; `accept` must validate again (time, revocation, remaining scope). This prevents stale counteroffers being used after revocation. Parent `respond` and child `accept` cannot be called by the opposite party.

For P0 root grants are seeded through a **CLI/admin-only routine**. Do not expose a public, unauthenticated root-grant issuance API.

## Supplier HTTP endpoints (Developer B)

| Verb/path | Request | Response | Security |
|---|---|---|---|
| `GET /health` | None | `OK` | Local |
| `POST /internal/quote` | `{ buyer_principal_id, supplier_id, sku_id, quantity, request_id }` | Server-calculated quote fields | Service credential; seller policy |
| `GET /internal/quotes/:id` | None | Public quote details | Service credential |
| `POST /internal/fulfill` | `{ quote_id, buyer_principal_id, request_id }` | Idempotent order fulfillment | Service credential; seller policy |
| `POST /internal/policy/evaluate` | `{ principal_id, action, resource }` | `ALLOW` or `DENY` without private fields | Service credential |

Supplier **does not** offer an external endpoint that returns internal costs or margins. It must explicitly deny `supplier.margin.read`; don't create a debug bypass.

## Public tool names (Developer A MCP adapter)

| MCP tool | Arguments | Semantics |
|---|---|---|
| `describe_authority` | `{}` | List actions, limits vocabulary, and repair actions |
| `get_my_grants` | `{}` | Authenticated caller's grants only |
| `request_authority` | `{ parent_grant_id, requested_scope, reason }` | Starts scope negotiation |
| `get_authority_request` | `{ request_id }` | Poll pending/counteroffered status |
| `respond_authority_request` | `{ request_id, decision, offered_scope? }` | Parent's authorized counteroffer/denial |
| `accept_authority_offer` | `{ request_id, idempotency_key }` | Child accepts narrowed grant |
| `delegate_authority` | `{ parent_grant_id, recipient_principal_id, scope }` | Direct subset delegation |
| `execute_action` | `{ grant_id, action, supplier_id, sku_id, quantity?, quote_id?, idempotency_key }` | Enforced quote or purchase |
| `revoke_authority` | `{ grant_id, reason }` | Issuer/owner revocation |

`execute_action` for a quote uses SKU+quantity; purchase uses quote_id and the server retrieves trusted amount/quantity from supplier. Unknown actions **deny**. No raw generic URL, arbitrary SQL, or shell command execution.

### Example: insufficient permissions

```json
{
  "status": "AUTHORITY_REQUIRED",
  "code": "INSUFFICIENT_SCOPE",
  "reason": "Current grant allows quote requests but not purchases",
  "required_scope": {
    "actions": ["supplier.purchase.execute"],
    "supplier_ids": ["supplier-co"],
    "sku_ids": ["PACK-500"],
    "max_per_action_cents": 85000,
    "total_budget_cents": 85000,
    "expires_at": "2026-10-18T17:30:00Z",
    "max_delegation_depth": 0
  },
  "next_action": "request_authority"
}
```

### Example: successful purchase

```json
{
  "status": "OK",
  "data": {
    "receipt_id": "rec-001",
    "request_id": "purchase-001",
    "order_id": "order-001",
    "supplier_id": "supplier-co",
    "sku_id": "PACK-500",
    "quantity": 500,
    "amount_cents": 85000,
    "currency": "USD",
    "grant_id": "grant-sourcing-purchase",
    "outcome": "COMPLETED",
    "simulated": true
  }
}
```

## Integration contract tests to run before model integration

1. Unrecognized agent API key → 401.
2. Child calls `respond_authority_request` → 403.
3. Child quote grant can request quote but purchase returns `AUTHORITY_REQUIRED`.
4. Parent `COUNTEROFFER` `$900` against root `$1,000` → accepted.
5. Counteroffer `$1,200` -> `OUTSIDE_PARENT_SCOPE`.
6. Purchase based on $850 trusted quote succeeds; retry same key returns identical receipt without a second debit.
7. Margin read denied by seller and no private numeric fields in response.
8. Expired or revoked grant fails even if subject/principal remains valid.
