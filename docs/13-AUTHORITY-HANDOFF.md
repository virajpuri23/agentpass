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

Purchase reservation is the authorization linearization point: the complete live chain, quote expiration, and shared ancestor budgets are checked in `BEGIN IMMEDIATE` before invoking fulfillment. Already reserved in-flight purchases may finish after a revocation; new purchases are blocked. Successful receipts are persisted and replayed unchanged. Uncertain supplier outcomes retain reservations and return `SERVICE_UNAVAILABLE`; retry the identical request/key to reconcile. If its grant or quote expires or is revoked before reconciliation, the reservation stays pending and requires operator reconciliation; there is no automatic timeout release that could permit double spending.

No production payments, hosted persistence, sponsor integrations, frontend, or supplier private-data implementation is included.
