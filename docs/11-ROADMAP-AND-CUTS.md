# Roadmap, Cutline and Decision Log

## Ship this before any optional feature

- Agent identity bound to authenticated sessions.
- Quote-only child grant and valid supplier quote.
- Structured insufficient-authority recovery.
- Request + narrowed counteroffer + acceptance.
- One simulated purchase with authoritative quote/atomic shared budget.
- Private seller policy denial and revocation denial.
- Actual external MCP client invocation and repeatable run.

## Features to cut in order when late

1. Animated diagram and multi-page dashboard.
2. Stripe payment integration (unless already working).
3. Inkbox, Insforge, Blaxel SDK integrations.
4. Full agent directory / discovery search.
5. Ed25519 transferable credential signing.
6. Fancy LLM reasoning for every participant (retain distinct agent principals + actual MCP calls; clearly disclose deterministic fallback).
7. Primitive async messaging if unreliable (retain request IDs and local poll/resume semantics).

**Never cut:** identity binding, seller privacy boundary, parent-child subset checks, revocation checks, idempotent purchase, or a real MCP call.

## Product differentiation for judges

- Not a generic auth token minting service: **machine-readable negotiation + recovery**.
- Not an agent marketplace: works when a parent spawns a worker or two companies already have agents.
- Not a UI-first approval tool: agent can independently request and accept narrower authority.
- Not a payment wallet: limits data access, tool actions and future spend across multiple principals.

## Technical caveats that should be stated

- P0 is online authorization, not a portable offline cryptographic standard.
- A single common authority provider is a chosen trust dependency; multi-provider trust and key federation are later.
- Actual external organizational trust requires workload identity, tenant isolation, contract-level authorization and audit/compliance hardening.
- A single transaction receipt does not validate overall agent skill or justify a reputation score.

## After hackathon

**Weeks 1–4:** Pilot with one agent app that spawns subagents; add real credential binding, supplier integrations, stronger persistence, audit exports.  
**Months 2–3:** Cross-organization verifier SDK, machine-readable permission negotiation, approval provider plugins, expiring signed credentials, revocation service.  
**Later:** Consent-based performance receipts, narrow task-specific reliability scores, cross-service interoperability. Pursue these only after users demonstrate a need for cross-agent delegation.
