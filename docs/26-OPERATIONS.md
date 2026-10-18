# MCP setup and deployment operations

Use Node **24** (the nested MCP app requires at least 22.22.2). This guide
collects the operational instructions previously embedded in the root README.
For the current experience inventory and evidence limits, see the
[site, plugin and demo catalog](25-EXPERIENCES.md). Historical deployment IDs are
verification records; use Manufact for the active revision and configuration.

```sh
npm ci
npm --prefix apps/mcp/agentpass-manufact ci
npm run typecheck
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run typecheck
npm test
```

If dependencies were installed under another Node major, rebuild
`better-sqlite3` after switching. The app pins published `mcp-use@2.8.2`.
`npm test` builds the nested MCP app before running the root suites.

## Authentication and local Inspector

The MCP endpoint uses the frozen contract's distinct opaque agent bearer keys. These are validated online against the authority service on **every request**; credentials and principal identity are never taken from tool arguments or client metadata. Buyer and sourcing clients connect to the same URL with different keys. This bearer setup requires a host that supports an explicit `Authorization` header. For the separate OAuth deployment handoff, see the section below.

With the authority and supplier running from the existing local setup:

```sh
cd apps/mcp/agentpass-manufact
AUTHORITY_URL=http://127.0.0.1:4100 npm run dev
```

Open the printed Inspector URL. Its initial automatic connection has no key and is expected to fail. Open that server's **Connection Settings**, add the custom header `Authorization: Bearer <that agent's key>`, save, and open Tools. Execute `get_my_grants` to render the Authority Inspector. The widget displays only that caller's grants, effective remaining budget including ancestors/reservations, expiry/revocation, and the most recent supplier authorization result. Results are snapshots; execute the read-only tool again after an action to refresh.

For the official independent CLI client, from the nested app directory:

```sh
npx mcp-use client connect buyer "$MCP_URL" --no-oauth -H "Authorization: Bearer $BUYER_API_KEY"
npx mcp-use client connect sourcing "$MCP_URL" --no-oauth -H "Authorization: Bearer $SOURCING_API_KEY"
npx mcp-use client buyer tools list
npx mcp-use client buyer tools call get_my_grants
npx mcp-use client sourcing tools call get_my_grants
```

The CLI stores connection headers in its local user configuration; keep that configuration private and outside Git. Supply keys through each client's private configuration, never a model prompt. The sourcing client must never receive the buyer/owner key.

Discovered tools: `provision_child`, `describe_authority`, `get_my_grants`, `request_authority`, `get_authority_request`, `respond_authority_request`, `accept_authority_offer`, `delegate_authority`, `execute_action`, `verify_authority`, `revoke_authority`. The remote Manufact adapter also retains its six human onboarding tools. The additive [workforce contract](11-WORKFORCE-CONTRACT.md) covers generic resources, protected gateways and recovery. All return structured envelopes with text fallbacks; all core workflows work without rendering the view.

## Supabase persistence and hosted authority

Use a dedicated AgentPass Supabase project. Do not reuse the supply/Keel databases. Put the project's PostgreSQL **session-pooler** URI into the untracked root `.env` as `DATABASE_URL`, along with the four provisioned agent keys. Remote connections always use TLS with certificate verification; set `DATABASE_CA_CERT` to the PEM trust root if required. Do not paste database credentials into chat or commit them.

Provision the distinct agent keys using the existing seed command (which preserves existing `.env` values), then initialize the private PostgreSQL schema:

```sh
npm run seed:authority
npm run setup:postgres
```

`setup:postgres` creates the private `agentpass` schema with RLS enabled and no public policies, then seeds only missing organizations, principals, hashed keys, and the $1,000 buyer root. It preserves existing grants, ledger entries, revocation, root expiration and keys. Use the database owner/service connection for this private service; do not expose tables through Supabase's public Data API or use a publishable/anon key for server access. Never put the database connection string into the widget.

The existing authority engine remains the only authority implementation. Its PostgreSQL adapter keeps each reservation, ancestor debit, issuance, acceptance, revocation and receipt update inside a database transaction. A shared transaction advisory lock preserves the local engine's writer ordering across replicas. Uncertain supplier outcomes retain durable reservations and the original fulfillment request ID for idempotent retry. This coarse writer lock is intended for the hackathon workload; it trades throughput for the existing serial execution semantics.

For a separately hosted authority service, set `DATABASE_URL`, `SUPPLIER_URL`, `SUPPLIER_SERVICE_KEY`, `AUTHORITY_HOST=0.0.0.0`, and `AUTHORITY_PORT`, then run `npm run dev:authority`. Configure the MCP service's `AUTHORITY_URL` with its reachable HTTPS URL.

For one Manufact service, omit `AUTHORITY_URL` and provide `DATABASE_URL` and `SUPPLIER_SERVICE_KEY`. The app starts the same authority HTTP API on a private dynamic loopback port **inside the Manufact container**. Supply either an external HTTPS `SUPPLIER_URL`, or `SUPPLIER_DATABASE_URL` with no `SUPPLIER_URL` to start Developer B's unchanged supplier HTTP app on another private loopback port in the same container. Both services use PostgreSQL; supplier data stays in the separate private `supplier` schema. Apply Developer B's `supabase/migrations/20261017213000_supplier_schema.sql` once before startup. Laptop localhost URLs and ephemeral SQLite do not satisfy hosted verification.

## Manufact-managed deployment

Install the requested agent skill, and authenticate with a fresh preapproved device code in your private terminal:

```sh
npx --yes skills add mcp-use/mcp-use#main --yes --skill mcp-apps-builder -a cursor -a claude-code -a codex
npx -y mcp-use@latest login --device-code "$MANUFACT_DEVICE_CODE"
npx -y mcp-use@latest whoami
```

An expired or absent code is a login blocker. Do not infer authentication from an attempted command.

Create a private, untracked `.env.manufact` containing **only** `NODE_ENV=production`, `DATABASE_URL`, optional `DATABASE_CA_CERT`, `SUPPLIER_DATABASE_URL` (or external `SUPPLIER_URL`), and `SUPPLIER_SERVICE_KEY`. Agent bearer keys are held by the clients and stored hashed in PostgreSQL; do not configure a shared `AGENT_API_KEY` on the HTTP MCP service. An external-authority deployment instead needs `NODE_ENV=production` and `AUTHORITY_URL`. Manufact login credentials belong in its user-level credential store.

For a new Manufact-managed deployment, run from the repository root so the uploaded source includes the shared authority and supplier modules; no new GitHub repository is needed:

```sh
npx mcp-use deploy --no-github -y --org org-ab91b9e3-2lgi6 \
  --build-command 'npm ci && npm --prefix apps/mcp/agentpass-manufact ci && env -u DATABASE_URL -u DATABASE_CA_CERT AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build' \
  --start-command 'npm --prefix apps/mcp/agentpass-manufact start' \
  --env-file .env.manufact
