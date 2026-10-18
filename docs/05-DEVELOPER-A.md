# Developer A Brief — Authority Core, Enforcement and MCP

**You own:** `apps/authority/**`, `apps/mcp/**`, `db/**` (unless otherwise agreed).  
**You do not own:** agent prompts, supplier catalog logic, public demo visualization.

## Planned follow-on: self-service onboarding

Follow [the Developer A implementation plan](17-SELF-SERVICE-ONBOARDING-PLAN.md)
for A9–A16: additive contract agreement, identity/membership persistence, OAuth,
personal workspace consent, conversational MCP tools, private delivery/runner
control, provenance/revocation, and real host verification. The plan distinguishes
the existing tested authority/provisioning core from missing self-service work.
Worker execution and dashboard changes remain Developer B's responsibility.
Do not change shared types without both developers' agreement or treat fixture
OAuth/runner tests as a completed hosted journey.

A9's [decision and contract pack](18-A9-ONBOARDING-CONTRACTS.md) is available with
executable fixtures. Its proposed paths/types are not production handlers or a
Developer B signoff. Continue independent A-owned work without changing B's files.

## Your mission

Build a reliable authority engine for distinct principals that can request, counteroffer, delegate, execute within, and revoke scoped permissions. Make it callable through MCP. Your API must be executable independently of Developer B using the fixture responses.

## Concrete deliverables (in order)

### A1. Auth and seed

- TypeScript Node backend listening on `AUTHORITY_PORT=4100`.
- `GET /health` responds immediately; authenticated `GET /v1/me` shows principal and org.
- Seed `buyer-co`, `supplier-co`, owner, buyer agent, sourcing agent, supplier agent.
- Unique random API key per agent and an admin-only seed path. Keys in `.env`, not repo.
- Unit test: passing `agent_id="owner-1"` cannot change authenticated sourcing identity.

### A2. Grant engine

- Seed root owner→buyer grant up to 100000 cents and allowed actions/sku/supplier.
- Direct delegation creates child grant only if subset of parent's effective scope.
- Handle actions, suppliers, SKU lists, expiry, per-action and total budgets, depth.
- `GET /v1/me` and `get_my_grants` returns only own grants.
- Revocation and ancestor-revocation propagation at evaluation time.

### A3. Permission negotiation

- Child files `authority_request` for `supplier.purchase.execute` up to $1200.
- Parent sees request, responds with $900 counteroffer that fits $1000 root.
- Child accepts and receives a grant. Revalidate scope/expiry at issuance.
- Provide `AUTHORITY_REQUIRED` with exact `required_scope`/`next_action` on quote-only purchase attempt.

### A4. Protected gateway and ledger

- `execute_action` calls supplier backend through allowlisted internal API.
- Quote request: policy allow → call supplier quote. Purchase: retrieve trusted quote from supplier using service credentials, validate grant + spend, reserve funds/execute simulated order idempotently, write receipt.
- Track shared ancestor budget consumption, not just leaf grant.
- On seller failure, leave safe pending state or release reservation; never return successful charge without seller confirmation.
- Unknown action or amount override: reject.

### A5. MCP tool adapter

- Use official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), or a Manufact `mcp-use` compatible scaffold if deployment simplicity warrants; do not maintain two divergent business-logic implementations.
- `registerTool` with Zod schemas; expose names defined in `docs/02-API-CONTRACTS.md`.
- Test tool discovery from Inspector / actual MCP client.
- Always authenticate calling principal via the MCP session's trusted configuration/authorization, not tool body.
- For demo P0, a configured per-agent stdio host is acceptable; for remote MCP, validate HTTP bearer credentials properly.

### A6. Tests and observability

- Grant subset negative tests (expansion in each dimension).
- Idempotency and budget-race tests.
- Audit events for request, counteroffer, issue, deny, execute, revoke.
- Tools return machine-readable concise envelopes and repair guidance.

## APIs you provide B first

**Mockable endpoints:**

1. `GET /health`
2. `GET /v1/me`
3. `POST /v1/grants/:id/delegate`
4. `POST /v1/authority/requests`
5. `POST /v1/authority/requests/:id/respond`
6. `POST /v1/authority/requests/:id/accept`
7. `POST /v1/actions/execute`

B can send you `POST /internal/quote`, `GET /internal/quotes/:id`, and `POST /internal/fulfill` behavior via fixtures immediately.

## Definition of done

- Child cannot claim to be parent.
- Child cannot enlarge quote-only grant.
- $1200 authority request counteroffered to $900, accepted.
- $850 authorized purchase uses trusted quote; receipt stable on replay.
- Further debit over remaining ancestor balance denied.
- Revocation denies future action.
- Full behavior can be invoked through registered MCP tools.

## Demo quality bar

Log structured events with fields `event_id`, `timestamp`, `principal_id`, `grant_id`, `action`, `decision`, `reason_code`, `request_id`, `trace_id`. No secrets in logs. Renderable through GET audit endpoint for the demo dashboard.

## Common traps

- Do not make each child budget independent of parent.
- Do not use `if(amount<limit)` on values supplied by the agent; use supplier quote amount.
- Do not expose an unauthenticated `approve` or `create_root_grant` MCP tool.
- Do not claim that signing a JSON blob alone solves issuer trust or revocation.
- Do not deploy ephemeral SQLite to Manufact while representing it as durable storage.

## Handoff message you should send B after A2

> Authority API is running on port 4100. Agent keys are provisioned in shared local `.env` (not committed). Available endpoints: /health, /v1/me, /v1/grants/{id}/delegate. Root fixture ID: grant-root-buyer. JSON contract v1 frozen. Sample curl and tests are in my branch. Next: request/offer flow and ledger.

## Self-service follow-on

Use [the A9–A16 plan](17-SELF-SERVICE-ONBOARDING-PLAN.md),
[accepted additive contract](18-A9-ONBOARDING-CONTRACTS.md),
[B runner handoff](20-DEVELOPER-B-RUNNER-HANDOFF.md), and
[current implementation/rollout status](21-SELF-SERVICE-ROLLOUT.md). The trusted
consent routes belong to authority; the optional B dashboard is not an onboarding
dependency. Keep real provider/worker/host gates open until actually verified.
