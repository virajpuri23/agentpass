# Authority console and MCP onboarding

The console is a browser client of the canonical authority service. It adds no policy
engine and changes no shared contract types. Protected supplier and authority routes
stay private when the console is mounted on the MCP service.

## Start a disposable local demo

Use Node 24. Dependencies must already be installed (`npm ci` and
`npm --prefix apps/mcp/agentpass-manufact ci`). From the repository root:

```sh
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build
npm run demo:console
```

Open the printed `/connect` URL (default `http://127.0.0.1:3110/connect`). The demo
creates fresh SQLite files under an OS temporary directory, starts the unchanged
real simulated supplier and authority HTTP services on private loopback ports, and
mounts the built MCP server plus console on port 3110. It never loads `.env` or uses
hosted databases. It asserts a real $850 quote and an authority-required denial;
it never purchases automatically. Ctrl-C stops its services. Files remain for
inspection; remove that printed temporary directory when no longer needed.

The public test credentials in `apps/dashboard/src/demo.ts` are deliberately valid
only for this fresh loopback fixture. Use each principal's own fixture credential
in the connection form; do not reuse them in a deployment. Start as sourcing,
create a request, disconnect, connect as buyer to counteroffer, then reconnect as
sourcing to accept. A grant issuer or organization owner can review and revoke.
The browser session never switches identity without a newly supplied credential.

## Existing separately running services

```sh
AUTHORITY_URL=http://127.0.0.1:4100 \
MCP_PUBLIC_URL=http://127.0.0.1:3111/mcp \
CONSOLE_ORIGIN=http://127.0.0.1:3000 \
CONSOLE_PORT=3000 npm run dev:dashboard
```

The MCP endpoint must use the same authority database: connection verification
calls both services and rejects mismatched identities. Service URLs require HTTPS
outside loopback. The console binds to loopback by default. A separate HTTP server
is unnecessary when mounting on the MCP app.

## Same-origin deployment handoff

The installed `mcp-use@2.8.2` exposes `MCPServer.all` over Hono. The app mounts the
same console handler only when **both** `CONSOLE_ORIGIN` and `MCP_PUBLIC_URL` are
configured. Set these explicitly to the chosen HTTPS console origin and its exact
`/mcp` URL. Set `CONSOLE_ASSETS_DIR` to the absolute deployed
`apps/dashboard/public` path; the default resolves that path from the process cwd.
The existing Manufact build uses the repository root and retains these source
assets. Verify the actual container path and proxy scheme/host behavior before
setting these variables. Console Origin validation intentionally fails closed.
No authority/supplier internal route is mounted publicly.

This version uses bounded process-local sessions with one-hour absolute expiry.
A restart logs browser users out. Use one process/replica for local validation;
a shared server-side session store and operational login throttling are required
before a multi-replica public rollout. Credentials are never placed in cookies,
URLs, returned JSON, tool arguments, model-visible View state, browser storage,
analytics, or frontend assets. Fixture keys in the local-only demo/test source are
not production credentials. No owner credential is selected as a fallback.

The production deployment was inspected read-only on October 17, 2026:
server `f01e0537-092c-48c0-b6a6-66132aa93099`, deployment
`5b0f6f14-3643-4cfc-aaaf-644f6b71a65a`, commit
`42d5a622f008a50aa53e2fc0e2478d8e0cd7a61c`, reported running at
`https://fast-steel-94x84.run.mcp-use.com/mcp`. Production still targets
`feat/authority-core`; this feature branch must not be merged there automatically.
No deployment, public chat setting, environment variable, or hosted allocation was
changed for console verification. These new routes are **not hosted-verified**.

## Client compatibility and OAuth dependency

The connect page offers manual Inspector setup, the official CLI bearer-header
flow, and VS Code's masked input configuration. It does not claim one-click
compatibility. VS Code's current documentation says input variables are not
forwarded into Copilot harness sessions, so that option is explicitly limited to
input-capable sessions. CLI headers are saved in the CLI's private user config.

References checked October 17, 2026:
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- https://github.com/mcp-use/mcp-use/blob/main/docs/typescript/tooling/client-cli.mdx
- https://github.com/mcp-use/mcp-use/blob/main/docs/typescript/api-reference/server/server-config.mdx

**OAuth is blocked on provider configuration and identity provisioning.** No
compatible provider/issuer/client configuration was found locally or in the
Manufact variable-name inventory. There is no human sign-in button that pretends
to authenticate. The installed package has `oauthAuth0Provider` and other external
provider adapters, plus `oauthCustomProvider` with a verifier, RFC 8414 metadata,
resource/audience binding and verified-auth mapping. Those are resource-server
primitives; they do not create a provider account or provision AgentPass authority.

To enable human OAuth safely:
1. Choose/configure an existing supported provider, HTTPS callback, issuer,
   canonical MCP resource/audience, and allowed clients through its private admin
   setup. Supply secrets through the deployment secret manager, never chat.
