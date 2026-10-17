# AgentPass — YC Make Something Agents Want, October 17–18, 2026

> **Status: hackathon implementation specification, not a completed app.**
> **Submission:** Sunday October 18, 2026, **10:00 AM Pacific**. Everything here is designed to be put in a Git repository and shared with two developers.

## The 20-second pitch

Agents increasingly spawn subagents and collaborate with other organizations' agents. They can talk over A2A / messaging and use tools through MCP, but still need to establish **what they are allowed to do on someone else's behalf**. AgentPass adds agent-native scoped authority requests, counteroffers, delegation, enforcement, revocation and auditable execution.

**Demo:** A buyer agent delegates quote-only access to a sourcing subagent. The subagent talks to a supplier company's agent whose inventory and margins remain private. When a purchase requires more authority, the subagent requests a narrowly scoped grant from its parent, uses it to buy 500 sample units for $850, and is blocked when trying to exceed budget or read margins. The owner revokes authority; subsequent operations fail.

All purchases are **simulated**. No live inventory or payment is touched.

## Start here

1. Read [`PRD.md`](PRD.md) — scope and acceptance criteria.
2. Read [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) and [`docs/02-API-CONTRACTS.md`](docs/02-API-CONTRACTS.md) — immutable integration boundary.
3. **Developer A:** Follow [`docs/05-DEVELOPER-A.md`](docs/05-DEVELOPER-A.md).
4. **Developer B:** Follow [`docs/06-DEVELOPER-B.md`](docs/06-DEVELOPER-B.md).
5. Use [`TASKS.md`](TASKS.md) for ownership, merge sequence, and checkpoints.
6. Test from [`docs/07-TEST-PLAN.md`](docs/07-TEST-PLAN.md); rehearse [`docs/08-DEMO-RUNBOOK.md`](docs/08-DEMO-RUNBOOK.md).
7. Use [`docs/09-SUBMISSION-SPONSORS.md`](docs/09-SUBMISSION-SPONSORS.md) for the prize-track strategy.

`AGENTS.md` has repository instructions for Codex/other coding agents. `contracts/` provides wire examples; `packages/contracts/src/index.ts` defines stable shared types. `db/schema.sql` is a SQLite-oriented starting schema, **not a production-ready migration**.

## Scope promise

**P0: demo a real agent-to-agent, cross-organization authorization flow** with authenticated agent identities, parent-child grants, merchant-side independent policy, safe simulated execution, and structured failures.

**P1: optional:** Primitive asynchronous messaging, Manufact deployment, UI, cryptographically signed transferable capabilities, Stripe test-mode payments. Do not risk P0 for P1.

## Canonical technical decisions

- TypeScript / Node 20+ monorepo; SQLite local for an integration-proof MVP.
- Separate **AgentPass authority service** and **Supplier Company service**. Supplier secrets remain private.
- At least buyer agent, sourcing subagent, and supplier agent/process with distinct identities.
- HTTP JSON is the internal contract. MCP is the agent-facing adapter for authority operations.
- Independent supplier policy AND central authority enforcement must both allow an operation.
- Scoped, opaque grants validated online for P0; signed/offline-verifiable credentials are P1 only.
- API keys authenticate a caller at ingress; never accept `agent_id` passed in a tool argument as authentication.
- **No real-money payments**, no third-party production credentials, no actual confidential business records.

## Working vocabulary

- **Grant:** A revocable authorization from one principal to another, constrained by action, supplier, SKU, budget, and expiry.
- **Parent:** The grant whose authority bounds a descendant grant.
- **Principal:** A specific human or agent identity bound to authentication credentials.
- **Authority request:** A machine-readable request for additional scoped permission.
- **Counteroffer:** A narrower scope offered instead of a blanket approval.
- **Supplier policy:** The supplier's independent rule set; buyer-issued grants cannot override it.
- **Receipt:** A record of action, scope, decision, amount, outcome, and timestamp. In P0, this is an auditable database record, not a publicly verifiable cryptographic attestation.

## Local repo structure to implement

```text
agentpass/
  apps/
    authority/           # Developer A: HTTP API and persistence
    mcp/                 # Developer A: MCP wrapper around API
    buyer-agent/         # Developer B: parent agent runner
    sourcing-agent/      # Developer B: restricted child runner
    supplier/            # Developer B: isolated supplier API and agent
    dashboard/           # Developer B: optional activity UI
  packages/
    contracts/src/       # frozen interfaces (already provided here)
  db/schema.sql          # database starting point
  fixtures/              # deterministic scenario data
  docs/                  # full specification, checklists, demo plan
  scripts/
    seed-demo.ts
    run-e2e.ts
```

> **Important:** This kit supplies specifications, contracts, schema, fixtures, and repo coordination documents; it is **not** claiming the application is implemented or deployed.

## Implementation quickstart

Read [`docs/12-IMPLEMENTATION-QUICKSTART.md`](docs/12-IMPLEMENTATION-QUICKSTART.md) for first commands, API mock strategies, and MVP service startup scripts **to implement**. Machine-readable REST contract: [`contracts/agentpass.openapi.yaml`](contracts/agentpass.openapi.yaml).
