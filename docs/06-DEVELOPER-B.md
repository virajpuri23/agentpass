# Developer B Brief — Real Agents, Supplier Boundary, Live Demo

**You own:** `apps/buyer-agent/**`, `apps/sourcing-agent/**`, `apps/supplier/**`, `apps/dashboard/**`, `scripts/**`, supplier fixtures.  
**You do not own:** authority policy engine, grant persistence, MCP tool definitions.

## Your mission

Prove why an **agent** would use AgentPass. Make two autonomous processes interact and show the supplier independently protecting proprietary information. Build your half against the frozen contract with local mock responses; do not wait for Developer A.

## Concrete deliverables (in order)

### B1. Private supplier service

- TypeScript service on `SUPPLIER_PORT=4200` with independent storage.
- Private catalog: `PACK-500`, 500 units, public total quote $850, private internal cost/margin never returned.
- `POST /internal/quote`, `GET /internal/quotes/:id`, `POST /internal/fulfill` authenticated service-to-service.
- Seller `supplier_policy` returns ALLOW for quotes/purchases meeting its rules, DENY for `supplier.margin.read`.
- Quote includes quote ID, trustworthy unit/total amount, quantity, supplier, SKU and expiry.
- Order endpoint is idempotent using `request_id`; same request cannot fulfill twice.
- Supplier should have its own identity and at least one agent/worker to formulate a quote response; seller backend remains source of truth for numbers.

### B2. Distinct buyer and sourcing agent workers

- Buyer agent has root grant and can instantiate a distinct sourcing-agent process.
- Child has **its own** API key and agent session—never receives parent's key.
- Child uses MCP tools to get quote, then attempts purchase and handles `AUTHORITY_REQUIRED` by calling `request_authority`.
- Parent agent evaluates requested scope and returns a narrower $900 counteroffer, never wider than its own grant.
- Child accepts and resumes with grant. Child cannot call admin/parent operations under its identity.
- Use an LLM-driven MCP client for at least the main request/recovery decision if available; also provide a deterministic command-line runner as reliable backup. Accurately label which path is model-driven in the live demo.

### B3. Agent-to-agent messages (optional P1)

Implement a minimal transport interface:

```ts
interface AgentMessageTransport {
  send(to: string, message: unknown, correlationId: string): Promise<void>;
  waitForReply(correlationId: string, timeoutMs: number): Promise<unknown>;
}
```

- P0 uses local/in-memory or poll-based message exchange.
- P1 uses Primitive identity/inbox/email and verified webhooks, if credentials and time permit.
- **Never** grant authority solely because a message says it was sent by `buyer-agent`; AgentPass authorization must still authenticate the principal.

### B4. Activity view and live story

One screen only:

- Left: Buyer Agent → Sourcing Agent → Supplier Agent diagram.
- Center: timeline showing `QUOTE_ALLOWED`, `AUTHORITY_REQUIRED`, `REQUESTED`, `COUNTEROFFERED`, `GRANTED`, `ORDER_COMPLETED`, `SELLER_POLICY_DENIED`, `GRANT_REVOKED`.
- Right: grant boundary ($1000 root; $900 child; $850 completed); restricted supplier data panel with "private — blocked" rather than revealing the value.
- Read all activity from real audit events; do not fabricate successful transactions in the UI.
- Screenshots optional; spend first hours making the headless story work.

### B5. End-to-end runner

`npm run demo:reset` restores scenario. `npm run demo:run` executes:

1. Root grant visible only to buyer.
2. Buyer delegates quote-only grant to sourcing child.
3. Sourcing asks supplier for quote, gets $850 for 500 units.
4. Sourcing attempts purchase, receives permission recovery hint.
5. Child asks for $1200; parent counters with $900; child accepts.
6. Purchase completes via authority gateway and supplier service.
7. Margin query denied by seller policy, no leaked numeric cost.
8. Attempted overspend / expanded authority denied.
9. Parent revokes grant; subsequent attempt denied.

Output a compact timestamped trace and a final assertion summary; exit nonzero if mandatory steps fail.

## Your integration contract with A

- Do not bypass A's `execute_action` gateway by allowing buyer agent to call supplier `/internal/fulfill` directly.
- Supplier backend only trusts `X-Service-Key` from configured authority backend.
- Buyer/child sessions authenticate to A using distinct agent keys.
- Seller generates quote price; source agent never supplies a trusted price field.
- Start against fixture mock responses in `fixtures/` and swap `AUTHORITY_BASE_URL` when A exposes real endpoints.

## Definition of done

- Three visibly independent principals with distinct runtime contexts.
- Private supplier cost fields absent from all buyer-visible responses.
- Automated flow works headlessly with real MCP calls and seller boundary.
- One working trace and safe failure demonstration.
- One button/script resets scenario for judges.

## Common traps

- An LLM conversation pretending to be multiple agents is not the same as separate principals with enforced authority.
- Don't let seller accept a self-reported buyer name without trusted AgentPass mediation.
- Do not add a generic arbitrary SQL/debug tool to the supplier MCP interface.
- Never hardcode 'allow' into demo script in place of invoking actual security logic.

## Handoff message you should send A after B1

> Supplier API is running on port 4200. Protected internal endpoints are /internal/quote, /internal/quotes/{id}, /internal/fulfill. Quote fixture is PACK-500 x500 = 85000 cents. Service key comes from env. Seller policy denies supplier.margin.read. Mock example response is committed. Next: real agents and the demo runner.
