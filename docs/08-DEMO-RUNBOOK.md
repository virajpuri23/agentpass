# Judge Demo Runbook — 2:30 Minutes

**Goal:** Convey agent-native novelty, real cross-company trust boundary, and machine-recoverable permissions in a short live run.

## Setup before judges arrive

- [ ] Run demo reset and verify health of both services.
- [ ] Have the source tree, test results, and one complete trace available.
- [ ] Open MCP Inspector / tool call console, agent trace, and simple UI view if built.
- [ ] Ensure machine-readable responses show denied action, next step, counteroffer, receipt.
- [ ] Keep a recorded backup from a successful *real* run in case demo infrastructure fails; don't mislabel replay as live.
- [ ] Use simulated transactions only; no need for live bank/Stripe charge.

## Minute-by-minute script

**0:00–0:20 — Hook.**

> "MCP lets agents use tools and A2A lets them talk. But what happens when an agent needs permission from another agent, or from a different company? We built AgentPass so agents can request, negotiate and safely exercise temporary authority."

**0:20–0:45 — Spawn.**

> "Our buyer agent has a $1,000 purchasing budget. It spawns a sourcing subagent but delegates quote-only access—not the full purchasing credentials."

Show actual separate principals/processes and a quote-only grant.

**0:45–1:15 — Cross-company interaction.**

> "This supplier agent has private inventory and pricing information. The buyer's subagent requests a quote for 500 units. The supplier exposes an authorized $850 quote, not its internal costs."

Show quote from real seller server. Optional: supplier refuses attempted margin query.

**1:15–1:45 — Agent-native recovery/negotiation.**

> "The child now tries to buy. Instead of a dead-end Permission Denied, it receives machine-readable instructions for the exact authority it needs. It asks for $1,200, and its parent counters with $900. The child accepts and resumes."

Show `AUTHORITY_REQUIRED`, counteroffer, successful grant issuance.

**1:45–2:10 — Execute & enforce.**

> "The child uses its $900 grant to purchase the $850 quote. Our gateway checks both the buyer's delegation chain and the supplier's policy and records one receipt. Attempts to spend more are blocked."

Show receipt + budget update + over-limit denial.

**2:10–2:30 — Trust boundary and pitch.**

> "Now the buyer revokes the grant. Even with the old ID, the child can no longer act. AgentPass makes agent collaboration safe without shared credentials or permanent access."

Show revoked attempt failed.

## High-impact visual cues

1. Parent $1000 / child quote-only grant -> child purchase $900 grant -> executed $850.
2. Distinct principal identity bubbles with two company boundaries.
3. `AUTHORITY_REQUIRED` and `next_action:request_authority` payload.
4. Red `SELLER_POLICY_DENIED` for private margin.
5. Red `GRANT_REVOKED` after owner revokes.

## Judge likely questions and disciplined answers

**Q: Doesn't OAuth/Permit/Keycard already do agent permissions?**  
A: "Yes, pieces of identity, authorization and delegation already exist. Our prototype emphasizes machine-negotiable scope requests, recoverable permission failures and independent policies across interacting agents. We're testing whether that workflow is valuable enough to differentiate."

**Q: What do you mean by independently verifiable?**  
A: "Today, the supplier independently requests a decision from our online authority service and applies its own policy. Offline cryptographic verification is a future feature, not something we're claiming for this MVP."

**Q: Is that a real payment?**  
A: "It's simulated fulfillment and ledger authorization. We're focused on enforced agent delegation; production payments would use an actual PSP's test then live infrastructure."

**Q: Why would an agent want this?**  
A: "An agent that encounters a permission boundary can discover what's missing, request a narrow upgrade and resume automatically. The owner doesn't have to manually rewire tokens for each new subagent."

**Q: Why multiple independent agents?**  
A: "The source and destination are different principals. The supplier controls confidential systems and should not trust the buyer's tool instructions; we enforce two policy boundaries."

## Submission assets

- Project name / one-line pitch.
- Short problem/solution/why agent-native paragraph.
- 2–3 minute demo video, ideally with live tool-call event trace.
- Repo link and minimal README quickstart.
- Architecture diagram and sponsor-specific proof (MCP tool inspector screenshot / Primitive thread / etc.).
