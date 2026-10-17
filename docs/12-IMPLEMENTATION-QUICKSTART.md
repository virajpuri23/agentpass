# Implementation Quickstart — What to Type First

**This repository kit contains design specs and schemas, not an already-running application.** The commands below are a build plan for the team to implement.

## Decide runtime before starting

- Node.js 20 or newer, TypeScript, ESM.
- Official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and Zod 4.2+ for tool registration.
- SQLite for local demo DBs; use a maintained Node SQLite binding (and SQLite transactions).
- Lightweight HTTP framework (Hono or Express) for internal API.
- Two shell processes or independently configured MCP agent clients, each with its own identity/key.
- Environment loaded from untracked `.env` based on `.env.example`.

If Manufact deployment becomes the top priority, use its supported `mcp-use` scaffold instead of writing a custom deployment adapter. Keep authorization business logic framework-agnostic.

## Developer A — first working iteration

1. Create `apps/authority/src/server.ts` exposing `/health` and `/v1/me`.
2. Load `db/schema.sql` into `AUTHORITY_DB_PATH`.
3. Seed principals and root grant from `fixtures/seed-scenario.json`.
4. Implement a function `evaluate({authenticatedPrincipal, grantId, action, supplierId, skuId, amountCents})` returning one typed `ApiResult`.
5. Implement `delegate` and `request/respond/accept` flows.
6. Implement quote gateway before purchase ledger.
7. Register MCP tool schemas that call the identical authority services.
8. Add purchase reservation/idempotency tests and execute purchase last.

Useful MCP v2 pattern (illustrative registration, **not a complete auth server**):

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'agentpass', version: '0.1.0' });
server.registerTool('describe_authority', {
  description: 'Discover which scopes are supported and how to request missing authority.',
  inputSchema: z.object({})
}, async () => ({
  content: [{type: 'text', text: 'Actions: supplier.quote.request, supplier.purchase.execute. Call request_authority for missing scope.'}]
}));
```

Identity must be established by the MCP host or authenticated transport, **never** a tool argument like `agent_id`. Test with an external MCP client, not just unit tests.

## Developer B — first working iteration

1. Create `apps/supplier/src/server.ts` `/health`, `/internal/quote`, `/internal/quotes/:id`, `/internal/fulfill`.
2. Load `db/supplier.sql` into a **different** SQLite file.
3. Seed `PACK-500` at 170 cents/unit, 500 requested → $850 trusted quote. Keep `internal_unit_cost_cents` private.
4. Implement seller-side `allowOperation(principal, action, resource)` which explicitly denies margin reads and arbitrary SKU operations.
5. Create mocked AgentPass client matching `fixtures/response-authority-required.json` and `/v1/authority` contracts.
6. Have buyer agent create sourcing process with separate principal credentials; child follows the request/counteroffer/accept state machine.
7. Build CLI `scripts/run-e2e.ts` that produces the trace and assertions.
8. Only then build a one-screen dashboard fed by persisted audit events.

## Suggested npm scripts **to implement** in the resulting app

```json
{
  "scripts": {
    "dev:authority": "tsx apps/authority/src/server.ts",
    "dev:supplier": "tsx apps/supplier/src/server.ts",
    "dev:mcp": "tsx apps/mcp/src/server.ts",
    "demo:reset": "tsx scripts/seed-demo.ts",
    "demo:run": "tsx scripts/run-e2e.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

These scripts are targets; `tsx`, `typescript`, and `vitest` need to be added as dev dependencies and their corresponding files implemented.

## Minimum mock for independent parallel work

Developer B does not need a working authority server for initial iteration. Implement a local `AuthorityClient` interface with methods matching the frozen HTTP endpoints; return known fixture responses from a `FakeAuthorityClient`. Swap the adapter to `HttpAuthorityClient` after A exposes the server. The agent's state machine should not care which adapter it uses.

Conversely Developer A can use `FakeSupplierService` that returns the seeded $850 quote, rejects margin reads, and returns one stable order ID; swap it to `HttpSupplierService` after B exposes supplier backend.

## Sponsor integration path (only after P0)

1. Test MCP tool calls locally using official Inspector or a connected MCP client.
2. Manufact: `mcp-use deploy --no-github --name agentpass` when supported by the project scaffold and persistent storage exists; refer to https://docs.manufact.com/cli/deploy for actual flags.
3. Primitive: follow https://docs.primitive.dev/docs/sending and the relevant receiving docs; attach message correlation ID to `authority_request.id`. Webhook signatures must be verified.
4. Stripe: use **test-mode only** for a properly scoped purchase; never introduce real-money charges into the hackathon demo.

## First integration smoke test

- GET `http://localhost:4100/health` returns OK.
- GET `http://localhost:4200/health` returns OK.
- Authenticated `/v1/me` for child returns `sourcing-agent`, not `buyer-agent`.
- A's gateway calls B's quote endpoint, returns $850 and no supplier private costs.
- End-to-end `AUTHORITY_REQUIRED` → parent counteroffer → child accept → purchase succeeds exactly once.
