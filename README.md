# AgentPass — YC Make Something Agents Want, October 17–18, 2026

> **Status:** The core authority demo is implemented and deployed. Developer A's
> self-service onboarding logic is implemented and locally verified, but public
> OAuth onboarding is not configured or released; see [current rollout status](docs/21-SELF-SERVICE-ROLLOUT.md).
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

**Developer A self-service onboarding:** the [implementation plan](docs/17-SELF-SERVICE-ONBOARDING-PLAN.md)
and [rollout status](docs/21-SELF-SERVICE-ROLLOUT.md) describe verified identity
logic, personal workspaces, bounded consent, conversational MCP tools, private
child credential delivery and durable runner control. The A-owned application
logic is implemented; live OAuth and host journeys remain unverified, and hosted
preview rollout is paused. The optional Developer B worker is outside the current
Developer A scope.

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

> **Important:** This repository includes specifications, contracts, schema,
> fixtures and application code. The core demo is deployed; self-service
> onboarding remains unreleased pending live OAuth and host verification.

## Implementation quickstart

Read [`docs/12-IMPLEMENTATION-QUICKSTART.md`](docs/12-IMPLEMENTATION-QUICKSTART.md) for first commands, API mock strategies, and MVP service startup scripts **to implement**. Machine-readable REST contract: [`contracts/agentpass.openapi.yaml`](contracts/agentpass.openapi.yaml).

## Manufact MCP App v2

The earlier hosted core-demo verification is recorded in [14](docs/14-MANUFACT-VERIFICATION.md); it predates self-service onboarding. At code revision `7e9af22`, the A implementation passed **191 local tests**, root and nested typechecks, and the nested MCP production build. The four additive Supabase migrations, all 13 onboarding/control-table RLS settings and a bounded Vault round-trip were separately verified; no pre-existing row counts changed. See the [current rollout record](docs/21-SELF-SERVICE-ROLLOUT.md). The onboarding code has not been deployed: Manufact rejected its preview before build under the current plan, and hosted preview rollout is paused. OAuth remains off; real OAuth, ChatGPT/Claude journeys and B worker integration are unverified.

- MCP URL: https://fast-steel-94x84.run.mcp-use.com/mcp
- Dashboard: https://manufact.com/cloud/org-ab91b9e3-2lgi6/servers/f01e0537-092c-48c0-b6a6-66132aa93099/overview
- Server ID: `f01e0537-092c-48c0-b6a6-66132aa93099`
- First verified v2 deployment: `0600457a-b145-4c48-9ede-896997b13fdd` at `49739cba5296b5fff3afe304eb08becd674a5407`. Later commits may create new deployments; consult the dashboard for the active ID.
- The earlier failed v2 preview `7236c64a-319e-4405-9d5e-9e7beab68cd2` was blocked before building by the free-plan restriction. The later onboarding preview was also blocked before build; its ID and the user's decision to pause are recorded in [21](docs/21-SELF-SERVICE-ROLLOUT.md). Production remains on `feat/authority-core`; the A onboarding implementation has not been deployed. The build context must be the repository root because the MCP adapter imports shared authority and supplier modules; the start command selects the nested MCP App.

Use Node **22.22.2+** for the MCP App (Node 24 recommended). If dependencies were installed under a different Node major, run `npm rebuild better-sqlite3` after switching. The existing stdio adapter remains available for headless per-agent processes. The nested app was generated with the required official `mcp-apps` template and pins published `mcp-use@2.8.2`.

```sh
npm ci
npm --prefix apps/mcp/agentpass-manufact ci
npm run typecheck
AUTHORITY_URL=http://127.0.0.1:4100 npm --prefix apps/mcp/agentpass-manufact run typecheck
npm test
```

`npm test` builds the MCP App before running the suites. The PostgreSQL suite runs when `AGENTPASS_TEST_DATABASE_URL` identifies a **disposable local database whose name ends in `_test`**; it truncates that database's AgentPass tables. It refuses hosted database targets. Example:

```sh
AGENTPASS_TEST_DATABASE_URL=postgresql://LOCAL_USER@localhost:5432/agentpass_test npm test
```

### Authentication and local Inspector

The MCP endpoint uses the frozen contract's distinct opaque agent bearer keys. These are validated online against the authority service on **every request**; credentials and principal identity are never taken from tool arguments or client metadata. Buyer and sourcing clients connect to the same URL with different keys. Hosts must support an explicit `Authorization` header; this demo does not provide an OAuth authorization server for OAuth-only clients.

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

Discovered tools: `provision_child`, `describe_authority`, `get_my_grants`, `request_authority`, `get_authority_request`, `respond_authority_request`, `accept_authority_offer`, `delegate_authority`, `execute_action`, `revoke_authority`. All return structured envelopes with text fallbacks; all core workflows work without rendering the view.

### Supabase persistence and hosted authority

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

### Manufact-managed deployment

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
npx mcp-use deploy --no-github -y --org org-152932fd-jx9ra \
  --build-command 'npm ci && npm --prefix apps/mcp/agentpass-manufact ci && env -u DATABASE_URL -u DATABASE_CA_CERT AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build' \
  --start-command 'npm --prefix apps/mcp/agentpass-manufact start' \
  --env-file .env.manufact
