# Frozen API and MCP Contract (v1 Hackathon)

**Freeze this document before coding in parallel.** TS types: `packages/contracts/src/index.ts`. Examples: `fixtures/`. Do not rename fields or endpoints without both developers agreeing.

The additive self-service contract in [the A9 pack](18-A9-ONBOARDING-CONTRACTS.md)
was accepted by Developer B, confirmed directly by the user for PR #14 on October
17, 2026. Its source is `packages/contracts/src/onboarding.ts`, re-exported from
`index.ts`; portable schemas and fixtures retain their existing proposal filenames.
Runtime configuration and verification limits are in [the rollout runbook](21-SELF-SERVICE-ROLLOUT.md).

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

### Additive self-service endpoints

OAuth access tokens are verified for the canonical AgentPass resource at both MCP
and authority ingress. Persisted `(issuer, subject, verified client)` resolves the
account, personal workspace and limited connection principal. Neither tool input
nor token refresh chooses an organization, owner role or allocation.

| Verb/path | Request schema in `onboardingSchemas` | Result/authentication |
|---|---|---|
| `GET /v1/onboarding/context` | `context_request` | `context_data`; verified human OAuth connection |
| `POST /v1/agents` | `provision_request` | `agent_data`; active consented connection |
| `GET /v1/agents` | `list_request` query (digit-only numeric limit) | `list_data`; own connection only |
| `GET /v1/agents/:agent_id` | `get_request` path | `agent_data`; own connection only |
| `POST /v1/agents/:agent_id/revoke` | `revoke_agent_request`, ID in path | `agent_data`; revoke first, private cleanup afterward |
| `POST /v1/onboarding/connection/revoke` | `revoke_connection_request` | `revoke_connection_data`; derive connection from verified OAuth |

The corresponding six remote MCP tools are `get_onboarding_context`,
`provision_agent`, `list_agents`, `get_agent`, `revoke_agent`, `revoke_connection`.
The legacy stdio adapter retains its existing ten service-agent tools. No public
tool returns child credentials or approves its own root authority.

Trusted first-party browser routes are `GET /onboarding?connection=...`,
`GET /onboarding/callback`, `GET /onboarding/approve`, and
`POST /onboarding/approve`. They require independent user login, one-use encrypted
session state, PKCE and CSRF. The approval form defaults to zero purchase budget.
There is no model-facing consent-approval API. The MCP app proxies these fixed
paths to authority at its canonical HTTPS origin without forwarding bearer tokens.
Supabase's own OAuth authorization UI is mounted at `/onboarding/identity`:
GET accepts a provider `authorization_id`; POST `/login`, GET/POST `/verify`,
GET `/review`, and POST `/decision` implement verified email OTP and explicit
provider-client approval/denial. These routes do not issue AgentPass grants.
All browser POSTs use exact Origin, one-use sessions and CSRF; prior provider
consent redirects must match a server-configured callback allowlist.

| Private route | Schema | Authentication |
|---|---|---|
| `POST /internal/agent-jobs/claim` | `runner_claim_request` | Trusted runner admission, exact organization list |
| `POST /internal/agent-jobs/:job_id/credential` | `runner_credential_request` | Same live runner/claim; **secret-bearing private response**, no-store |
| `POST /internal/agent-jobs/:job_id/heartbeat` | `runner_heartbeat_request` | Same live runner/claim |
| `POST /v1/agent-runs/:job_id/ready` | `child_ready_request` | Exact issued child credential and delivered live claim |
| `POST /internal/agent-jobs/:job_id/result` | `runner_result_request` | Same live runner/claim; sanitized outcome/hash only |

The lease is 30 seconds, heartbeat 10 seconds, and the stable launch ID must be
deduplicated by B. At most three claims are allowed before delivery; losing a
lease after delivery fails the instance and revokes the child. `PENDING` and
`PROVISIONING` never mean a model is running; `READY` requires the child identity
proof. See [the B handoff](20-DEVELOPER-B-RUNNER-HANDOFF.md) for full recovery rules.

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
| `provision_child` | `{ parent_grant_id, scope, credential_hash, idempotency_key }` | Authenticated grant holder creates a new AGENT/SERVICE child and a subset grant; verifier only, never a bearer secret |
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

## Console read extension (does not change frozen shared contracts)

`GET /v1/console` requires the same existing bearer authentication as `/v1/me`.
It returns `{status:"OK",data:{principal,grants,budgets,requests,activity,receipts,visibility,snapshot_at}}`.
The response is an application read model, not a new grant or authorization contract.

