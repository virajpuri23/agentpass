# Sites, plugin, demos and visual catalog

Inventory prepared October 17, 2026 (Pacific), against merged source `e99304e`.
This document records where each experience lives, how to reproduce it, and what
its evidence establishes. Runtime deployment and grant state can change; a saved
URL, screenshot or earlier test count is not a fresh verification.

## Sites and browser surfaces

| Surface | Address / startup | Source | Purpose and limits |
|---|---|---|---|
| Private presentation website | [Published site](https://agentpass-authority-story-01a14ce3.cheeryball10.chatgpt.site); `python3 -m http.server 3300 --bind 127.0.0.1 --directory sites/authority-story/dist` | [Site package](../sites/authority-story/README.md) | Product introduction, architecture and illustrative $850 scenario. Private to publishing account; no live authority calls. |
| Architecture export in website | `/architecture.html` on the static server/site | [HTML export](../sites/authority-story/dist/architecture.html) | Five interactive technical views; preserved generated export used by the site's iframe. |
| Compact technical visualization | Open HTML in a browser | [technical-flow.html](visuals/technical-flow.html) | System, delegation, negotiation, execution and revocation; explanatory only. |
| Animated supplier overview | `npm run dev:activity`; [local root](http://127.0.0.1:3200/) | [HTML](../apps/activity/public/index.html), [JS](../apps/activity/public/viz.js), [CSS](../apps/activity/public/viz.css) | Real runner events streamed over SSE; local, local HTTP MCP, hosted and labeled recording modes. |
| Simple supplier timeline | [simple.html](http://127.0.0.1:3200/simple.html) on the activity server | [HTML](../apps/activity/public/simple.html), [JS](../apps/activity/public/simple.js), [CSS](../apps/activity/public/simple.css) | Simplified visualization of the same supplier flow and explicit recording labels. |
| Workforce stage | [workforce.html](http://127.0.0.1:3200/workforce.html) on the activity server | [HTML](../apps/activity/public/workforce.html), [JS](../apps/activity/public/workforce.js), [CSS](../apps/activity/public/workforce.css) | Lead and four helpers, passes, wallets, refusals, negotiation, work outputs and revocation. |
| Local authority console | `npm run demo:console`; default [connect](http://127.0.0.1:3110/connect) and [console](http://127.0.0.1:3110/console) | [Server](../apps/dashboard/src/server.ts), [assets](../apps/dashboard/public/index.html) | Fresh local SQLite/simulated supplier. Authenticated grants, requests, audit and receipt inspection. |
| Hosted authority console | [Connect](https://fast-steel-94x84.run.mcp-use.com/connect), [console](https://fast-steel-94x84.run.mcp-use.com/console) | Same dashboard source mounted by [MCP App](../apps/mcp/agentpass-manufact/index.ts) | Authenticated canonical hosted data; requires a valid caller or a short-lived workflow handoff. |
| Launchpad fixture | Workforce prints a dynamic loopback preview URL; or build/start `demo-project` separately | [Fixture README](../demo-project/README.md) | Sample landing page edited by agents; not the AgentPass product site. Preview stops when the run cleans up. |
| MCP Inspectors | Open the nested app's printed local Inspector URL or an MCP Apps-capable host | [MCP App](../apps/mcp/agentpass-manufact/README.md) | Authority, Run and Workflow views use the current host's authenticated connection. |
| OAuth identity UI | `/onboarding/identity` and `/onboarding/identity/email-return` at the hosted origin | [OAuth configuration](19-A11-OAUTH.md), [operations handoff](26-OPERATIONS.md#current-oauth-sign-in-handoff) | Provider authorization flow, not a public marketing page. Do not invent an authorization ID or treat a callback 200 as login success. |

`ACTIVITY_PORT` overrides port 3200. `CONSOLE_PORT` overrides the console demo
port. Separate-service dashboard configuration is in [the console guide](15-AUTHORITY-CONSOLE.md).
The hosted service root is not the presentation site. The website, console,
Launchpad fixture and MCP views serve different purposes.

## Multi-agent demo matrix

| Demo | Participants and execution | Default backend | Entry point |
|---|---|---|---|
| Workforce | Lead + Design, external Security, Hosting, Analytics; deterministic specialist sessions, in-process by default | Fresh real authority and SQLite; simulated fixed-price vendor | `npm run demo` / workforce stage |
| Workforce remote gateway | Same team; protected gateway and external Security run in separate local processes | Real authority → HTTP gateway | `npm run demo -- --gateway remote` |
| Two-helper video cut | Lead + Design + external Security; omitted helper checks are not run | Real authority, same enforcement paths | `npm run demo -- --helpers two` |
| Workforce practice | Same deterministic work, labeled mock authority; wallet checks not run | In-memory mock | `npm run demo -- --authority mock` |
| Buyer/supplier | Buyer and sourcing child are separate authenticated processes; supplier is an independent service/organization | Fresh authority/supplier HTTP + stdio MCP | `npm run demo:run` |
| Buyer/supplier HTTP MCP | Same agents via the built hosted-style HTTP adapter | Fresh local HTTP MCP | `npm run demo:run -- --via-http` |
| Release crew | Lead + specialist processes using tool SKUs; explicit decision callback | Fresh real local authority/supplier | `npm run crew:run -- --decision partial --partial 300` |
| Console walkthrough | Separate buyer/sourcing MCP clients driven by a deterministic CLI | Local console fixture; persistent history per fixture directory | `npm run demo:walkthrough -- <loopback-mcp-url>` |
| Hosted Codex delegation | Parent and separately credentialed scripted child workers | Hosted authority/supplier and persisted records | [Hosted inspection runbook](HOSTED-WORKFLOW-DEMO.md) |
| Website money story | Browser scenario state and buttons | Scripted illustration, no API/backend | Static presentation site |

Multiple agents, credentials, sessions or processes do not establish that an LLM
chose the actions. The checked-in demos use deterministic programs. The supplier
and workforce paths exercise real authorization code; the explanatory site does
not. The deployed human-onboarding runner is a separate unfinished integration.

### Workforce demo

Install root and nested MCP dependencies with Node 24, then run:

```sh
npm run demo
npm run dev:activity
```

Open `/workforce.html` and press **Run demo** for the visual experience. Select
Normal, Slow or Instant pacing and all helpers or the short two-helper cut.
Pacing queues actual events; the technical log retains the underlying decisions.
The full real-authority scenario has 18 checks. Older screenshots and reports show
12 checks before wallets were added; mock/short variants report omitted checks.

The lead receives repository authority and a $1,000 purchasing wallet. Design can
edit only component/style paths, cannot read `.env`, and cannot overspend. The
outside reviewer has read-only repository access and no wallet; the lead pays its
simulated invoice. Hosting's production request fails, then it negotiates a
15-minute preview grant and a $120 wallet counteroffer. Analytics gets aggregates,
not raw personal rows, and its raw-export request is rejected. Temporary grants
and wallets are revoked, then reuse is denied.

Expected full-run simulated spend: Design $80 + Security invoice $160 + Hosting
$120 + Analytics $25 = **$385**, leaving **$615** at the root. A child debit also
appears in ancestor ledgers; do not sum all grant spend as separate purchases.
Each invocation copies `demo-project` and creates fresh temporary credentials and
authority state. The site preview is `next build` + `next start` on loopback, not
Vercel or production. A cold run needs registry access to install fixture packages.

Read [the full package](21-WORKFORCE-DEMO.md) and
[the stage script and failure recovery](24-WORKFORCE-DEMO-RUNBOOK.md).
The source package's old Git/merge blockers are historical; authority integration
is now in `main`. Hosted workforce execution, external preview hosting and the
human-onboarding worker are separate gates.

### Supplier authorization demo

`npm run demo:run` uses the package script's `.env` loader. For a new local checkout,
first run `npm run seed:authority` to create local service configuration. Then:

```sh
npm run demo:run
npm run demo:run -- --via-http
```

Default mode starts isolated real authority/supplier services, fresh random
credentials, separate buyer/sourcing processes and stdio MCP; it cleans up its
temporary stack. `--via-http` needs the nested MCP app built first.

The buyer holds a $1,000 root and delegates $0 quote-only scope. The supplier quotes
500 PACK-500 units at $1.70, totaling $850. Purchase needs more authority; the child
requests $1,200, receives a $900 counteroffer, accepts and executes one simulated
order. The runner checks identity separation, scope, supplier margin denial,
overspend, widening, self-approval, forged identity and post-revocation denial.
Nine summary checks report actual calls. Use the console walkthrough below for an
explicit identical-receipt retry and persisted multi-run inspection.

Other modes:

```sh
npm run demo:run -- --services
npm run demo:run -- --hosted
npm run demo:run -- --trace-out /private/tmp/agentpass-trace.json
```

`--services` uses configured authority/supplier services. `--hosted` uses
`HOSTED_MCP_URL`, `HOSTED_BUYER_API_KEY`, `HOSTED_SOURCING_API_KEY` and a live
`HOSTED_ROOT_GRANT_ID`; never use local seeded keys against the deployment.
Hosted runs consume the actual remaining simulated budget. They are not a
read-only connectivity check. Keep credentials in private runtime configuration.
See [the original demo runbook](08-DEMO-RUNBOOK.md) and
[hosted verification procedure](../apps/mcp/VERIFY-HOSTED.md).

### Release crew demo

```sh
npm run crew:run -- --decision approve
npm run crew:run -- --decision partial --partial 300
npm run crew:run -- --decision deny
```

This is the purchasing-tool crew, separate from the workforce that edits a site.
It uses a $1,000 release root and supplier SKUs `SEC-SCAN`, `DESIGN-PACK` and
`QA-MINUTES`. The decision callback approves, narrows or denies a request; specialist
processes use their own credentials. These are deterministic policy decisions,
not human approval or LLM reasoning. `--hosted` requires the deployment's credentials
and a suitable `HOSTED_CREW_ROOT_GRANT_ID`; no allocation is automatically renewed.
Source: [runner](../scripts/run-crew.ts), [crew agents](../apps/crew-agent/src/lead.ts),
[launcher](../apps/agent-kit/src/crew-launcher.ts).

### Console and hosted workflow inspection

Build the MCP app, start `CONSOLE_PORT=3112 npm run demo:console`, then run
`npm run demo:walkthrough -- http://127.0.0.1:3112/mcp` in a second terminal.
The fresh fixture persists a $850 simulated purchase, retry, denials and revocation.
A second run preserves the spent root and can be budget-blocked. Follow
[run inspection](22-RUN-INSPECTION.md) for local credentials, reopening fixture
data with `CONSOLE_DEMO_DIR`, and agent `list_runs`/`get_run` reads.

For hosted evidence, call `get_workflow` on a branch the caller holds or issued.
The MCP view's **Open read-only web dashboard** uses a one-use link (one minute)
and a workflow-only HttpOnly browser session (15 minutes). The literal console URL
or a known grant ID gives no access. Links and sessions clear on restart and never
extend grant or credential lifetime. See [hosted workflow inspection](HOSTED-WORKFLOW-DEMO.md).

A later hosted rehearsal captured root `bc3f0857-312d-435e-b459-fc8f1a910b82`:
one $3.40 simulated purchase, a $3 request narrowed to $2 and accepted, seven denied
actions, and $6.60 remaining at capture. Those are historical values in the
[hosted screenshot](evidence/hosted-delegation-workflow.png), not a promise that
this expiring allocation is still usable. A fresh live demo needs valid bounded
authority; inspection cannot renew it.

## MCP App and private plugin

| Component | Source / ID | Behavior |
|---|---|---|
| Private plugin | [Package](../apps/mcp/plugins/agentpass/plugin.json); `plugins_6ad428cae36c81918fdf82325942bd1f` | Version 0.1.0, release `pluginrel_6ad428cbb5ec8191932b6113eb818f23`; update existing ID rather than create another plugin. |
| Remote connection | [mcp.json](../apps/mcp/plugins/agentpass/mcp.json) | Streamable HTTP at the hosted `/mcp`, API-key bearer host extension. No embedded credentials. |
| Scoped-authority skill | [SKILL.md](../apps/mcp/plugins/agentpass/skills/scoped-authority/SKILL.md) | Inspect scope, negotiate, execute with own identity and revoke; never infer authority from a prompt. |
| Icon | [icon.svg](../apps/mcp/plugins/agentpass/assets/icon.svg) | Shared composer/listing asset. |
| Authority Inspector | [View](../apps/mcp/agentpass-manufact/views/authority-inspector/view.tsx), `get_my_grants` | Caller grants, effective budgets, chain status and current authorization result. |
| Run Inspector | [View](../apps/mcp/agentpass-manufact/views/run-inspector/view.tsx), `get_run` | Correlated audit/receipts; current grants and private request visibility. |
| Workflow Inspector | [View](../apps/mcp/agentpass-manufact/views/workflow-inspector/view.tsx), `get_workflow` | Selected branch, descendants, budgets, decisions, receipts and read-only browser handoff. |
| Local Codex private-file helper | [Guide](../apps/mcp/plugins/README.md), [helper source](../apps/mcp/src/codex-headers.ts) | Exact endpoint/expiry checks; bearer output goes only to Codex's secret header transport. |

The package connects to the service; it contains neither a server runtime nor
credentials. Installing it grants nothing. Each parent/child needs its own
connection. The saved package declares bearer auth; current server OAuth work is
tracked separately in [operations](26-OPERATIONS.md#current-oauth-sign-in-handoff).

The service tool families are: discovery/inspection (`describe_authority`,
`get_my_grants`, `verify_authority`, `list_runs`, `get_run`, `get_workflow`), authority
lifecycle (`provision_child`, `delegate_authority`, `request_authority`,
`get_authority_request`, `respond_authority_request`, `accept_authority_offer`,
`revoke_authority`), protected execution (`execute_action`), and six human-onboarding
tools (`get_onboarding_context`, `provision_agent`, `list_agents`, `get_agent`,
`revoke_agent`, `revoke_connection`). Discover the actual tool list for the running
adapter: stdio and hosted adapters expose different subsets. The
[API contract](02-API-CONTRACTS.md) and [OpenAPI](../contracts/README.md) define shapes.

Package validation, authenticated MCP calls, local Inspector rendering and hosted
console evidence exist. Rendering all views and executing the complete lifecycle
through a fresh saved-plugin host connection remain host-specific verification
work. A plugin schema pass or plain `/health` 200 does not establish that journey.

## Visuals and presentation assets

| Asset | What it records | Provenance / limits |
|---|---|---|
| [Verified website scenario](evidence/presentation-scenario-verified.png) | Browser-tested scripted receipt, replay, overspend and revocation state | Captured from this repository copy during the documentation update; illustration only, no API calls. |
| [Presentation preview](evidence/presentation-site.png) | Published website hero | Copied from the October 17 presentation chat; screenshot, not live execution. |
| [Compact technical visual](visuals/technical-flow.html) | Five selectable architecture explanations | Original standalone HTML from the presentation chat, preserved unchanged. |
| [Site architecture export](../sites/authority-story/dist/architecture.html) | Diagram embedded in the site | Generated export with its wrapper/CSP; retained alongside the smaller original. |
| [Workforce stage](evidence/workforce-screen.jpg) | Animated multi-agent stage | Earlier local screenshot; check counts/UI can predate wallets. |
| [Launchpad before](evidence/landing-before.jpg) / [after](evidence/landing-after.jpg) | Fixture and actual Design-agent output | Local demo evidence, not hosted AgentPass marketing pages. |
| [Local run inspection](evidence/local-run-inspection.png) | Caller-scoped run, $850 simulated purchase and negotiation | Local authenticated browser capture from October 17, 18:31 Pacific; older UI snapshot. |
| [Hosted delegation workflow](evidence/hosted-delegation-workflow.png) | Hosted branch, $3.40 receipt, negotiated grant and denials | Authenticated hosted capture from October 17, about 21:02 Pacific; balances/expiry are historical. |
| [Hosted supplier trace](evidence/hosted-run-2026-10-17.json) | Actual structured supplier run trace/checks | Replayable in activity view; always labeled recording. |
| [Problem and Solution deck](../AgentPass%20%E2%80%94%20Problem%20%26%20Solution.pptx) | Editable pitch slides | Existing repository artifact; does not prove runtime behavior. |
| [Problem and Solution PDF](../AgentPass%20%E2%80%94%20Problem%20%26%20Solution.pdf) | Portable pitch export | Existing repository artifact. |

The website's scenario tests live in
[scenario.check.mjs](../sites/authority-story/test/scenario.check.mjs). The exact
static package was copied from the presentation chat's saved site directory;
`dist/` is its served HTML/CSS/ES-module source, not a reproducible framework build.
The private deployment archive is redundant with these files and is not checked in.
Google Fonts and the exported diagram's external helper scripts can require
network access; the compact technical visual is self-contained.

The [evidence index](evidence/README.md) explains the distinction between screen
captures, recordings and fresh verification. Admin-console screenshots, private
credential files and database snapshots remain outside the repo. No final demo
video is checked in. The stage runbook includes a short recording script; the
pitch deck and website can support narration.

## Status and maintenance

The last inspected merged source is `e99304e`, including the OAuth email-return
fix. The deployment chat reported main-branch auto-deployment and the callback
live; the human must still approve the provider client before its final
authenticated tool-list verification. Hosted workflow screenshots predate that
OAuth rollout. Historical reports that say OAuth is disabled or production tracks
`feat/authority-core` describe earlier states.

The Manufact [server dashboard](https://manufact.com/cloud/org-ab91b9e3-2lgi6/servers/f01e0537-092c-48c0-b6a6-66132aa93099/overview)
is the place to confirm the active branch, deployment ID, source revision and
runtime logs. [Operations](26-OPERATIONS.md) contains setup, persistence,
authentication, deployment commands and test-target rules. Never infer current
runtime from the newest documentation commit.

When a surface changes, update its source, this table, relevant runbook and evidence
caption together. Record exact revisions and modes. Keep fixture, mock, local,
hosted, scripted and human-approved results distinguishable. Preserve spent roots
and historical receipts rather than resetting them to stage another success.