```

The build uses a placeholder authority URL only to validate tool/view registrations. Runtime secrets come from Manufact's environment-variable system. The app exposes a minimal `/health` liveness route for Manufact's health check; MCP calls still require agent authentication. Before upload, inspect the source archive scope and preserve unrelated Developer B work. Generated skill folders and build/auth state are ignored. Never upload real customer data or supplier-private databases.

The user approved reusing the existing GitHub-backed server in `org-ab91b9e3-2lgi6` instead of creating a second managed server in the originally requested organization. The Manufact GitHub App already receives pushes from `virajpuri23/agentpass`. `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPPLIER_DATABASE_URL`, and `SUPPLIER_SERVICE_KEY` are stored as write-only production secrets; `NODE_ENV=production` is configured. Production targets `feat/authority-core`. Pushing that branch deploys automatically; alternatively restart the active deployment with `--branch feat/authority-core`. Do not deploy with a fixture URL.

Read the returned IDs and dashboard URL, then follow actual deployment status/build logs:

```sh
npx mcp-use deployments get "$DEPLOYMENT_ID"
npx mcp-use deployments logs "$DEPLOYMENT_ID" --build --follow
npx mcp-use deployments logs "$DEPLOYMENT_ID"
```

Copy the **exact MCP connection URL from the successful deployment/dashboard**. Then connect buyer/sourcing clients using their respective bearer headers as above. Plain unauthenticated `client connect` cannot validate this protected endpoint. Keep the server ID, deployment ID, dashboard URL, and exact Git commit in the handoff; do not guess any URL.

### Demo and live verification

Through distinct buyer/sourcing clients, run the frozen sequence in `docs/02-API-CONTRACTS.md`: inspect the $1,000 buyer root; delegate zero-budget quote-only scope; get the trusted $850 quote; confirm purchase returns `AUTHORITY_REQUIRED` with an $850 `required_scope`; request $1,200; parent counteroffers $900; child accepts; execute $850; replay the identical key and confirm identical receipt/one debit; revoke and confirm a new execution is denied. Reuse an expiration no later than the requested scope when constructing a counteroffer.

Also verify another principal cannot read the request, a child cannot approve itself or act as buyer, expired grants fail, margin access reveals no private fields, and concurrent sibling purchases cannot overspend their parent. The local MCP suite performs all of these over real HTTP MCP and authority calls with an independent HTTP supplier fixture. PostgreSQL tests additionally use separate authority instances and reconnect to persisted completed receipts.

For hosted completion, repeat those calls against the exact deployed URL and Developer B's real simulated supplier service, correlate the real authority audit events in the private database with Manufact runtime logs, and inspect outputs for credentials/private margins. The local fixture suite and build success do not satisfy this final gate. Notify Developer B with the URL, bearer-header instructions, seeded root ID and exact tested commit only after that gate passes.

The hosted verification has run and persisted its simulated transactions. The $850 golden-path purchase plus the $98.60 concurrent-test winner leave **$51.40** on the original $1,000 root. Do not expect another $850 purchase to succeed under that same spent root. Preserve the receipts/audit evidence; an owner must provision a fresh demo allocation before another full purchase demonstration.

### Browser authority console

Run `npm run demo:console` after building the nested MCP app to open a fresh,
loopback-only simulated environment at `/connect` and `/console`. The console
verifies an actual authenticated MCP read, visualizes caller-visible grants,
negotiates through the existing request lifecycle, shows persisted activity, and
reviews revocation impact. See [startup, verification and OAuth handoff](docs/15-AUTHORITY-CONSOLE.md).
OAuth and hosted console deployment remain unverified; no production settings are
changed by the local demo.

### Headless agent onboarding

MCP is the primary interface; the UI is optional inspection. An agent with its own
provisioned `AGENT_API_KEY` can verify identity, grants, remaining budgets and tools
without opening a browser:

```sh
npm run --silent agent:onboard -- --url "$MCP_PUBLIC_URL"
```

The command returns JSON and performs only read-only MCP calls. It does not create
identity or authority. Initial provisioning comes from a trusted owner/orchestrator;
parent and child agents then negotiate through the existing MCP lifecycle. See the
[agent-first workflow](docs/15-AUTHORITY-CONSOLE.md#agent-first-onboarding-no-ui-required).

### Automated child provisioning

A parent with a live delegable grant can create a new child identity and bounded
authority without a person or browser. The trusted CLI generates the child secret,
keeps it in a private file outside the repository, and sends only its SHA-256
verifier to the new `provision_child` MCP tool:

```sh
npm run --silent agent:provision -- --url "$MCP_PUBLIC_URL" \
  --parent-grant "$PARENT_GRANT_ID" --scope-file ./child-scope.json \
  --credential-file "$PRIVATE_RUNTIME_DIR/child.json"
npm run --silent agent:onboard -- --credential-file "$PRIVATE_RUNTIME_DIR/child.json"
```

The parent secret comes from its own `AGENT_API_KEY`. The second command uses the
child file explicitly, even if a parent key remains in the inherited environment.
Retry provisioning with the same files; never regenerate a credential after an
uncertain response. See [trusted provisioning](docs/16-CHILD-PROVISIONING.md) for
scope, expiry, revocation, private-file rules, and the required schema rollout.

### Self-service from a conversational host

The additive remote MCP path resolves a verified person to a personal workspace
and separate client connection, then requires explicit bounded consent before
provisioning children. The backend handles credentials privately; people do not
enter organization/principal IDs or copy child keys. The implementation and local
fixture evidence are in [the rollout runbook](docs/21-SELF-SERVICE-ROLLOUT.md).
The hosted Vault check has passed, but real Supabase OAuth and ChatGPT/Claude
staging gates remain open. This is not yet a released public onboarding service;
the B worker remains outside the current Developer A scope.
