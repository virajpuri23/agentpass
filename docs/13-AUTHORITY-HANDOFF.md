# Developer A implementation handoff

The frozen TypeScript contracts and HTTP routes are unchanged. `/v1/me` additionally includes `grants`, containing only the authenticated caller's grants; MCP `get_my_grants` uses this field. Authority request creation returns `data.request_id`; subsequent request reads use the contract's `id` field.

## Local setup

Use Node 20.19 or newer. From the repository root:

```sh
npm ci
cp .env.example .env
npm run seed:authority
```

The seed CLI provisions distinct random principal keys in the untracked `.env`; the database stores SHA-256 hashes. Seeding preserves existing grants, revocations, ledger entries, and keys. It does not reset the demo or renew an expired root grant. Use a new local database path for a clean run. Do not share the buyer or owner key with the sourcing agent.

Set `SUPPLIER_SERVICE_KEY` to the same separate random backend secret used by Developer B's supplier service. Configure `SUPPLIER_URL` and `AUTHORITY_DB_PATH` in `.env`, then run:

```sh
npm run dev:authority
```

Authority listens on loopback port 4100 by default. Configure `AUTHORITY_PORT` to override it. Health is public; `/v1/*` requires the bearer key. The seeded root grant is `grant-root-buyer` and lasts 24 hours from its first insertion.

For each MCP stdio process, configure `AUTHORITY_URL` and `AGENT_API_KEY` with only that agent's credential, then launch `tsx apps/mcp/src/server.ts` (or `npm run dev:mcp` with a locally configured `.env`). All nine documented tools are registered; no tool argument can select the authenticated identity.

## Supplier integration

Only the configured supplier service URL is used, with `X-Service-Key`, a five-second timeout, and redirects disabled. The authority never reads supplier storage. Required public response shapes (raw or wrapped as `{status:"OK",data:...}`):

- `POST /internal/policy/evaluate`: input `{principal_id, action, resource:{supplier_id,sku_id}}`; output `{decision:"ALLOW"|"DENY"}`.
- `POST /internal/quote`: contract `SupplierQuoteRequest`; output contract `SupplierQuote`.
- `GET /internal/quotes/:id`: contract `SupplierQuote`.
- `POST /internal/fulfill`: contract `SupplierFulfillRequest`; output `{order_id:string}`. It must return the same order for repeated `request_id`, including concurrent calls. Authority generates this stable request ID and reuses it for recovery.

Unknown response fields are excluded from quotes and receipts. Price override fields in agent requests are rejected. Amounts, quantity, resource, currency, and expiration are checked from trusted supplier quotes.

## Verification and limits

```sh
npm run typecheck
npm test
```

The gateway suite runs an independent HTTP supplier fixture. The security suite exercises real HTTP authority routes and SQLite. MCP tests use the official SDK client, including stdio discovery and calls. These are fixture-backed implementation proofs; integration with Developer B's supplier and autonomous agent runner remains a separate gate. `scripts/run-e2e.ts` belongs to Developer B and was not changed.

Purchase reservation is the authorization linearization point: the complete live chain, quote expiration, and shared ancestor budgets are checked in `BEGIN IMMEDIATE` before invoking fulfillment. Already reserved in-flight purchases may finish after a revocation; new purchases are blocked. Successful receipts are persisted and replayed unchanged. Uncertain supplier outcomes retain reservations and return `SERVICE_UNAVAILABLE`; retry the identical request/key to reconcile. If its grant or quote expires or is revoked before reconciliation, the normal agent retry remains denied. The fixture-only operator command below can record independently observed completed orders; live supplier reconciliation remains blocked on the read-only outcome primitive below. There is no automatic timeout release that could permit double spending.

No production payments, hosted persistence, sponsor integrations, frontend, or supplier private-data implementation is included.


## Audit fixes and operator recovery

Validated supplier `{status:"DENIED",code:"SELLER_POLICY_DENIED",reason:...}` responses on HTTP 403 or successful HTTP status are returned as a sanitized `DENIED` / `SELLER_POLICY_DENIED`, with `next_action:"contact_owner"`. Supplier reason text and additional fields are not forwarded. Bare 403, malformed envelopes, transport failures, and contradictory server-error responses remain `SERVICE_UNAVAILABLE`. An explicit policy denial alone does not prove absence of side effects: a purchase already reserved before fulfillment remains `PENDING` / `RESERVED`. No branch releases uncertain funds.

Consequential audit events use validated action and grant/request identifiers. Reservation and completion use the stable supplier fulfillment request ID; an identical retry denied after revocation retains that ID. Negotiation events share their authority request ID, including self-approval denials and issuance. Persisted trace IDs are generated on the server and reused from existing entity events within the same organization. Client-supplied trace headers do not establish correlation. Logs exclude bearer/service keys, raw bodies, supplier reason text, and private response fields. Another tenant's denied request lookup records the requested ID but does not disclose its parent grant.

For **local simulated fixtures only**, an operator with an active human OWNER key may reconcile a completed order from an independently maintained fixture SQLite database following the existing `db/supplier.sql` schema. Set `AUTHORITY_DB_PATH` to the existing authority database, `OWNER_API_KEY` through a private environment, and `AGENTPASS_FIXTURE_RECONCILIATION=1`, then run:

```sh
node --import tsx apps/authority/src/reconcile-fixture.ts \
  --fixture-supplier-db /absolute/path/to/supplier-fixture.sqlite \
  --purchase-id ORIGINAL_PURCHASE_REQUEST_ID
```

The command queries only public quote fields and order outcome fields from `quotes` and `orders`; it does not read catalog, costs or margins. It requires `orders.status='COMPLETED'`, and checks original request ID, quote ID, buyer identity on both quote and order, supplier/SKU, any requested quantity, original amount, owner organization, and the complete existing reserved ancestor ledger. It atomically commits the existing reservation and persists one immutable receipt. It makes no network calls and never invokes fulfillment. Completed replay is unchanged. Missing, rejected, contradictory or mismatched evidence is refused and funds stay reserved. There is no HTTP/MCP reconciliation tool, no agent-supplied order assertion, and no fixture mode on the normal purchase gateway. The trusted operator must choose the actual fixture database; arbitrary files are not proof for a live seller.

**Remaining Developer B contract dependency:** safe recovery against the actual seller requires a service-authenticated, read-only lookup of an immutable fulfillment outcome by the original authority-generated `request_id`, bound to buyer, quote, supplier/SKU, quantity, USD amount, and terminal completed order ID. It must never create an order, including under expired/revoked buyer authority. No such endpoint exists in the frozen API, so none was invented. The current fulfill response or an HTTP denial does not prove non-fulfillment and must not trigger a release. Any later agreed terminal non-fulfillment primitive also needs a guarantee that the original request cannot subsequently execute before reservation release is safe.

## Developer B workspace compatibility

Keep A's runtime dependencies, launch-time `.env` loading and canonical names (`AUTHORITY_URL`, `SUPPLIER_URL`, `BUYER_API_KEY`, `SOURCING_API_KEY`, `SUPPLIER_API_KEY`) when integrating the separate B workspace setup. Map B's proposed `*_BASE_URL` and `*_AGENT_API_KEY` names explicitly in B's adapter rather than silently replacing A's configuration. Do not select a replacement package manifest wholesale or default the integrated demo to fake authority. A preserves key hashes and root expiry on reseeding: a generator that rewrites `.env` or force-rotates keys must coordinate the database state or use a fresh isolated demo database. No B branch or files were modified for these fixes.
