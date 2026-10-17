# Threat Model and Demo Security Rules

**Scope:** Hackathon prototype with simulated funds and catalog. This is not audited for production use.

## Assets and trust boundaries

| Asset | Owned by | Protection |
|---|---|---|
| Parent authority and purchasing budget | Buyer company | Root grant + ancestor constraints |
| Agent identities/API keys | Each agent/service | Per-principal keys, env config, no shared parent keys |
| Private inventory cost / margins | Supplier company | Private service DB; seller-side policy |
| Purchase quote and price | Supplier company | Trusted quote ID lookup; immutable price |
| Permission requests and approvals | Authority service | Authenticated requester/respondent; audit |
| Ledger/receipt | Authority service | Idempotency and atomic updates |

## P0 abuse cases and required defenses

1. **Child spoofs parent** by supplying `agent_id=buyer-agent`: ignore caller-provided identity; identify only from authenticated key.
2. **Child asks for stronger grant** (price, action, supplier, expiry, depth): enforce set/time/amount subset; reject excess.
3. **Buyer grant tries to reveal supplier margin**: supplier policy DENY, no private fields in response.
4. **Agent tampers with supplier price**: purchase loads amount from trusted `quote_id` via supplier service; caller-supplied total ignored/rejected.
5. **Grant revoked while request pending**: acceptance and execution both re-evaluate live ancestor chains.
6. **Expired grant**: deny after expiration at execution, even if quote is valid.
7. **Replay same purchase**: same idempotency key returns same receipt; must not charge twice.
8. **Concurrent siblings spend parent budget**: ancestor budgets charged atomically; total never exceeds root.
9. **Child approves its own request**: only authenticated parent grant subject can respond, owner can revoke.
10. **Attacker requests arbitrary action, URL or tool name**: static action allowlist; deny unknown or arbitrary URLs.
11. **Supplier service unavailable**: fail closed for spend; do not confirm a purchase on timeout.
12. **API key leak in model context/logs**: never print keys, redact Authorization header, use short-lived/sandbox credentials.

## Local demo authentication plan

- Generate unique random API keys for buyer, sourcing, supplier service, and admin, store in untracked `.env`.
- `Authorization: Bearer <agent-key>` maps to specific principal and organization.
- Backend `X-Service-Key` is separate from agent tokens; allow only internal supplier URLs.
- Apply supplier policy regardless of buyer-side grant evaluation.
- If the MCP host cannot forward client auth cleanly, serve a **separate configured endpoint per principal** or use stdio per agent; bind the configured principal on the server side, never take identity from a tool argument.

## Do not overclaim

- P0 grants are centrally validated online; **they are not cryptographically independently verifiable credentials**.
- P0 simulated payments are **not** payment settlement, escrow, card issuance, or production spending controls.
- A timestamped audit event is **not** a signed, independently attested reputation credential.
- Seller's independent private policy protects fields you intentionally do not expose; it is not a general guarantee against all prompt injection or data exfiltration.
- For real B2B deployment, replace demo API keys with verified workload identities, mTLS or short-lived tokens, centralized key management, explicit tenant isolation, revocation propagation and security review.

## Minimum unit/integration tests

See `docs/07-TEST-PLAN.md`. Never substitute mocked authorization outcomes for actual enforcement on the live purchase path.
