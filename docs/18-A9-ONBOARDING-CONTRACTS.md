# A9 — onboarding decisions and contract review pack

**Status: A-side draft implemented and tested; Developer B agreement pending.**
No proposed endpoint, OAuth login, migration or worker is implemented by this slice.
The frozen v1 API and `packages/contracts/src/index.ts` remain unchanged.

## Baseline and review artifacts

PR #11 was merged externally into `feat/authority-core` at `a808f16` before A9.
This work is isolated on `codex/onboarding-contracts`; production is not modified.
The earlier planning-doc commit was carried onto this branch because it was not
included in that merge. Reverify deployment provenance before any rollout.

- [Portable JSON Schema draft](../contracts/proposals/onboarding-v1.schema.json):
  definitions under `$defs`; review-only, not a deployed service contract.
- [Positive lifecycle fixture](../fixtures/onboarding-v1.proposal.json): FIXTURE,
  contains no bearer credential, represents a previously consented test allocation.
  Its $1,000 parent is not a new-user default.
- [Executable validators](../apps/authority/test/contracts/onboarding-proposal.ts):
  test-only, not imported by production code. Generated schema must match them.
- [Contract tests](../apps/authority/test/onboarding-contracts.test.ts): strict
  shape checks and a bridge to the actual existing child issuance/auth/revocation
  engine. They do not prove OAuth or worker execution.

## Decisions selected for the first integration

| Decision | A-side selection and reason |
|---|---|
| Identity provider | Auth0. Installed `mcp-use@2.8.2` exports `oauthAuth0Provider` from `mcp-use/oauth/auth0`; its verifier is issuer/JWKS/resource bound. No framework upgrade is assumed. Tenant/client setup is missing. |
| Client registration | Test the installed adapter's advertised DCR flow first, with PKCE S256 and Auth0 Resource Parameter Compatibility Profile. Approve/persist the actual clients; `clientInfo.name` is not identity. Do not invent CIMD support or enable unrestricted production registration as a side effect. |
| Canonical resource | One explicit HTTPS `MCP_PUBLIC_URL`, including `/mcp`, is the AgentPass logical OAuth resource/audience. Private authority API is a backend of that resource and independently verifies the same intended-resource token. Do not send it to supplier or runner services. |
| OAuth caller binding | Verified `(iss, sub)` resolves an account; verified client claim (`azp`, with conflicting client claims rejected) resolves an approved client. First release binds one connection per account/personal workspace/client. Refresh/reconnect returns the existing connection; revoked connections require trusted reauthorization, never automatic reactivation. No arbitrary workspace selection in tools. |
| Human vs machine | OAuth human onboarding rejects machine-to-machine bootstrap. Existing opaque agent bearer credentials remain separate. Provider roles/email/user-editable metadata do not establish AgentPass membership, owner role or grant limits. |
| Initial authority | Sign-in creates no spending allocation. Trusted consent approves quote-only, zero-budget access to configured explicit resources; consent cannot exceed service policy. A10/A12 enforce unique bootstrap and no allocation reset. |
| Hosted credential store | Supabase Vault in the existing dedicated AgentPass project, accessed only by the private provisioner/control backend. It stores authenticated ciphertext with a project-managed external key. No runner receives SQL access or a Vault reference. Availability, privileges and real encrypted storage are UNVERIFIED until A14. No plaintext fallback. |
| Local tests | Isolated in-memory credential delivery fixtures until a real Vault-enabled staging environment is available. Ordinary local PostgreSQL does not establish Vault compatibility. Never place real child secrets in tracked fixtures. |
| Execution boundary | One B-owned fixed template, `sourcing-v1`. A owns durable intent, issuance, private job delivery, readiness verification and revocation. B owns idempotent process/model launch and sandboxing. |
| Independent migration command | A10 will add `npm run db:migrate -- --target <sqlite|postgres>` (proposed, does not exist yet), using environment configuration and ordered migration records. It must not seed/demo-reset data, require four demo keys, print a DB URL, or run automatically on application startup. |

