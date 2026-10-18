# Headless agent-credential release status

> Historical implementation/verification record. Branch names, OAuth state and
> deployment IDs below apply to that milestone. For the consolidated inventory
> and latest documented handoff, see [experiences](25-EXPERIENCES.md) and
> [operations](26-OPERATIONS.md#current-oauth-sign-in-handoff).

Updated October 18, 2026 UTC (October 17, 2026 Pacific).

## Current state

**APPLICATION RELEASE:** PR #14 merged as `c7e0d3cd054ac47b55e5a397103de1ec09854d46`; the AgentPass MCP endpoint is [here](https://fast-steel-94x84.run.mcp-use.com/mcp). The application source matches tested revision `e61f958`; later documentation-only revisions do not change that application source.

**HOSTED VERIFICATION DEPLOYMENTS:** initial provisioning/no-purchase checks ran on `7923e871-f0ac-4bf9-9579-ccb2695b967d`; after-restart identity/revocation checks ran on `4421a18e-49e8-4946-bd73-cd0300800350`. Both ran application revision `c7e0d3cd054ac47b55e5a397103de1ec09854d46`. These IDs identify verification runs, not a promise about the active deployment after this documentation update; consult the Manufact dashboard for the current runtime.

**LOCAL CHECKS PASSED:** 199 root tests and a separate 201-test run passed. TypeScript checks and the nested MCP production build also passed. These checks establish code behavior and buildability, not live human OAuth or Developer B worker readiness.

**HOSTED PROVISIONING / NO-PURCHASE PHASE PASSED:** on deployment `7923e871-f0ac-4bf9-9579-ccb2695b967d` at merged revision `c7e0d3cd054ac47b55e5a397103de1ec09854d46`, the verified service-agent flow provisioned and authenticated a child and grandchild with their own credentials. Exact replay returned the same result; a changed request replay was denied. A permitted supplier quote succeeded. Purchase, foreign-principal access, margin access and scope widening were denied. A zero-budget authority request, parent counteroffer and grandchild acceptance completed without increasing spend.

Purchases remained at 8, ledger entries at 20, the root's remaining budget at 4,120 cents, and each demo allocation at 15,000 cents. These values were unchanged by this verification. The exact purchase and ledger SHA-256 fingerprints also remained unchanged; no purchase was executed. An independent review ran both CLI subprocesses with their own child/grandchild credentials even when the parent `AGENT_API_KEY` was inherited, and verified each database credential hash matched its private credential file. It correlated 12 fixture audit events; the authority request is `ACCEPTED`.

**AFTER-RESTART IDENTITY / REVOCATION PHASE PASSED:** on deployment `4421a18e-49e8-4946-bd73-cd0300800350` at the same merged revision, child and grandchild identities authenticated with their own keys after restart, before cleanup. The fixture parent then revoked child grant `4d2609ec-f2a0-4d57-89f9-b66bf64ccf8a`. Both child and grandchild CLI onboarding returned `INVALID_CREDENTIAL`, even with the parent `AGENT_API_KEY` in the environment. Purchases, ledger entries, root usage and demo allocations remained unchanged.

**FINAL INDEPENDENT AUDIT / CLEANUP PASSED:** an independent reviewer confirmed both actual child and grandchild CLI processes returned `INVALID_CREDENTIAL` after the child grant was revoked, even though the parent credential remained in each process environment. The child grant was revoked at `2026-10-18T01:35:07.599Z`. Thirteen persisted audit events include `grant.revoke`; the database credential hashes matched the private credential files before cleanup. Purchase and ledger SHA-256 fingerprints, purchase count (8), ledger count (20), root remaining budget (4,120 cents), and each demo allocation (15,000 cents) remained unchanged. No purchase was executed and no rollback was tested.

Fixture cleanup is complete: the private fixture credential directory and local state were removed; revoked hosted records remain for audit. Both local test databases were dropped.

## What the deployed headless path supports

An already authenticated service agent can provision a child without a person or browser when it has a live parent grant with delegation depth remaining. The authenticated parent calls `provision_child`; the authority service binds the request to that principal and checks that the child grant stays within the parent's actions, supplier and SKU lists, per-action limit, total budget, expiration, remaining ancestor budget, and delegation depth. It creates a distinct `AGENT` / `SERVICE` principal and child grant in the parent's organization. Replays must use the same idempotency key and identical request.

The trusted runtime generates the child's high-entropy credential locally and stores it in a private file outside the repository. Only the SHA-256 verifier is sent to AgentPass; the raw child secret is not returned by MCP or stored in the database. The child authenticates with its own credential. `agent:onboard` performs read-only MCP inspection and does not create identity or authority. The UI remains optional inspection.

Provisioning creates identity, credential-hash and grant records. It does not call the supplier or execute a purchase. Protected purchases remain simulated and are constrained by the shared ancestor budget. The hosted phase above checked this boundary: quote access worked, purchase execution was denied, and purchase/ledger/budget figures stayed unchanged.

Hosted fixture identifiers: child principal `agent-bdf8ef75-549f-452f-af6b-c4cd99684c76` with child grant `4d2609ec-f2a0-4d57-89f9-b66bf64ccf8a`; grandchild principal `agent-b03ca206-b319-4ae1-aafa-ffe715c0363f` with grandchild grant `934b656e-acbb-4721-bc28-69b30bddd6cf`; accepted grant `2a01c125-e22e-465e-a567-379d5baa5235`; authority request `4376b301-8cf5-4d47-9946-3140909f0495`.

See [trusted child provisioning](16-CHILD-PROVISIONING.md) for CLI inputs, credential-file protections, retry behavior and local evidence. See [the A9–A16 plan](17-SELF-SERVICE-ONBOARDING-PLAN.md) and [B runner handoff](20-DEVELOPER-B-RUNNER-HANDOFF.md) for ownership boundaries.

## Explicit release boundaries

- **Human OAuth is disabled.** Supabase OAuth server is OFF, the custom access-token hook is DISABLED, the Site URL is restored to `http://localhost:3000`, and a prepared confidential client is inactive. No human login, refresh, reconnect, cross-host isolation or consent journey is claimed as verified.
- The deployed service-agent flow requires an existing authenticated agent credential and delegable grant. It does not onboard an uncredentialed person, establish a human identity, or replace explicit human consent.
- Developer B's worker/runtime is deferred by the user. No B worker, model execution or sandbox is claimed as part of this release.
- The prior Manufact preview rollout remains paused under the current plan. The running production deployment does not mean a preview or separate staging data plane exists.
- A11/A12 human-host acceptance and full A16 readiness remain open. Local fixtures, hosted migrations/Vault checks, and the passed agent-credential provisioning phase are separate evidence from real OAuth and cross-host journeys.
- Hosted verification deployment `4421a18e-49e8-4946-bd73-cd0300800350` passed the post-restart identity/revocation phase and final independent negative-CLI/database-audit review. Fixture credential cleanup is complete; revoked hosted records remain for audit. This verification ID is not a current-active-deployment assertion.
- A14/A15 remain incomplete: real runner delivery/recovery and integration with Developer B's worker are not established by the service-agent provisioning phase. A16 remains open; deployment readiness is not full OAuth or cross-host acceptance.

The prior [rollout record](21-SELF-SERVICE-ROLLOUT.md) preserves the October 17 schema, Vault and preview evidence. Its deployment/configuration snapshot predates this merge; this document is the current release-status reference.
