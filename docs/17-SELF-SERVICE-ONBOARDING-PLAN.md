# Self-service MCP onboarding — Developer A implementation plan

**Status:** planned; no implementation or deployment authorized by this document.
**Planning baseline:** October 17, 2026, commit `4620555` on
`codex/agent-onboarding`, [PR #11](https://github.com/virajpuri23/agentpass/pull/11).
**Goal:** a person connects AgentPass from ChatGPT, Claude, or another compatible
remote MCP host, signs in, authorizes a bounded connection, and provisions an agent
without copying credentials or entering organization/principal IDs.

This is a follow-on to the working authority demo, not a replacement for its P0
gates. Implement in small reviewable changes. Preserve the existing authority
engine, supplier policy, ledger, bearer clients and frozen scope contract.

## 1. What exists and what is missing

| Capability | Evidence at the planning baseline |
|---|---|
| Credential-bound principals and organizations | Implemented; opaque bearer keys resolve to persisted identity. |
| Scope, delegation, expiry, revocation and negotiation | Implemented through the canonical authority engine. |
| Protected supplier operations | Independent supplier policy, authoritative quotes, atomic ancestor reservations/debits and idempotent simulated receipts. |
| SQLite and PostgreSQL persistence | Implemented and integration-tested. Earlier core hosted evidence is in [14](14-MANUFACT-VERIFICATION.md); this plan does not reverify the active deployment. |
| MCP adapters | Current branch exposes ten tools, including `provision_child`; no OAuth account connection yet. |
| Headless onboarding and child provisioning | Implemented on PR #11; private runtime credential file, verifier-only registration, atomic creation and inherited revocation. See [16](16-CHILD-PROVISIONING.md). |
| Human inspection | Local console and embedded inspector verified; hosted console/OAuth remain unverified. See [15](15-AUTHORITY-CONSOLE.md). |
| Latest completed validation | 97 tests passed with SQLite and disposable local PostgreSQL; root/nested typechecks and MCP build passed. Separate real local simulated-supplier proof: provision, $850 purchase within $900, revoke. These are not live LLM worker or ChatGPT/Claude OAuth proofs. |
| Public self-service accounts | Missing: OAuth configuration, external identities, memberships, connection consent and automatic personal workspaces. |
| Hosted agents | Missing in this checkout: private runtime credential delivery, durable launch/control integration and an actual worker journey. A successful tool call does not launch a model by itself. |

PR #11 was not incorporated into `feat/authority-core` at planning time. Recheck
the remote before implementation. The target branch auto-deploys; do not merge a
schema-dependent change there before its rollout gate.

## 2. First-release scope and assumptions

- Support one compatible identity provider first; verify both ChatGPT and Claude
  against it. Use the installed `mcp-use` provider primitives after checking their
  exact types/version and current provider requirements. Do not build a new OAuth
  authorization server merely to avoid choosing a provider.
- Create one personal workspace for a new verified account. Company invitations,
  enterprise SSO and linking separate login identities are later work. The schema
  must still enforce membership correctly and tests must cover two organizations.
- A first human connection includes sign-in and explicit authorization. Subsequent
  work within that policy is unattended. The inspection dashboard stays optional.
- Treat ChatGPT/Claude as authorized clients, not as proof of the person's company
  or a unique subagent identity. Conversation IDs, editable profiles and tool fields
  are never authentication. The same person using the same AgentPass account can
  connect both clients without duplicating their workspace.
- Keep the existing supplier actions and USD-cent scope. No arbitrary tool
  dispatcher, real payments, customer data, new model provider integration or
  automatic nonzero purchase allocation is part of Developer A's first slice.
- Start with one fixed worker template supplied by Developer B. Developer A owns
  its durable provisioning/control boundary; an unavailable runner must not be
  reported as a running agent.

## 3. Ownership and coordination

| Area | Owner and boundary |
|---|---|
| Identity, memberships, consent, authority, audit, migrations | A: `apps/authority/**`, `db/**`. Minimal sign-in/consent routes may live here; do not edit B's dashboard to obtain a consent surface. |
| MCP OAuth ingress, onboarding tools and adapter tests | A: `apps/mcp/**`. Keep current stdio/remote callers compatible; coordinate any change outside A's owned paths. |
| CLI | A continues the existing `apps/cli/**` work; preserve service-agent onboarding and private-file behavior. |
| Worker prompts, model execution, sandbox/runner implementation | B: agent runtime paths, including `apps/buyer-agent/**` and `apps/sourcing-agent/**` when supplied. Do not create implementations in these paths unilaterally. |
| Supplier, dashboard, shared demo runner | B: `apps/supplier/**`, `apps/dashboard/**`, `scripts/run-e2e.ts`. A supplies fixtures/contracts and handoff documentation. |
| Public types and wire contracts | Both agree before changing `packages/contracts/**` or promoting proposals into [02](02-API-CONTRACTS.md). |

This document proposes work; it is not the other developer's agreement. Record the
contract decision and agreed runner boundary before implementation crosses them.
No message to the other developer is sent by creating this plan.

## 4. Identity and authority model

Reuse organizations, principals, grants, principal keys, ledger and receipts.
Proposed additions are logical records; finalize the smallest table layout in A9.

| Record | Required relationship/invariant |
|---|---|
| Account + external identity | Server ID; unique verified `(issuer, subject)`; never key identity by email. First-login uniqueness must hold under concurrency. |
| Membership | Unique account/organization, role, active status and organization-scoped human principal. A new personal workspace owner receives no membership in an existing company. |
| Connection | Stable ID, account, membership, organization, verified OAuth client, separate AGENT/SERVICE principal, consent/policy reference, lifecycle/revocation. Token refresh does not create a new connection or budget. |
| Consent/policy | Immutable approved scope/version, authorizing human, connection and timestamp. Reuse ordinary grants for enforcement; do not add a second policy engine. |
| Agent instance/provisioning request | Connection, requester account, parent grant, child principal/grant, task/template, scoped idempotency key and durable state. |
| Runtime delivery/job | Private secret reference, runner identity, launch idempotency, lease/attempt state and sanitized result. Secret material is not stored in model-visible records. |

The connection principal acts for the human; it does not inherit the human owner's
entire role. Resolve account, membership, connection, policy and principal from
verified credentials and persisted state on each sensitive operation. Do not fall
back to another workspace or a shared owner credential.

Bootstrap a new personal workspace through a trusted sign-in/consent path. An
owner may approve only the resources and ceilings allowed by the configured
service policy. Default to quote-only, zero-budget authority where resources are
available; an empty resource list grants no access. Nonzero simulated allocations
require an explicit persisted owner/admin authorization. Reconnect, refresh,
scope reduction and retry must never replenish an existing allocation.

New authority needs a trusted user consent event or existing administrator policy;
a model-supplied `approved:true` or a host's generic tool confirmation is not that
record. Bind consent to the authenticated human, exact connection, normalized
scope, expiry and one-use request state. Protect browser consent against CSRF and
replay. Widening/replacement allocations require new authorization; account sign-in
alone cannot mint them.

OAuth terminates at the AgentPass resource boundary. A9 must document how verified
connection identity reaches the canonical authority API. Prefer the same explicit
AgentPass logical resource/audience with verification at authority ingress as well
as MCP ingress; if the topology cannot support that, agree a short-lived,
audience-bound authenticated internal assertion. Never use a caller-controlled
principal header, an unverified token payload, a third-party-audience token, or an
all-powerful service key to impersonate arbitrary users. Connection identity must
remain bound to the provider's trusted authorization grant/context, not `sub` or
client display metadata alone when organization/connection selection is ambiguous.

## 5. Proposed interface and worker boundary

These are **unimplemented proposals**, not additions to the frozen v1 API. A9 must
agree exact names, schemas, pagination, error codes and authentication, then update
[02](02-API-CONTRACTS.md) and contract fixtures before handlers are written.

| Proposed MCP tool | Inputs | Output/authorization |
|---|---|---|
| `get_onboarding_context` | Empty | Safe profile/workspace/connection identifiers, current policy and next steps. Identity comes from verified auth. |
| `provision_agent` | Display name, bounded task, requested existing scope, allowlisted template, idempotency key | Provisioning/agent ID and safe state/effective authority; derive requester, organization, role and issuer server-side. |
| `list_agents` | Bounded cursor/page | Only agents visible through this membership/connection's permitted role. |
| `get_agent` | Agent ID | Safe provisioning/run state, grant and sanitized result; enforce ownership/visibility. |
| `revoke_agent` | Agent ID, reason, idempotency key | Persist authority revocation first, then request runner shutdown; repeated calls converge. |
| `revoke_connection` | Reason, idempotency key | Revoke only the authenticated connection and its dependent authority; derive its ID from verified context. |

Use the existing envelope: top-level `OK` means the operation was accepted, not
that a worker is ready. Put lifecycle in data. Proposed provisioning states:
`PENDING`, `PROVISIONING`, `READY`, `FAILED`, `REVOKED`. Track job execution
separately; a terminal task result does not imply unexpired authority. Preserve
existing grant/tool shapes; review any new shared status/code/type together.

The A-to-B runner contract must cover private job claim, lease/heartbeat, private
credential delivery, start acknowledgement, sanitized completion/failure and stop.
Specify authenticated runner identity, allowed template, exact agent/job binding,
retry/idempotency behavior and expiry. No model-facing endpoint returns a secret
or claim credential. Logs and error bodies exclude task secrets and provider claims.

For the hosted path, A's trusted provisioner generates the child secret, stores it
privately and uses the existing verifier-only child issuance logic. B's worker
receives only that child's credential. Task text never selects arbitrary code,
images, shell commands, secret references or privileged runtime configuration.
The initial bound child grant still limits the credential's lifetime; issuing a
subsequent negotiated grant does not renew that credential. Keep job/claim expiry
within its usable lifetime; rotation is outside the first slice.

## 6. Implementation sequence and acceptance gates

Each slice includes a positive and a negative integration test. A fixture provider
or runner can unblock local work but must be labeled FIXTURE. It cannot satisfy
the real provider/host/worker gates.

### A9 — Freeze the additive design and fixture contracts

**Reach:** this plan, [02](02-API-CONTRACTS.md), agreed shared types/fixtures,
provider and secret-store configuration inventory. Record decisions without secrets.

- Choose a provider supporting the required MCP discovery/client/PKCE flow and a
  private secret store available to the intended runner. Inspect installed exports.
- Inventory issuer/discovery/JWKS URLs, canonical MCP resource/audience, allowed
  clients/redirects, session/refresh limits, and runner/secret-store access. Record
  non-secret settings in the runbook; configure private values only through the
  deployment secret manager, never chat, model prompts or tracked files.
- Agree connection selection/binding, internal auth propagation, consent flow,
  user-visible state meanings, runner contract and initial policy limits with B.
- Identify the schema-only migration command and staging deployment path; today's
  `setup:postgres` also seeds demo principals and requires their keys.
- **Gate:** valid fixture lifecycle accepted by both sides; forged identity and
  widened-scope fixtures rejected. Contracts have recorded A/B agreement.
- **Cutoff:** no handler implementation against guessed endpoints, new shared
  types, fake OAuth or a runner B has not agreed to provide.

### A10 — Persist accounts, membership and connections

**Reach:** `db/**`, `apps/authority/**` and their integration fixtures/tests.

- Add ordered, additive migrations and a migration command independent of demo
  seeds. Preserve existing organizations, keys, grants, ledgers and receipts.
- Add uniqueness/foreign keys and transactional first-login creation. Use the
  private PostgreSQL schema with RLS and no public table policies/privileges.
- Implement canonical account/membership/connection resolution with fail-closed
  handling for inactive, ambiguous or unavailable state. Do not make public signup
  depend on four preseeded demo agent credentials.
- **Gate:** concurrent first sign-ins yield one account/workspace; two organizations
  remain isolated; reconnect preserves policy/usage; migration preserves baseline
  data on SQLite and disposable PostgreSQL. Existing bearer suites stay green.
- **Cutoff:** no hosted schema write, invitations, SSO, email-based account merging
  or generalized RBAC engine.

### A11 — Implement real OAuth ingress and connection binding

**Reach:** A's MCP/authority auth adapters, provider configuration docs and tests.

- Publish required protected-resource/authorization metadata and challenges through
  provider/framework primitives. Validate issuer, signature, intended audience,
  expiry, required scopes and persisted connection/membership on every request.
- Add verified request context and preserve the opaque service-agent path. Refresh
  retains connection identity; revoked connections cannot silently reconnect as
  another principal. Document canonical origins and allowed redirects.
- Provide explicit AgentPass connection revocation. A host disconnect is not proof
  that a provider notified AgentPass; document provider revocation/introspection
  support and the maximum accepted token lifetime instead of claiming immediate
  notification. Local connection/membership revocation must still apply immediately.
- **Gate:** fixture tests cover valid access, bad signature/issuer/audience/expiry,
  missing/inactive membership and database failure. Then one real configured login,
  refresh and revoked-access test passes with persisted identity correlation.
- **Cutoff:** if private provider configuration is unavailable, continue independent
  fixture work and report real OAuth as BLOCKED/UNVERIFIED; do not fake success.

### A12 — Implement personal workspace bootstrap and consent

**Reach:** authority-owned account/consent routes, grant bootstrap, persistence/tests.

- Create server-chosen personal workspace and human principal through verified
  onboarding; bind each approved assistant connection to a separate limited agent
  principal and ordinary authority grant.
- Implement minimal trusted consent, versioned approval, narrow defaults, finite
  limits, expiry, child-count/rate limits and safe retries. A disabled purchase
  policy is a denial, not an invented allocation. No automatic budget resets.
- **Gate:** a fresh person completes bootstrap without IDs/keys; model approval
  fields, cross-org selection, consent replay and concurrent reconnect cannot
  create privilege or duplicate allocations. Existing consent permits unattended
  work only within its approved limits.
- **Cutoff:** no company self-claim, invitation flow, dashboard redesign or public
  root-grant minting tool.

### A13 — Add the conversational MCP control tools

**Reach:** authority services/routes, MCP adapters, contracts agreed in A9 and tests.

- Implement the proposed onboarding/provision/list/get/revoke interface using the
  same service functions and `provision_child` enforcement. Limit task/name sizes,
  allowlist templates and scope, and bind idempotency to connection plus exact input.
- Return safe lifecycle metadata and actionable machine-readable denials. Ensure
  the trusted runtime, not model/tool arguments, generates credentials.
- **Gate:** a scoped connection creates/reads/revokes its own child; another caller
  cannot inspect it, forge requester/org/role, rebind a retry, or widen authority.
  All existing tools and headless CLI flows remain compatible.
- **Cutoff:** `PENDING` is not `READY`; missing runner/secret delivery cannot be
  described as a launched agent.

### A14 — Implement private delivery and durable runner control

**Reach:** A-owned provisioning/control modules, database outbox/jobs and tests;
B consumes the agreed contract without A modifying B's worker source.

- Persist a provisioning intent before external work. Create a private secret
  under a stable retry reference; issue the child via the existing atomic engine.
  Persist the child binding and launch outbox together; reconcile intermediate
  states across the external secret-store boundary without guessing success.
- Use authenticated, leased runner jobs. A retry must not create another child or
  worker; expired claims cannot fetch credentials. Reject late acknowledgements
  after revocation. `READY` requires the worker's own successful authenticated
  identity check, not merely a process/container start response.
- Revoke authority before cleanup/stop. Keep revoked status terminal. Reconcile
  failed delivery/launch, clean unattached secrets and bound retries/timeouts.
- **Gate:** inject failures after secret creation, grant issuance, job claim and
  worker launch; recover one logical child/job. Two runners cannot claim one active
  lease; revoked/expired authority cannot be delivered or marked ready. No secret
  occurs in HTTP/MCP output, `_meta`, console assets, audit or logs.
- **Cutoff:** use a fixture runner for A's independent gate. Actual model execution
  and sandbox implementation remain B's deliverable; cross-host enrollment and
  credential rotation are later work.

### A15 — Complete provenance, revocation and A/B integration

**Reach:** authority audit/auth/control paths, agreed audit types, A integration
tests; B owns the actual fixed-template worker and live demo runner.

- Persist authorizing human, verified connection/client, acting agent, parent grant,
  provisioning request and run correlations. Store necessary IDs, not full OAuth
  payloads, bearer tokens or unrestricted prompts.
- Membership/connection removal must revoke their bound grant tree transactionally
  and deny refresh/reuse under the old authorization. Checking DB membership once
  at login is insufficient. Stopping a worker is not the enforcement boundary.
- **Gate:** B's real worker receives only its child credential, identifies missing
  scope, negotiates through MCP, completes a permitted simulated operation and is
  denied immediately after relevant revocation/expiry. Verify both a parent and a
  descendant and correlate real audit/ledger rows with sanitized runtime events.
- **Cutoff:** A can finish fixture coverage independently, but cannot mark this
  integrated gate passed until B's actual runner works. No real payments.

### A16 — Verify both hosts and perform the staged rollout

**Reach:** A's runbook/evidence/configuration docs; coordinated deployment after
explicit rollout authorization. B supplies the worker deployment and UI handoff.

- Create disposable staging users, organizations, allocations and secrets. Test a
  new user in ChatGPT, the same account in Claude, and a second isolated person.
  Check host-specific metadata, registration, consent, refresh and reconnect.
- Run provision → worker authentication → permitted action → result inspection →
  revocation through each host. Reconnect must not reset usage. Test permission
  denial, supplier-private-data denial, concurrent budget enforcement and leakage.
- Capture exact commit, migration version, deployment/resource URL, provider setup
  (non-secret), user/connection/agent IDs, audit/receipt correlation and outcomes.
- Apply additive schema before compatible code; verify readiness/schema version,
  old bearer clients and rollback to previous code. Retain additive schema during
  rollback; do not delete historical identities, grants, keys or ledger evidence.
- **Gate:** all local checks, real provider, actual B worker, both real hosts and
  staging persistence tests pass. Review the exact revision before production.
- **Cutoff:** no production merge/deploy, provider configuration mutation, hosted
  migration or allocation reset as an incidental part of local implementation.

## 7. Developer B handoff and overall definition of done

A supplies the agreed wire fixtures, lifecycle semantics, authenticated private
runner protocol, child-only credential injection contract, revocation behavior,
sanitized event schema, test commands and exact staging MCP URL. B supplies the
fixed worker, its process/sandbox lifecycle and model-provider secrets in its own
runtime. An optional dashboard consumes the same safe APIs; it is not required
for onboarding or execution. No shared parent/owner key is configured for visitors.

Done means a fresh person can connect and authorize once, get a server-chosen
workspace, provision a real independently authenticated child, inspect its work,
and revoke it through either supported host; all protected effects remain bounded
by persisted authority and supplier policy. Tests must prove retries, restart
recovery, tenant isolation, no budget replenishment and no secret disclosure.

Use `PASSED`, `FAILED`, `BLOCKED`, `FIXTURE` and `UNVERIFIED` literally in handoffs.
The overall self-service feature is unfinished while real OAuth, the B worker or
either promised host journey remains unverified, even if A's independent slice is
complete. Re-run the original golden path; never trade its safety gates for signup.

## 8. Implementation documentation and sources

At each implemented slice update the canonical API/types only after agreement,
the A brief/workboard, test plan, configuration/runbook and evidence. Keep this
document's checklist/status synchronized without presenting planned capabilities
as shipped. Leave the original hackathon requirements/history intact.

Reference material reviewed during planning; recheck provider/framework behavior
when implementing against the installed version:

- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Claude remote MCP connections](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Existing provisioning protocol](16-CHILD-PROVISIONING.md)
- [Current console/OAuth limitations](15-AUTHORITY-CONSOLE.md)