2. Persist an admin-provisioned `(verified issuer, verified subject)` mapping to an
   existing AgentPass principal and organization. Reject unmapped/inactive users.
   Do not derive roles or tenants from email, tool arguments, or editable profile
   metadata. This requires a reviewed persistence migration and an OAuth ingress
   adapter, not a change to frozen scope fields.
3. Preserve a separate service-agent credential path. Map human OAuth into the
   same canonical principal and authority checks; sign-in must never create root
   authority or impersonate the buyer.
4. Verify login, failed issuer/audience/signature, unmapped user, cross-org access,
   logout/session expiry and key/identity revocation through a real configured
   provider before claiming OAuth compatibility.

Manufact public chat still has no saved configuration. Per-visitor identity and
header propagation have not been tested; no shared owner key should be configured
for visitors. Keep that compatibility unverified until distinct authenticated
visitors demonstrate isolated scopes through real calls.

## Verification evidence

- Root TypeScript, nested MCP typecheck, production MCP build: passed.
- All existing plus console tests passed with SQLite and a fresh local PostgreSQL
  database ending in `_test`: **83 passed, none skipped**.
- Console integration tests use real HTTP MCP `get_my_grants`, canonical authority
  and disposable data. Supplier responses in this suite are labeled fixtures.
- The browser demo uses the unchanged real simulated supplier, not fixture HTTP
  responses: invalid credential; sourcing connection; visible quote grant and
  persisted quote/denial timeline; $1200 request; buyer $900 counteroffer; child
  acceptance; grant inspection and refresh; buyer revocation review, cancel, then
  revoke; refreshed revoked grant and persisted event.
- The real local mcp-use Inspector rendered the caller-scoped embedded View.
  Its new refresh button changed the latest result from purchase DENY to a fresh
  quote ALLOW without rerunning the host tool. Console-link capability was visible. Revoking the disposable caller key made refresh show its recovery message; restoring the fixture key allowed recovery.
- Browser console had no application errors. Responsive single-column layout was
  inspected; no horizontal overflow was observed at the narrow browser size.
- Receipt/ancestor-spend, expired/revoked authority, child impersonation, scope
  widening, request privacy and cross-organization isolation are integration-tested.

The console uses manual refresh, reports snapshot time, labels partial graph
visibility and limits recent activity/receipts. It is not a complete audit export.

## Agent-first onboarding (no UI required)

The primary interface is MCP. The browser console is an optional human inspection
surface, not a prerequisite for connection, negotiation, execution or revocation.
The existing tools support a fully headless child and parent agent workflow.

For an agent runtime or CI process, inject its **own** provisioned `AGENT_API_KEY`
through its secret environment, then run from the repository root with Node 24:

```sh
npm run --silent agent:onboard -- --url "$MCP_PUBLIC_URL"
```

`MCP_PUBLIC_URL` can also supply the endpoint without `--url`. `--help` describes
the command in JSON. Credentials are never accepted as arguments, loaded from a
shared `.env`, printed, or saved by this command. It uses an ephemeral MCP client
and performs only `tools/list`, `describe_authority`, and `get_my_grants` after the
normal protocol handshake. It returns one JSON object and exits 0 on a successful
authenticated read, or 1 on failure. It never purchases, requests, accepts, delegates
or creates a principal automatically.

The JSON includes verified principal/organization from the server result metadata,
caller grants, canonical ancestor budgets, discovered tool names, and the recovery
workflow. `ONBOARDED` means connection and grant inspection succeeded, not that an
arbitrary operation is authorized. `AUTHENTICATED_NO_GRANTS` is a valid connection
with `next_action:contact_owner`; a trusted parent/orchestrator must delegate an
initial grant before this principal can request more authority. Missing/invalid
credentials, invalid endpoints and unavailable services have distinct codes.

An MCP-native agent can skip the CLI and make the same read calls directly. No
browser session cookie or console endpoint is involved. Agent SDKs can inspect the
`get_my_grants` result's `_meta.principal_id`, `_meta.organization_id` and
`_meta.inspector` for authenticated caller context; the model-visible result still
contains only the existing grant response. Identity always comes from ingress
credentials, never a claimed tool argument.

After onboarding: inspect scope and effective remaining budget; use `execute_action`
for the intended operation. On `AUTHORITY_REQUIRED`, use the returned
`required_scope` to call `request_authority`, poll `get_authority_request`, and
accept a suitable counteroffer using `accept_authority_offer`. The authenticated
parent agent uses `respond_authority_request`. Retry execution only after the grant
is issued; the service checks authority again on every operation.

Initial identity and authority provisioning is a trust boundary. A parent holding
a live delegable grant can now automate new child provisioning through
`agent:provision` / `provision_child`; see [the provisioning protocol](16-CHILD-PROVISIONING.md).
There is no unauthenticated self-registration or owner-role minting. The child
never receives its parent’s credential. OAuth remains a separate optional human
connection path, not a dependency for service-agent onboarding.

CLI verification launches real subprocesses against both SQLite and local PostgreSQL MCP servers: buyer onboarding, authenticated sourcing with no grants, invalid credential rejection, credential-free output, zero created requests/purchases and unchanged root budget. A separate live CLI run also inspected the disposable console demo without opening a browser.
