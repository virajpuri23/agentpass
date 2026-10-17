# Product Requirements Document — AgentPass

**Version:** 1.0 hackathon freeze (Oct 17, 2026)  
**Team:** two developers  
**Deadline:** Oct 18, 2026, 10:00 AM Pacific  
**Product type:** Agent-native authority and permission negotiation infrastructure  
**Status:** Spec / build target

## 1. Executive summary

**AgentPass lets autonomous agents request, counteroffer, delegate, verify, and exercise temporary authority without inheriting unrestricted privileges.** It works for an agent spawning a child and for interactions between agents owned by different organizations.

An agent communication system answers "How do we communicate?" A tool framework answers "Which API can I call?" AgentPass answers **"On whose behalf can I perform this exact action, with what limits, and what happens if authority is insufficient?"**

**Positioning:** Not a marketplace, full OAuth replacement, payment processor, or generic workflow builder. The user of the MCP tools is the **agent**; owners set policy only at critical points.

## 2. Problem and users

**Primary user:** Autonomous parent and child agents coordinating tools and external services.  
**Economic buyer later:** Developers of agent applications, enterprise platforms, and companies enabling external agent-to-agent interactions.  
**Secondary user:** Human business owner controlling upstream authority.

### Problems

1. A child agent inherits a parent's powerful credentials when it needs only a subset.
2. A recipient agent cannot easily determine what the requesting agent is legitimately authorized to do.
3. A failed action says "permission denied" but does not tell the agent how to request safe additional authority.
4. Two companies want agents to transact without exposing internal datasets, broad API tokens or private models.
5. Owners need provable boundaries, budgets, expiry, revocation and receipts for consequential actions.

## 3. Hackathon objective / north-star demo

A **real** independent sourcing subagent receives *quote-only* authority from its parent, contacts an independent supplier company's service, gets a trusted quote, requests purchase authority, receives a narrower counteroffer, executes a simulated purchase for $850, gets a receipt, and is refused when it tries to exceed limits or access private margins. Revocation blocks later calls.

### Success is observable when

- Tool invocations are initiated by distinct agent clients/processes, not only dashboard buttons.
- Logs show the authenticated caller, grant chain, requested action, supplier policy decision and result.
- A changed, expired or revoked grant cannot authorize execution.
- Supplier retains its own private data and owns the final decision on what it reveals.
- Machine-readable rejection includes `code`, `reason`, `required_scope`, `next_action` where relevant.
- The full demo can be reset and rerun deterministically.

## 4. Concrete scenario and demo data

**Companies:** `buyer-co` (buyer) and `supplier-co` (independent seller).  
**Principals:** `owner-1`, `buyer-agent`, `sourcing-agent`, `supplier-agent`.  
**Product:** `PACK-500` (500 packaging units); supplier generates trusted quote of **$850 total**.  
**Confidential field:** `internal_unit_cost_cents` and pricing margins, never returned to buyer.  
**Root authority:** owner → buyer-agent, `supplier.quote.request` and `supplier.purchase.execute` up to $1,000, supplier `supplier-co`, expires within demo period.

### Golden path

1. Buyer agent creates a sourcing child (distinct principal) and delegates quote-only authority.
2. Sourcing agent calls supplier quote for `PACK-500`, quantity 500; gets $850 offer.
3. Sourcing agent attempts purchase with quote-only grant; receives `AUTHORITY_REQUIRED` and a self-service recovery hint.
4. Child requests $1,200 purchasing authority. Parent checks upstream limit ($1,000), **counteroffers $900** for `PACK-500` at `supplier-co`, expiring in 10 minutes.
5. Child accepts; AgentPass issues child purchase grant. No wider scope is issued.
6. Child calls protected purchase; authoritative quote price is loaded server-side; $850 simulated purchase succeeds. Single-use/ledger receipt returned.
7. Negative: child tries `supplier.margin.read` → supplier denies; tries $1,200 request → denied; parent revokes child grant → future purchase blocked.

Note: a denied $1,200 action may be simulated as a separate quote or explicit authorization check. Do **not** allow agent-provided prices to override the supplier's quote.

## 5. Requirements prioritized

### P0 — must have

