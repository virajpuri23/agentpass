# Ready-to-Paste Coding Agent Prompts

Use these separately in two Codex worktrees/branches. Supply the repo path and don't let one worker rewrite the other's implementation.

## Developer A / Codex prompt

> You are Developer A implementing AgentPass authority infrastructure for the YC hackathon. Read `AGENTS.md`, `PRD.md`, `docs/01-ARCHITECTURE.md`, `docs/02-API-CONTRACTS.md`, `docs/04-SECURITY.md`, `docs/05-DEVELOPER-A.md`, and `docs/07-TEST-PLAN.md` first. Implement ONLY `apps/authority/**`, `apps/mcp/**`, and `db/**` in branch `feat/authority-core`. Use shared types from `packages/contracts/src/index.ts` without changing the API contract. Implement authenticated agent principals, seeded root grant, subset-only delegation, pending scope requests with counteroffers, revocation, machine-readable permission failures, a protected gateway for quotes and simulated purchase, idempotent purchase receipts and atomic ancestor-budget enforcement. Expose the tools over MCP. Do not accept caller-supplied identity or prices as trusted data. Implement tests for spoofing, escalation, revocation, expiry, budget races and idempotency. Produce working commands and report exact test results. Do not work on frontend or supplier private data. Prioritize a passing golden path over optional features.

## Developer B / Codex prompt

> You are Developer B implementing AgentPass agent experience and supplier demo. Read `AGENTS.md`, `PRD.md`, `docs/01-ARCHITECTURE.md`, `docs/02-API-CONTRACTS.md`, `docs/04-SECURITY.md`, `docs/06-DEVELOPER-B.md`, and `docs/08-DEMO-RUNBOOK.md` first. Implement ONLY `apps/buyer-agent/**`, `apps/sourcing-agent/**`, `apps/supplier/**`, `apps/dashboard/**` and `scripts/**` in branch `feat/agent-demo`. Use shared types from `packages/contracts/src/index.ts` and frozen API payloads. Build an independent supplier service with private catalog costs not visible to buyers, trusted $850 quote for 500 PACK-500 units, seller policy that denies margin access, idempotent simulated orders. Build buyer and child agent processes with separate authenticated principals. Child follows actual MCP tool results: quote allowed; purchase denied for missing scope; request $1200; parent counteroffers $900; child accepts; authorized $850 purchase completes; unauthorized attempts fail. Use mocks matching fixtures until Developer A's API is ready. Create one-command reset/run demo and lightweight real-event timeline; prioritize headless demo first. Do not change authority business logic. Add positive and negative tests and report exact results. Primitive and UI polish are optional after integration.

## Integration coordinator prompt (after both branches)

> Act as integration lead for AgentPass. Read `TASKS.md`, `docs/02-API-CONTRACTS.md`, `docs/07-TEST-PLAN.md`. Merge authority and agent-demo without silently changing public JSON shapes. Wire services with environment variables and principal-specific credentials. Replace mock responses with real API calls. Run P0 tests and end-to-end scenario repeatedly. Fix integration issues within owners' directories. Produce a pass/fail matrix for F01–F07 and S01–S16, a README quickstart, and a reproducible demo reset/run command. Refuse to claim actual money movements or independent cryptographic verification. Only after the test matrix passes, add one sponsor integration.

## Tip: keep tasks narrow

If either coding agent gets stuck, instruct it to complete the next one testable milestone (for example, "make F03 and S01 pass") rather than generating an entire platform design again.
