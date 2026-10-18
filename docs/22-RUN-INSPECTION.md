# Inspect each local product run

A run is a correlated sequence of real authority calls, not proof that a model or
Developer B worker is running. Events and simulated receipts come from persisted
authority data. No new policy engine, scope type or grant semantics are added.

## Demo for Developer B

Use Node 24 and the existing installed dependencies. Build once, then launch the
local simulated console (no `.env` or hosted database is loaded):

```sh
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build
CONSOLE_PORT=3112 npm run demo:console
```

The startup JSON prints the console URL and SQLite directory. To retain the same
history across restarts, pass that directory as `CONSOLE_DEMO_DIR`. Keep it private;
it contains local fixture authority data. Starting without this variable creates
a separate temporary environment. No run history or spent budget is reset.

In another terminal, run:

```sh
npm run demo:walkthrough -- http://127.0.0.1:3112/mcp
```

This command accepts only a loopback HTTP endpoint and uses only the public
`console-fixture-*` credentials of this disposable demo. It generates a fresh run
ID and calls the real MCP tools as distinct buyer and sourcing clients:

1. Delegate quote-only scope; obtain the real simulated supplier's $850 quote.
2. Observe `AUTHORITY_REQUIRED`; request $1,200; counteroffer $900; accept.
3. Execute the simulated purchase and verify an identical idempotent retry.
4. Observe budget and private-margin denials, revoke, then observe revocation denial.

The output contains `run_id`, actual `outcomes`, and a console link selecting that
run. A second run preserves the first run and the spent root allocation: it reports
`BLOCKED_EXISTING_BUDGET` instead of inventing a second successful purchase.
`status:OK` means the deterministic walkthrough finished its checks, not that a
purchase always succeeded. On an interrupted run, use `list_runs` to inspect the
persisted prefix. The command is a deterministic demo driver, not an autonomous
LLM worker.

Open `/connect` and use the local fixture credential appropriate to the view:

- `console-fixture-owner`: organization grant graph, audit events and receipts.
- `console-fixture-buyer`: held/issued grants, its own events and request decisions.
- `console-fixture-sourcing`: its grants, own events, negotiation and receipts.

The owner still cannot read negotiation payloads private to the parent and child.
Select **Inspect a run** in the console. Events are chronological; grant budgets,
revocation and request states are explicitly current snapshots, not reconstructed
historical balances. All-activity view retains untagged earlier events. The latest
100 visible runs, up to 500 events per run, and 100 receipts are shown, with
truncation flags. This is inspection, not a complete audit export.

## Agents: MCP or CLI

Agents use their own credential. No browser or dashboard session is required.

```text
list_runs {}
get_run {"run_id":"run-..."}
```

```sh
# AGENT_API_KEY is supplied privately by this caller's runtime.
npm run agent:runs -- --url http://127.0.0.1:3112/mcp
npm run agent:runs -- --url http://127.0.0.1:3112/mcp --run run-...
```

The CLI emits one JSON envelope, performs only read calls, prints no credentials,
and exits nonzero on denial/error. `--help` describes usage. The read API is
`GET /v1/runs` and `GET /v1/runs/:run_id`, authenticated like `/v1/console`.
They preserve the console's organization/held-or-issued/parties-only/caller-only
visibility rules. Unknown and inaccessible run IDs return the same denial.

## Embedded MCP App run inspector

`get_run` now renders the read-only **Run Inspector** in MCP Apps-capable hosts.
It uses the same authenticated result as the CLI and console. The app shows the
visible grant chain, party-private scope negotiation, chronological audit events,
and simulated receipts; it labels current budgets and request states separately
from historical events. `list_runs` remains a text/JSON discovery tool.

Inside the app, **Choose a run** calls `list_runs`, selecting a run calls `get_run`,
and **Refresh run** reads that exact run again. All calls go through the host's
MCP bridge and current authenticated connection. The View never accepts, stores,
or sends bearer credentials, never fetches the authority API directly, and never
approves or executes an action. Hosts without server-tool bridge support show the
same snapshot and instructions to rerun the tools. Pending reads hide stale data;
failed/denied reads show an error and no previous run details.

Verify locally with the existing console's printed authority URL:

```sh
cd apps/mcp/agentpass-manufact
AUTHORITY_URL=http://127.0.0.1:<authority-port> npm run dev -- --port 3115 --no-open
```

Open the printed Inspector URL, connect using this disposable caller's own fixture
bearer header, then call `get_run` with a `list_runs` result. The automatic unauthenticated
connection may fail; create an authenticated connection in Inspector settings.
No new plugin identity or connection configuration is required: the existing
AgentPass MCP App advertises `ui://views/run-inspector.html` on `get_run`.
This repository change does not deploy the paused hosted service.

## Developer B integration boundary

Generate one opaque ID matching `run-[a-zA-Z0-9_-]{1,80}` per workflow. Attach
`X-AgentPass-Run-Id` to **every** MCP HTTP call in that workflow, including parent
responses and revocation. Each participant keeps its own Authorization credential.
The HTTP adapter forwards correlation to the authority service. For the stdio
adapter, inject `AGENTPASS_RUN_ID` alongside that process's own `AGENT_API_KEY`.
Existing MCP tool argument schemas are unchanged. Console writes made while a run
is selected carry that same header.

The run ID is untrusted correlation metadata. It does not establish identity,
authority, trusted runtime provenance or membership; clients can reuse/spoof it.
Sharing a run ID does not let participants read each other's private evidence.
A run becomes visible when its first audit event is persisted; it has no synthetic
"running" or "passed" status. Calls without the header remain ordinary ungrouped
activity; the server does not infer a new run from a shared parent grant. Existing
purchase reconciliation can retain correlation through the persisted purchase ID.

No hosted deployment, production migration, OAuth release, or B worker execution
is part of this local change.
