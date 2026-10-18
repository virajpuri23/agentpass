# Workforce contract v1 (additive, Developer A owned)

This extends the frozen purchasing contract; existing supplier request bodies stay unchanged.
Source: `packages/contracts/src/workforce.ts`, exported by `index.ts`. Developer B consumes these schemas without editing them.

## Connection and identity

Authority base URL: configured `AUTHORITY_URL`, local default `http://127.0.0.1:4100`.
Remote MCP: existing Manufact server `/mcp`; hosted rollout status is recorded below after verification.
All `/v1` calls require `Authorization: Bearer <distinct registered agent credential>`.
The server derives principal from this credential (or existing verified OAuth connection).
No body field may select the caller. Independently operated agents use their own registered principal and credential; resource ownership remains with the granting organization.
Root authority is provisioned by a trusted administrator, never by an MCP tool.

## Scope and actions

Canonical actions: `repo.read`, `repo.write`, `security.audit.run`, `deploy.preview`,
`deploy.production`, `analytics.aggregate.read`, `analytics.raw.read`.
Supplier actions and their existing scopes are preserved. A grant is either a supplier scope or a workforce scope; mixed grants are rejected.

```json
{"actions":["deploy.preview"],"supplier_ids":[],"sku_ids":[],"max_per_action_cents":0,"total_budget_cents":0,"expires_at":"2026-10-18T16:00:00Z","max_delegation_depth":0,"resources":[{"resource":"demo-project","organization_id":"buyer-co","owner_principal_id":"owner-1","paths":[]}],"max_executions":5}
```

Resource IDs are opaque registered IDs, never URLs or filesystem roots. Organization/owner
are exact persisted identities checked against trusted gateway registration.
`paths` permits exact relative file names or directory prefixes ending in `/`;
empty arrays permit no file access. No globs, absolute paths, dot segments, backslashes,
percent encoding, secret files or symlinks. The gateway resolves files against its trusted root.
Every child narrows actions, resources, paths, expiration, execution ceiling and delegation depth.
All executions count against the leaf and every ancestor's shared ceiling; issuing a child creates no new quota.
Workforce operations have no monetary charge. Purchasing retains its authoritative quote and budget ledger.

## Compatible endpoints and MCP tools

Existing delegation/request/respond/accept/revoke endpoints and tool names accept the additive workforce scope:

- `POST /v1/grants/:id/delegate`: `{recipient_principal_id,scope}`.
- `POST /v1/grants/:id/provision-child`: existing private credential-verifier provisioning.
- `POST /v1/authority/requests`: `{parent_grant_id,requested_scope,reason}`.
- `GET /v1/authority/requests/:id`: visible only to requester and parent.
- `POST /v1/authority/requests/:id/respond`: `{decision:"COUNTEROFFER"|"REJECT",offered_scope?}`.
- `POST /v1/authority/requests/:id/accept`: `{idempotency_key}`.
- `POST /v1/grants/:id/revoke`: `{reason}`.
- `POST /v1/actions/verify`: new advisory check; returns a decision, never a reusable execution credential.
- `POST /v1/actions/execute`: accepts either the frozen supplier body or the workforce body below.

MCP retains `describe_authority`, `get_my_grants`, `request_authority`,
`get_authority_request`, `respond_authority_request`, `accept_authority_offer`,
`provision_child`, `delegate_authority`, `execute_action`, `revoke_authority` and adds
`verify_authority`. Existing six human onboarding tools remain unchanged.

```json
{"grant_id":"hosting-grant","action":"deploy.preview","resource":"demo-project","parameters":{"environment":"preview","artifact_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"idempotency_key":"deploy-001"}
```

Exact parameters: repo read `{path}`, repo write `{path,content}`, security audit
`{paths:[...]}`, deployment `{environment:"preview"|"production",artifact_digest:<sha256>}`
with matching action/environment, aggregate analytics `{metric}`, raw analytics `{}`.
Extra parameters (including agent ID, price, arbitrary URL or credentials) are rejected.

## Decisions and errors

Workforce verify/execute returns the decision directly (not an `OK` wrapper):

```json
{"status":"DENY","code":"OUTSIDE_PARENT_SCOPE","reason":"Action is outside available parent authority","next_action":"request_authority","suggested_action":"deploy.preview","required_scope":{"actions":["deploy.preview"],"supplier_ids":[],"sku_ids":[],"max_per_action_cents":0,"total_budget_cents":0,"expires_at":"2026-10-18T16:00:00Z","max_delegation_depth":0,"resources":[{"resource":"demo-project","organization_id":"buyer-co","owner_principal_id":"owner-1","paths":[]}],"max_executions":1}}
```