```

The build uses a placeholder authority URL only to validate tool/view registrations. Runtime secrets come from Manufact's environment-variable system. The app exposes a minimal `/health` liveness route for Manufact's health check; MCP calls still require agent authentication. Before upload, inspect the source archive scope and preserve unrelated Developer B work. Generated skill folders and build/auth state are ignored. Never upload real customer data or supplier-private databases.

The existing GitHub-backed server is in `org-ab91b9e3-2lgi6` and receives
pushes from `virajpuri23/agentpass`. The latest deployment work moved the tracked
branch to `main`; the former `feat/authority-core` references in historical reports
are not current deployment instructions. Verify the server's tracked branch and
active source revision in Manufact before an operational change. A merge to the
tracked branch may trigger deployment automatically. Runtime secret values stay
in the deployment secret manager.

Read the returned IDs and dashboard URL, then follow actual deployment status/build logs:

```sh
npx mcp-use deployments get "$DEPLOYMENT_ID"
npx mcp-use deployments logs "$DEPLOYMENT_ID" --build --follow
npx mcp-use deployments logs "$DEPLOYMENT_ID"
```

Copy the **exact MCP connection URL from the successful deployment/dashboard**. Then connect buyer/sourcing clients using their respective bearer headers as above. Plain unauthenticated `client connect` cannot validate this protected endpoint. Keep the server ID, deployment ID, dashboard URL, and exact Git commit in the handoff; do not guess any URL.


## Current OAuth sign-in handoff

The email link, browser Origin policy, and email-return callback fixes are merged
in PRs [36](https://github.com/virajpuri23/agentpass/pull/36),
[37](https://github.com/virajpuri23/agentpass/pull/37), and
[38](https://github.com/virajpuri23/agentpass/pull/38). The deployment chat reported
the callback live with HTTP 200. Its final authenticated Manufact tool-list check
is waiting for the human to open the latest email in the same browser and approve
Manufact. This is not evidence of a completed end-to-end OAuth journey.

Use the exact configured client and redirect allowlists; dynamic registration
remains disabled in that rollout. Read [OAuth configuration](19-A11-OAUTH.md)
for the implementation, and verify live provider/client state before changing it.
The private portable plugin still declares bearer authentication; enabling OAuth
on the server does not update that saved plugin package automatically.

## Verification and data targets

Run the full supplier lifecycle in a fresh local environment before a hosted
rehearsal; see the [catalog](25-EXPERIENCES.md#supplier-authorization-demo).
Hosted execution consumes its actual simulated allocation. Do not reset a spent
root or assume historical remaining balances are current. Fresh root authority
requires an authorized owner; reconnecting or reinstalling a plugin creates none.

The optional PostgreSQL suite requires a **disposable local** database whose name
ends in `_test`. It truncates AgentPass tables and refuses hosted targets:

```sh
AGENTPASS_TEST_DATABASE_URL=postgresql://LOCAL_USER@localhost:5432/agentpass_test npm test
```

Keep production and test databases separate. Record the exact source revision,
endpoint, deployment ID, caller scope, test output and whether a supplier is real
simulated infrastructure or an HTTP fixture. A build or health check alone does
not verify authenticated execution, persistence, revocation, or host rendering.