Auth0 requires its resource parameter compatibility setting for MCP resource
requests to resolve to the intended API audience; an otherwise valid userinfo
token must be rejected. See [Auth0 guidance](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile).
Vault's decrypted view requires strict SQL access control; encryption does not
authorize the reader. See [Vault documentation](https://supabase.com/docs/guides/database/vault).

The Supabase changelog index and current extension notices were checked for this
choice. A9 installs no extensions and uses no legacy pgcrypto PGP ciphers or custom
operators. A14 must verify the actual Vault extension and privileges; do not pin an
extension version based on an old example. No hosted database was queried or changed.

## Configuration inventory and missing setup

Only syntactically valid environment **names**, never values, were inspected in
the local private files. Existing `.env.manufact` lists `NODE_ENV`, `DATABASE_URL`,
`DATABASE_CA_CERT`, `SUPPLIER_DATABASE_URL`, `SUPPLIER_SERVICE_KEY`. This is not a
fresh inventory of the hosted secret manager or proof that Vault is enabled.

| Configuration | State / action before real integration |
|---|---|
| Auth0 issuer/domain, discovery/JWKS | MISSING locally. Configure `MCP_USE_OAUTH_AUTH0_DOMAIN`; normalize exact issuer and pin the canonical resource. |
| Canonical MCP resource | `MCP_PUBLIC_URL` is documented in `.env.example`, but not present in inspected private deployment file. Select the staging URL first; do not infer it from untrusted Host headers. |
| Audience alias | The installed adapter also understands `MCP_USE_OAUTH_AUTH0_AUDIENCE`; leave it unset when passing the explicit resource, or reject a mismatch. Never allow two independent audiences. |
| Approved OAuth clients/redirects | MISSING. Record verified ChatGPT/Claude registration identifiers and exact callback requirements through private provider administration. Proposed application allowlist name: `AGENTPASS_OAUTH_CLIENT_IDS`. No client credentials in the draft. |
| Token/refresh policy | Configure access token lifetime at most 10 minutes and refresh/revocation support. A11 verifies actual claims and rejects longer lifetimes; do not claim host disconnect instantly invalidates tokens without a provider notification. |
| Consent browser login | MISSING. A12 needs an allowlisted first-party OAuth client/session, HTTPS origin, callback and one-use CSRF-bound consent. A model-provided scope/approval alone cannot approve its own connection. |
| Vault access | UNVERIFIED. Restrict create/read/delete and decrypted-view access to the dedicated backend role; no PUBLIC/anon/authenticated/worker grants, no public Data API exposure. Use parameterized statements and prevent secret-bearing SQL parameters from reaching logs. |
| Runner identity | MISSING. Register runner credentials privately, store only hashes, and bind allowed organizations/templates server-side. No shared owner key or `runner_id` request override. |
| Runner API endpoint | Private HTTPS/control-network route, separate from model tools; exact staging URL is pending B's deployment. Ordinary bearer visitors cannot call it. |

No provider/secret-store account, permission, environment variable or deployment
was created/changed by A9. Private configuration can be supplied through the
deployment's secret manager when its integration stage is authorized.

## Proposed public interface

Every response uses the existing success/error envelope. `OK` on provisioning
means durable acceptance, not a running worker. Inputs reject unknown fields.
The JSON Schema bundle defines field shapes; this section defines enforcement.
None of these paths is implemented yet.

| MCP tool | Proposed authority HTTP path | Input definition | Success data definition |
|---|---|---|---|
| `get_onboarding_context` | `GET /v1/onboarding/context` | `context_request` (empty) | `context_data` |
| `provision_agent` | `POST /v1/agents` | `provision_request` | `agent_data` |
| `list_agents` | `GET /v1/agents` | `list_request` query | `list_data` |
| `get_agent` | `GET /v1/agents/:agent_id` | `get_request` | `agent_data` |
| `revoke_agent` | `POST /v1/agents/:agent_id/revoke` | `revoke_agent_request`; path ID removed from JSON body | `agent_data` with `state:REVOKED` |
| `revoke_connection` | `POST /v1/onboarding/connection/revoke` | `revoke_connection_request` | `revoke_connection_data` |

Tool inputs cannot choose organization, user/requester, role, principal, parent
grant, connection, credential, secret reference, container image or shell command.
The server resolves one active connection and its consented grant, clamps only by
denying outside scope (no silent widening), and uses existing `provision_child`.
No consent means context can be inspected but provisioning is denied. After
revocation, authentication is denied; context must not fall back to another account.

Membership scopes visibility to the personal workspace; a connection can manage
only its own agents in the first release. Cross-connection/company administration
is deferred. Unknown and unauthorized agent IDs have indistinguishable denials.
Do not leak another principal's record through list, cursor or idempotency lookup.

Use the existing denial codes: `INVALID_REQUEST` for bad shapes, `INVALID_CALLER`
for unauthorized records, `INSUFFICIENT_SCOPE` for missing consent/authority,
`OUTSIDE_PARENT_SCOPE`/`BUDGET_EXCEEDED` for authority limits, `ALREADY_EXECUTED`
for input rebinding, and `SERVICE_UNAVAILABLE` for unavailable persistence/runtime.
Do not invent new top-level statuses or change the frozen error enum in this slice.

Request limits: 80-character name, 4,000-character task, bounded 128-character
idempotency/opaque IDs; list default 20/max 50. Cursor is server-generated, bound
to connection/filter and never an authority token. Proposed first-release service
ceilings: connection consent at most 24h, child at most 1h and no later than parent,
delegation depth at most 2, at most 10 active children, at most 3 pending launches
and 5 provisioning attempts/minute per connection. Persist quota/rate accounting;
the canonical ledger still enforces shared spend. These ceilings await B review.

`PENDING` has `authority:null`; no credential/grant has been issued yet.
`PROVISIONING` and `READY` contain `{principal_id,grant_id,scope}` in `authority`.
`FAILED`/`REVOKED` retain that metadata if issuance happened. Actual scope is never
inferred from the task text. Public output omits the full task, raw runtime errors,
secret references and credentials. Untrusted task text remains untrusted at B's
worker; this contract does not certify arbitrary text as free of secrets.

Idempotency is unique per connection and normalized exact request. Identical
retries return the same logical agent, including terminal failure/revocation;
different input cannot reuse the key. Reconnect cannot create another allocation.
Grant expiry is authoritative; a later negotiated grant does not renew the initial
child credential's lifetime.

## Proposed private A-to-B runner contract

Dedicated runner authentication plus server-side organization/template admission
is required. No runner identity is accepted in JSON. Job and claim IDs are handles,
not bearer credentials; every private call rechecks runner binding, lease and
grant/connection/membership liveness. Routes are proposals pending B agreement.

| Proposed path | Input / output definition | Required behavior |
|---|---|---|
| `POST /internal/agent-jobs/claim` | `runner_claim_request` → `runner_claim_data` | Claim one admitted job; return `job:null` if none. Repeat the claim idempotency key to recover the same live claim, never a second job. |
| `POST /internal/agent-jobs/:job_id/credential` | `runner_credential_request` → `runner_credential_data` | Only the assigned authenticated runner and live claim can receive that child's secret over the private channel. No parent key. `Cache-Control:no-store`; never exposed through MCP or console. |
| `POST /internal/agent-jobs/:job_id/heartbeat` | `runner_heartbeat_request` → `runner_heartbeat_data` | Renew an admitted live lease, bounded by grant expiry; `stop:true` directs shutdown. Revoked/missing authority must not renew. |
| `POST /v1/agent-runs/:job_id/ready` | `child_ready_request` → `agent_data` | Authenticated **child** calls with its own key. Verify exact job principal/grant and active claim before `READY`. A runner assertion alone is insufficient. |
| `POST /internal/agent-jobs/:job_id/result` | `runner_result_request` → `agent_data` | Assigned live claim only; accept one terminal result, reject changed replay. Sanitize summary; never store raw provider exception/token payload. |

Initial lease is 30 seconds; heartbeat every 10 seconds; deadlines use server time
and cannot exceed grant expiry. B must durably deduplicate `launch_id` before
starting a process, and poll/stop on revoked or expired work. Claims can be retried
at most three times **before** credential delivery, with at most one active lease.

After delivery, lease loss or uncertain launch ownership revokes the child grant
and moves the instance to `FAILED`; do not blindly reassign a still-live credential
to another worker. Repeated delivery for the same authenticated live claim is
allowed to recover a lost response. A new attempt after that terminal failure
requires a new explicit provisioning request and current policy checks.
This sacrifices automatic availability to avoid concurrent authority holders.

The delivery response is intentionally secret-bearing and private machine-to-
machine only. No committed fixture contains it. The model-visible schemas cannot
accept that field. A14 must prove the private channel, no-store/log behavior,
authorization and revocation; a strict JSON schema alone proves none of those.

Persist intent before Vault work; persist issuance binding and launch outbox in
one authority transaction, and reconcile the external secret-store step by a
stable private reference. A failed pre-issuance secret must be cleaned up or safely
retried. A revocation is terminal and persists before any best-effort stop request.
Terminal completion never enlarges authority or means that a credential is renewed.

## Review and implementation gates

| Gate | Status |
|---|---|
| A chooses integration targets and inventories local configuration names | PASSED for A9 decision preparation; actual configuration remains missing/unverified. |
| Portable shapes, positive/negative fixtures, real existing-authority bridge | PASSED locally; see test command below. |
| B accepts the public shapes, private delivery, lease/launch/stop semantics and fixed template | PENDING; no B agreement was found or inferred from their unrelated branch updates. |
| Frozen type/API promotion | NOT STARTED; requires recorded A/B agreement. |
| Auth0 account login, Vault encryption, runner execution, real host compatibility | UNVERIFIED; later A11/A14–A16 gates. |

Review request for B (prepared, not sent): accept or amend the six proposed public
tools/paths and JSON definitions; confirm `sourcing-v1`, private runner auth and
credential injection; durable `launch_id` deduplication; 30s lease/10s heartbeat;
child-key readiness; failure-after-delivery revocation; terminal result semantics;
and the service ceilings. Record reviewer, revision and decision here before
promoting the draft to shared types/handlers. No completion claim is inferred
from a schema test or an agent message without the required agreement.

Run the A9 contract gate:

```sh
# Node 24; no provider credentials or hosted database needed.
node --import tsx node_modules/vitest/vitest.mjs run apps/authority/test/onboarding-contracts.test.ts
npm run typecheck
```

The test rejects forged organization/requester/principal/owner/approval fields,
unknown runtimes, secret references, runner identity overrides, oversized inputs,
secrets in public records and READY without authority. It uses the real engine to
issue/authenticate/replay/revoke a distinct child and deny scope widening. It does
not implement an authorization policy inside a fixture validator.

Validation for this draft: **102 tests passed, none skipped, across 17 suites**
with the optional PostgreSQL tests enabled against a fresh disposable local
database. All five new A9 tests passed. Root and nested MCP typechecks, the MCP
production build, local documentation links and `git diff --check` passed. The
disposable PostgreSQL database was removed afterward. No hosted evidence is claimed.

Next A-owned independent work is A10's internal persistence and seed-free migration
foundation. Keep public DTO promotion, endpoint handlers and B's runner integration
behind the recorded contract agreement. Do not wait for real provider credentials
to write isolated persistence tests; do not label those tests real OAuth proof.