| ID | Requirement | Acceptance evidence |
|---|---|---|
| P0-01 | Separate authenticated agent identities | Tool cannot act as another principal by passing its ID |
| P0-02 | Root and child grants with subset validation | Child cannot widen scope, spend, supplier, SKU, expiry or delegation depth |
| P0-03 | Dynamic authority request + counteroffer | Child sees a structured `AUTHORITY_REQUIRED`, requests scope, receives $900 offer |
| P0-04 | Online authority checks | Validate chain, subject, resource, expiry and revocation before every action |
| P0-05 | Supplier-owned private data and policy | Authorized quote succeeds; attempted margin read returns no private values |
| P0-06 | Simulated protected purchase | $850 executed using trusted quote + server-side enforcement |
| P0-07 | Shared budget and idempotency | Root/child balances never go negative; retries cannot double-spend |
| P0-08 | Audit events + receipt | Record approvals, denied access, execution, revocation |
| P0-09 | Real MCP tool exposure | External MCP client can list and call authority tools |
| P0-10 | Working demo runner | One documented command resets/executes golden + denial paths |

### P1 — prize-track optimizers, after P0

| ID | Feature | Notes |
|---|---|---|
| P1-01 | Primitive messaging | Real async permission request / response between independent agents |
| P1-02 | Manufact deployment | Public MCP endpoint with verified remote calls and observability |
| P1-03 | Activity dashboard | Live graph of principals, grants, requests and receipts |
| P1-04 | Stripe test-mode | Real sandbox payment intent *only if* a complete end-to-end safe flow works |
| P1-05 | Signed credentials | Ed25519, issuer public-key verification and signed intent proofs |
| P1-06 | Inkbox / Blaxel / Insforge | Only if they materially serve the demo, no superficial badge integration |

### Explicitly out of scope

Open marketplace, vendor discovery network, global reputation score, child/family controls, production-grade enterprise SSO, arbitrary policy language, on-chain settlement, financial escrow, real payments, training supplier-specific ML models, general A2A protocol implementation, full browser automation.

## 6. Agent experience requirements

Tools should make recovery deterministic. An insufficient-authority result resembles:

```json
{
  "status": "AUTHORITY_REQUIRED",
  "code": "INSUFFICIENT_SCOPE",
  "reason": "Current grant allows supplier.quote.request only",
  "required_scope": {
    "actions": ["supplier.purchase.execute"],
    "supplier_ids": ["supplier-co"],
    "sku_ids": ["PACK-500"],
    "max_per_action_cents": 85000,
    "total_budget_cents": 85000
  },
  "next_action": "request_authority"
}
```

- Structured results must be concise enough for agents; no long human prose on the hot path.
- Requests are resumable by ID. Retrying cannot create duplicate purchases.
- Expose a discovery tool listing supported actions/limitations.
- Agent must not need a browser for standard authority negotiation.

## 7. Trust boundary / safety goals

**Two independent policies:** buyer grants authorize the requester's side; seller policy controls seller-side disclosure and execution. A valid buyer grant **never** authorizes reading supplier margins. A delegated purchase credential **does not** grant access to source code, financial accounts or unspecified tools.

P0 uses centrally validated opaque grants, not independently cryptographically verifiable credentials. In marketing/demo, say “supplier checks AgentPass authority and its own policy,” not “trustless offline cryptographic verification.”

See [`docs/04-SECURITY.md`](docs/04-SECURITY.md) for safeguards and limits.

## 8. MVP success metrics

- **Completion:** golden path succeeds on 3 consecutive clean runs.
- **Safety:** every mandatory abuse-case test denies without leaking private data or changing balances.
- **AX:** child identifies the missing scope and resolves it with MCP calls, no human copy/paste.
- **Latency:** responsive demo (target under 2 seconds for policy checks locally; not a production SLA).
- **Audit:** every consequential decision appears in chronological trace.

## 9. User stories

- As a **parent agent**, I want to delegate quote-only access so a spawned worker cannot spend money.
- As a **child agent**, I want a structured permission request so I can safely unblock myself.
- As a **supplier agent**, I want to verify the caller's authority and enforce my company's data policy independently.
- As a **business owner**, I want to revoke delegated authority and stop future actions.
- As an **observer/judge**, I want to see real tool calls, the authorization chain, and convincing failure cases.

## 10. Definitions of done

- **Feature done:** typed contract implemented, tests and audit event emitted, error path documented.
- **Product done:** both dev branches merged, demo can reset, P0 acceptance tests pass, MCP tools listed externally, video recorded, submission completed before deadline.
- **Security caveat:** no claim of production security certification, independent public-key trust network, or real settlement.

## 11. Follow-on startup direction (not weekend scope)

First: agent-developer API, policy enforcement and cross-company access requests. Next: signed delegations, interoperable verifiers, independent audit receipts, real enterprise auth integrations. Later: consented, task-specific performance evidence and portable trust profiles. Do not defer MVP execution to pursue this roadmap.