- `principal`: authenticated persisted principal (`id`, `organization_id`, `kind`, `role`).
- `grants`: existing `Grant` shapes. An organization OWNER sees organization grants; other principals see only grants they hold or directly issued. No arbitrary grant-ID read is added.
- `budgets`: existing Inspector budget shape, evaluated by the canonical chain and ledger logic for each visible grant. Revoked/expired/invalid chains return a denial code and null remaining budget.
- `requests`: existing `AuthorityRequest` shapes plus persisted `created_at`/`updated_at`, visible only to requester or parent subject, including for OWNER callers. Existing lifecycle semantics remain unchanged.
- `activity`: latest 200 persisted audit events, using the same safe field projection as `/v1/audit`. Owners see their organization; other principals see their own events. `activity_truncated` indicates omitted earlier rows.
- `receipts`: latest 100 completed canonical purchase receipts. Owners see their organization; other principals see their own receipts. `receipts_truncated` indicates omitted earlier rows. No supplier storage rows are exposed.
- `visibility`: `grants` (`organization` or `held_or_issued`), `descendants_complete`, `requests:"parties_only"`, `activity` (`organization` or `caller_only`), and the two truncation booleans above.
- `snapshot_at`: server timestamp. Reads are transactionally consistent. Persistence failures fail closed.

The browser console exposes `/connect`, `/console`, `/console.js`, `/console.css`, and
`/console-api/*`. These are separate from `/mcp` and the private authority routes.
`POST /console-api/session` accepts only `{credential}` and verifies `/v1/me` plus an
actual MCP `get_my_grants` call with matching principal and organization. It sets an
opaque HttpOnly, SameSite=Strict cookie (Secure over HTTPS). The bearer credential
stays in a bounded, one-hour, process-local server session. Every subsequent read or
write reauthenticates through the authority service. `/console-api/logout` destroys
that session. All POSTs require the exact configured Origin and JSON content type.

`GET /console-api/config` supplies the public MCP URL and OAuth configuration status.
`GET /console-api/snapshot` proxies only `/v1/console`. The write proxy allowlist is
limited to existing create-request/respond/accept/revoke endpoints under
`/console-api/v1/…`; it cannot execute purchases, delegate root authority, select a
caller, or forward arbitrary URLs. Existing service schemas and permission checks
remain authoritative. Query parameters are rejected; request bodies are bounded to
32 KiB. Errors retain machine-readable status/code/reason.


## Trusted provisioning extension (existing shared contract types unchanged)

`POST /v1/grants/:id/provision-child` authenticates the existing parent bearer key.
The strict JSON input is `{scope: AuthorityScope, credential_hash: string,
idempotency_key: string}`. `credential_hash` is a lowercase SHA-256 hex verifier
of a 256-bit secret generated and retained by the trusted child runtime. A raw
secret, claimed principal ID, organization, kind, or role is never an input.

The server verifies the parent owns a live grant/ancestor chain, requires subset
scope and decremented delegation depth, and bounds the new per-action/total limits
by the effective remaining ancestor budget including reservations. It creates a
random child principal ID in that organization with fixed `kind:AGENT` and
`role:SERVICE`, registers the verifier, issues through the canonical grant engine,
and records the idempotency binding and audit events in one transaction.

The response is `{status:"OK",data:{principal:Principal,grant:Grant}}`. No raw
credential, credential verifier, or private provisioning record is returned.
Failures use existing machine-readable errors (`INVALID_CALLER`,
`OUTSIDE_PARENT_SCOPE`, `BUDGET_EXCEEDED`, `GRANT_EXPIRED`, `GRANT_REVOKED`,
`ALREADY_EXECUTED`, `INVALID_REQUEST`, or `SERVICE_UNAVAILABLE`).

Idempotency is scoped to authenticated parent principal plus key and bound to
parent grant, exact validated scope, and verifier. Identical retries return the
same child/grant only while authority and credential remain live. Changed input
returns `ALREADY_EXECUTED` without creating another identity. An already registered
verifier cannot be rebound to another child. Creating grants does not create an
independent budget pool; executions still debit the shared ancestor ledger.

The child key is bound to the initially issued grant in private
`child_provisionings`. Every authentication rechecks that complete chain.
Direct/ancestor revocation, expiry, inactive principals, or invalid authority make
the key return `INVALID_CALLER`; database errors fail closed. Later accepted grants
do not extend the original credential lifetime. Seeded existing keys keep their
existing behavior. The console proxy does not expose provisioning; agents use the
MCP tool or the authenticated service API.

## Workflow inspection read model

`GET /v1/workflows/:root_grant_id` and MCP `get_workflow` are read-only. The caller
must be in the grant's organization and be its subject, issuer, or organization
owner. Missing and inaccessible roots return the same `INVALID_REQUEST` response.
The response includes the root and same-organization descendants, current effective
budgets, committed/reserved ledger totals, and historical audit decisions and
completed simulated receipts whose grant belongs to that branch. Activity and
receipts from sibling branches are excluded, even for the same principal.
Negotiations retain the existing requester/parent visibility rule; ancestor status
does not reveal another pair's private request. Inspection grants no execution
permission and can display revoked or expired grants to a still-authenticated
caller. Activity is capped at 500 and receipts at 100, with truncation flags.

The optional console proxies `/console-api/workflows/:id`. A successful MCP
`get_workflow` may include a one-use dashboard link in UI-only `_meta.dashboard_url`.
Redeeming it at `/console-api/open/:ticket` sets a new opaque HttpOnly cookie and
redirects to `/console#workflow=:id`. Links expire after one minute; browser sessions
after fifteen minutes. These sessions can read only the selected workflow and cannot
perform writes. Every data read reauthenticates the original caller. Neither a link
nor a browser session extends the underlying credential or grant lifetime.
