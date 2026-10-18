# Local quickstart

The authority, supplier, MCP adapters, agents and browser views are implemented.
Use Node **24**. Run from the repository root; keep all credentials and `.env`
private. For all site/demo choices, see [the experience catalog](25-EXPERIENCES.md).

## Install and validate

```sh
npm ci
npm --prefix apps/mcp/agentpass-manufact ci
npm run typecheck
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run typecheck
```

The placeholder authority URL is only for build/registration validation. Never
use it as a runtime deployment target. If native SQLite dependencies were installed
under a different Node major, run `npm rebuild better-sqlite3` after switching.

## Run the workforce demo

```sh
npm run demo
npm run dev:activity
```

Open [the workforce stage](http://127.0.0.1:3200/workforce.html). Each run creates
fresh authority state and a temporary copy of `demo-project`; the first fixture
install/build needs npm registry access. The default uses real local authority
checks and simulated purchases. [Modes and expectations](25-EXPERIENCES.md#workforce-demo).

## Run an isolated buyer/supplier process demo

On a fresh checkout with no configured environment, provision the local demo keys
and SQLite seed once:

```sh
npm run seed:authority
npm run demo:run
```

The seed command preserves existing keys and grant/ledger state and adds missing
keys to the untracked `.env`. It is local setup, not production root issuance.
With default isolated mode, `demo:run` creates separate temporary real authority
and simulated supplier services and independent buyer/sourcing processes. It does
not use an existing database or need separately started services.

For the HTTP MCP transport, build the nested app first:

```sh
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build
npm run demo:run -- --via-http
```

## Inspect persistent local history

```sh
AUTHORITY_URL=https://authority.invalid npm --prefix apps/mcp/agentpass-manufact run build
CONSOLE_PORT=3112 npm run demo:console
```

In a second terminal:

```sh
npm run demo:walkthrough -- http://127.0.0.1:3112/mcp
```

Use the printed connection URL and the local fixture identities from
[run inspection](22-RUN-INSPECTION.md). The console demo never loads `.env` or
hosted databases. It retains its temporary directory for inspection. To reopen
the same history, set `CONSOLE_DEMO_DIR` to that directory. A repeated walkthrough
preserves spent budgets; it does not manufacture another successful purchase.

## Separately running local services

This is optional; isolated mode above needs fewer steps. Configure loopback
`AUTHORITY_URL`, `SUPPLIER_URL`, separate SQLite paths, provisioned keys and a
private `SUPPLIER_SERVICE_KEY` in `.env`, using [.env.example](../.env.example).
Do not populate local-reset configuration with hosted database URLs.

```sh
npm run dev:supplier
npm run dev:authority
```

Run those in separate terminals, then `npm run demo:run -- --services` in a third.
`npm run dev:mcp` is the stdio adapter for an individually configured agent.
The optional `demo:reset` command deletes the configured local authority SQLite
state and resets the configured supplier store, including PostgreSQL if selected.
Use it only for an explicitly disposable fixture, with both services stopped.
Isolated demos and console fixtures do not require it.

## Verify

```sh
npm test
node --test sites/authority-story/test/scenario.check.mjs
```

`npm test` builds the MCP app. The optional PostgreSQL suite truncates tables and
requires a disposable **local** database ending in `_test`; see
[operations](26-OPERATIONS.md#verification-and-data-targets). The static-site tests
exercise a scripted illustration and do not prove live authorization.

For headless/child credentials, hosted persistence, Inspector setup and deployment,
use [operations](26-OPERATIONS.md), [provisioning](16-CHILD-PROVISIONING.md) and
[the private plugin guide](../apps/mcp/plugins/README.md). Never put parent keys in
child tool arguments or treat a model-supplied identity as authentication.
