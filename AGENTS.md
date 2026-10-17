# Instructions for coding agents working in this repository

Read `README.md`, `PRD.md`, `docs/01-ARCHITECTURE.md`, `docs/02-API-CONTRACTS.md` and your role brief before editing code.

## Priority / invariants

1. **P0 golden path > sponsor integrations > aesthetics.** First working demo before optional work.
2. Never allow credentials, authority, approval or identity to come solely from model-generated fields. Bind agent identity to authenticated connection/service token.
3. Fail closed on database errors or incomplete/ambiguous authority. Do not expose supplier private margin data.
4. Every child grant is the intersection/subset of parent authority; no widening budget, supplier, SKU, action, expiration or delegation depth.
5. Every protected side effect rechecks authority and supplier policy, derives prices from authoritative quotes and uses idempotency + atomic ledger updates.
6. All payments and orders are simulated by default. No production secrets or customer data.
7. Return machine-readable outcomes: `status`, `code`, `reason`, `next_action`, `required_scope` if applicable.
8. Follow ownership in `TASKS.md`. Do not edit files owned by the other developer without coordinating first.
9. Maintain TypeScript contracts in `packages/contracts/src/index.ts` as the source of truth; changes require both developers to agree.
10. When implementing a feature, also add one positive and one negative integration test.

## Architecture discipline

- `apps/authority/`, `apps/mcp/` (Dev A): authority decisions, persistence, MCP.
- `apps/buyer-agent/`, `apps/sourcing-agent/`, `apps/supplier/`, `apps/dashboard/`, `scripts/run-e2e.ts` (Dev B).
- `packages/contracts/` immutable after the first integration checkpoint, except mutually agreed changes.
- Do not invent undocumented endpoints; see `docs/02-API-CONTRACTS.md`.
- All internal service URLs and API keys come from environment variables; `.env` must remain untracked.

## Coding agent task prompt expectations

Give the coding agent a scoped goal, file ownership, acceptance test(s), and a cutoff. Ask it to implement and run tests in its branch; do not ask it to rebuild everything from scratch.

## Integration gates

- Gate 1: mocked HTTP contract tests on both sides.
- Gate 2: `request_authority` → counteroffer → issued child grant.
- Gate 3: supplier quote + purchase via protected gateway + simulated ledger.
- Gate 4: full live agent demo + negative authorization tests.
