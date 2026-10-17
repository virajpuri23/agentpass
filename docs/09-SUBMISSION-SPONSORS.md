# Sponsor Prize Strategy and Submission Copy

Based on the event description supplied by the team. **Actual prize eligibility is governed by the sponsor judges; simply using an integration does not guarantee eligibility.**

## Prize-track targeting

| Track | How AgentPass fits | Concrete qualifying evidence | Priority |
|---|---|---|---|
| **Manufact: Best MCP Server** | Agents use authorization as a headless MCP-native service | Live `tools/list`, `request_authority`, `execute_action`; ideally Manufact deployed URL | **P0/P1 critical** |
| **Armature: Agent Experience (AX)** | Machines request missing authority without human intervention | Typed tools, concise `AUTHORITY_REQUIRED`, guided next action, successful resume | **P0 critical** |
| **Primitive: Best Agent Communication** | Parent and child / buyer and seller exchange scope requests/counteroffers async | Real Primitive identities, message thread and replies correlated to request IDs | **P1 high** |
| **Inkbox: identity, A2A, communications** | Persistent independent agent identity and cross-company messaging | Real verified Inkbox identity + A2A communication, if integrated | P1 optional |
| **Stripe: agent commerce** | Controlled autonomous purchasing within budget | End-to-end Stripe test-mode purchase/authorization if feasible; simulated purchase alone is weaker evidence | P1 optional |
| **Blaxel: Something a Human Would Never Want** | Short-lived recursive agent authority/automated scope negotiation | Multiple ephemeral agent actions and denied privilege escalation at machine speed | P0 story; technical integration optional |
| **Insforge: agent-native cloud** | Persistent authority/agent state on agent-native backend | Actual Insforge backend integration and logs | P1 optional |

**Aim at Manufact + Armature first.** Add Primitive only when golden path is stable. Avoid building three different messaging connectors while the core purchase is failing.

## Prize-relevant live proof checklist

- [ ] MCP tools used by actual external agent client(s), not `curl` only.
- [ ] Agent sees `AUTHORITY_REQUIRED`, requests/accepts an offer and continues autonomously.
- [ ] Parent and child have separate authenticated sessions/keys.
- [ ] Supplier has own private data and policy boundary.
- [ ] Denial after revocation demonstrated.
- [ ] If claiming Primitive: show real API-generated messages/replies.
- [ ] If claiming Stripe: show real test-mode API records; do not portray simulated settlement as Stripe.
- [ ] If claiming Manufact: show deployed endpoint and real request in monitoring.

## Submission title

**AgentPass — Permission Negotiation for Autonomous Agents**

## Submission one-liner

**Agents can ask for, negotiate, delegate and verify the exact authority they need to work with other agents—without inheriting unrestricted credentials.**

## Submission description (copy/paste)

Agents are starting to spawn subagents and collaborate with other companies' AI systems, but traditional authentication doesn't tell an independent agent what another agent is truly allowed to do. AgentPass is an MCP-native authority layer that turns "permission denied" into a structured, recoverable negotiation. A child agent requests task-specific authority, a parent counteroffers a narrower grant, and the child resumes with revocable access enforced at execution time. We demonstrate a purchasing agent spawning a sourcing agent that interacts with an independent supplier agent. The sourcing agent gets a legitimate quote, negotiates a bounded purchasing grant, completes a simulated order, and is blocked from overspending or accessing supplier-private cost data. Each action has an audit receipt, and revocation immediately cuts off future use. This is designed for machines that collaborate and spawn workers dynamically—not another human permissions dashboard.

## Sponsor source notes / verified docs

- Official MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/ (stable server package `@modelcontextprotocol/server`).
- Manufact deploy: https://docs.manufact.com/cli/deploy (`mcp-use deploy`, `--no-github` supported).
- Primitive docs: https://docs.primitive.dev/docs (HTTP v1 API, managed agent email identities, send/receive, hosted Functions).

Consult official docs again during integration; endpoints and requirements can change. Do not assert any sponsor integration was completed before actually testing it.