`ALLOW` after execution includes `execution_id` and adapter `result`. `AUTHORITY_REQUIRED`
includes exact `required_scope` and `next_action:request_authority`. A live permission request
returns `REQUEST_PENDING`, `request_id`, `next_action:get_authority_request`.
`DENY` codes include `INVALID_CALLER`, `INSUFFICIENT_SCOPE`, `OUTSIDE_PARENT_SCOPE`,
`GRANT_REVOKED`, `GRANT_EXPIRED`, `BUDGET_EXCEEDED`, `INVALID_REQUEST`, `ALREADY_EXECUTED`,
`SERVICE_UNAVAILABLE`. Malformed/authentication failures retain frozen HTTP error envelopes
(400/401/403/503). Never return internal filesystem names, credential details or exception text.

## Protected execution adapter

Developer B supplies trusted resource registrations to `createAuthorityApp({workforce:{resources}})`
and consumes `createWorkforceClient`/`createProtectedWorkforceClient` from authority's workforce client module.
Registration binds resource ID, organization, owner, allowed actions, optional repository root,
and an `execute` callback. The callback receives validated input, authenticated principal,
server-generated execution ID, and validated repository paths. It must execute that exact operation,
use the execution ID as its durable idempotency key, independently enforce its own service policy,
and return only public results. No user-supplied callback/endpoint is accepted.

Verification alone cannot authorize a later side effect. Call execution through this gateway;
it rechecks live authority, reserves every ancestor's quota atomically and binds the
idempotency key to grant, action, resource and all parameters. Changed input with the same key
is denied. Concurrent duplicates return `REQUEST_PENDING`. A completed replay still checks live
authority. Uncertain/crashed adapter calls stay pending and consume quota until trusted reconciliation;
the gateway never blindly retries an uncertain external side effect.

For filesystem adapters B must use the provided safe file-handle helper at the operation,
keep the workspace inaccessible to untrusted local processes during execution, and never let an agent
replace parent directories concurrently. Symlinks are rejected at both validation and file opening.

## Negotiation and audit

Hosting starts with `repo.read`, requests production, receives a denial with preview suggestion,
requests preview, parent counteroffers preview-only (at most the requested scope), child accepts,
then resumes via `execute_action` with its new grant. No human is needed within seeded parent authority.
Parent cannot approve production when its live chain lacks production.

Existing audit event schema: `{event_id,timestamp,principal_id,grant_id?,action,decision,
reason_code?,request_id?,trace_id}`. Events are persisted for negotiation, delegation,
checks, denials, execution, and revocation. Parameters, file contents and credentials are not logged.
Owner audit reads remain `GET /v1/audit`; external subjects receive only their own grants/requests.

Standalone authority and embedded Manufact startup support optional server-owned
`WORKFORCE_RESOURCES_JSON` (array of resource registrations without callbacks),
`WORKFORCE_GATEWAY_URL`, and private `WORKFORCE_SERVICE_KEY`. Configure all three together.
The URL must be HTTPS or loopback HTTP; redirects are rejected. The gateway receives
`POST /internal/workforce/execute`, authenticated by `X-Service-Key`, with
`{execution_id,principal,input}`. `principal` comes from authority transport authentication;
B must authenticate the service key before trusting this envelope. Return
`{status:"OK",data:<public result object>}` and durably deduplicate `execution_id`.
Filesystem registrations additionally need a canonical shared repository root;
when authority and B run on different hosts without that shared filesystem, file actions
fail closed. Local in-process adapters use `createAuthorityApp` directly.
No workforce resource or root grant is enabled by default.

## Administrator bootstrap and B implementation example

Apply the additive migration before starting updated services:

```sh
node --env-file=.env --import tsx db/migrate.ts --target sqlite
# Or: node --env-file=.env --import tsx db/migrate.ts --target postgres
```

The existing admin seed registers the owner/buyer service identities. A database administrator
may then set `WORKFORCE_ROOT_JSON` and run:

```sh
node --env-file=.env --import tsx db/seed-workforce.ts
```

The JSON is `{grant_id,owner_principal_id,subject_principal_id,scope}`. The owner must
already be an active persisted OWNER in the resource organization. Use the workforce
scope above with `actions:["repo.read","repo.write","security.audit.run","deploy.preview",
"analytics.aggregate.read"]`, approved source paths, suitable future expiration,
`max_delegation_depth:3`, and a bounded `max_executions`. `subject_principal_id` is the
parent coding agent. The CLI refuses changed existing roots and never clears revocation,
extends expiry, resets quota, or changes purchasing allocation. It issues no credentials.
Use the existing `provision_child` flow for distinct private worker credentials, or delegate
to an independently registered external principal. Do not expose database access to agents.

B can register a local file adapter as follows (the callback is trusted code):

```ts
const resource = {
  resource: 'demo-project', organization_id: 'buyer-co', owner_principal_id: 'owner-1',
  repo_root: canonicalSandboxRoot,
  allowed_actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'],
  async execute({input, execution_id}) {
    // Dispatch only the validated canonical action. Never let the agent choose a command or URL.
    // Reuse execution_id as the workload's durable idempotency key.
    return runProtectedWorkload(input, execution_id);
  },
};
```

For repo reads/writes import `openWorkforceFile` from
`apps/authority/src/workforce-paths.ts`, close handles in `finally`, and write through
the handle. The safe write helper truncates the approved file and refuses a symlink leaf.
B's worker sandbox must prevent agents from concurrently replacing ancestor directories.
Security audit output must contain only permitted findings; aggregate metrics must be
computed by the private workload service without returning user-level events.

## Verification and deployment status

The existing server is `f01e0537-092c-48c0-b6a6-66132aa93099` at
`https://fast-steel-94x84.run.mcp-use.com/mcp`. Manufact API inspection resolves it to
organization UUID `e46e47c6-e213-484d-bb6b-639c0a223e2f`; the supplied CLI organization
slug is `org-152932fd-jx9ra`. Do not create a duplicate server.

This workforce revision is verified locally through actual HTTP and MCP clients with
fixture workloads. The remote B gateway adapter is exercised through real HTTP with a
fixture service. The four actual B workloads and hosted workforce journey are not yet
verified. Production auto-deploys `feat/authority-core` without CI gating; schema-first
rollout and B registrations must precede activation. A source push alone is not a
hosted authorization proof. Pending/uncertain executions require trusted reconciliation;
there is no public retry bypass or quota reset endpoint.

### Observed local checks (October 17, 2026)

All commands ran with Node 24 via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`
from the isolated `feat/authority-core` checkout.

```sh
npm run typecheck
npm --prefix apps/mcp/agentpass-manufact run typecheck
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build
AGENTPASS_TEST_DATABASE_URL=postgresql://neha@127.0.0.1:54329/agentpass_workforce_20261017_test \
AGENTPASS_RUNNER_TEST_DATABASE_URL=postgresql://neha@127.0.0.1:54329/agentpass_workforce_runner_20261017_test \
./node_modules/.bin/vitest run --no-file-parallelism
```

Observed: both typechecks and the MCP build PASSED; full suite **205 passed,
0 skipped, 32 files**. After consolidating decision validation into the shared
contract, the affected six HTTP/MCP/workforce/Manufact suites passed **26/26**,
including PostgreSQL. `git diff --check` passed. These test databases are disposable
local fixtures; the commands do not target hosted customer data.

The official MCP client observed this successful sequence:

1. `verify_authority(deploy.production)` → `DENY`, suggested `deploy.preview`.
2. `execute_action(deploy.production)` → `DENY`; zero workload invocations.
3. `verify_authority(deploy.preview)` → `AUTHORITY_REQUIRED`, exact required scope.
4. `request_authority(required_scope)` → `OK`, request `PENDING`.
5. Repeated preview check → `REQUEST_PENDING`, same request ID.
6. Parent `respond_authority_request(COUNTEROFFER)` → `COUNTEROFFERED`.
7. Child `accept_authority_offer` → scoped grant.
8. Preview verify → `ALLOW/AUTHORIZED`; zero workload invocations.
9. Preview execute → `ALLOW/EXECUTED`, one simulated workload invocation.

The complete remote MCP catalog is: `describe_authority`, `get_my_grants`,
`get_onboarding_context`, `provision_agent`, `list_agents`, `get_agent`, `revoke_agent`,
`revoke_connection`, `provision_child`, `request_authority`, `get_authority_request`,
`respond_authority_request`, `accept_authority_offer`, `delegate_authority`,
`verify_authority`, `execute_action`, `revoke_authority`.
The legacy stdio adapter exposes the eleven service-agent tools, omitting only
those six human onboarding controls.

The embedded authority API is private loopback: do not append `/v1` to the public
MCP URL. Remote agents use the MCP tools; direct HTTP clients need a separately
configured reachable `AUTHORITY_URL`. Every MCP client must supply its own bearer
credential or the existing verified OAuth connection; no shared parent key is used.
