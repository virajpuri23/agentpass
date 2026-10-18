# AgentPass OpenAPI

[agentpass.openapi.yaml](agentpass.openapi.yaml) is the complete repository-owned HTTP
contract in [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0.html), with 47 paths
and 52 operations. Import it into an OpenAPI 3.1-capable Swagger Editor,
Postman, Insomnia, or a documentation/SDK generator.

The shared TypeScript contracts in `packages/contracts/src/index.ts` and
`onboarding.ts`, together with implemented HTTP validators, remain authoritative.
This spec documents existing behavior; it does not add endpoints or change grants.

| Surface | Local default | Authentication |
|---|---|---|
| Authority `/v1/*` | `http://localhost:4100` | Agent bearer or configured verified human bearer; endpoint-specific ownership rules |
| Self-service `/v1/agents*`, onboarding context | Authority | Verified, consented human connection; agent control must be configured |
| Child `/v1/agent-runs/{job_id}/ready` | Authority | Exact issued child bearer and delivered live claim |
| Runner `/internal/agent-jobs/*` | Authority | Separate admitted runner bearer and organization/claim binding |
| Supplier `/internal/*` | `http://localhost:4200` | Private `X-Service-Key` |
| Consent and identity `/onboarding*` | MCP origin, proxied to authority | One-use browser cookies; exact Origin and CSRF for form POSTs |
| Console `/console-api/*` and assets | `http://localhost:3000` | Opaque session cookie; exact Origin and JSON for POSTs |
| MCP `/mcp` | `http://localhost:3001` | Agent bearer or configured verified human bearer |

Replace the local server URLs with your configured service origins when importing.
The MCP app can also mount the console at its own origin. In the embedded hosted
layout, authority and supplier are private loopback services; the public MCP origin
does **not** automatically expose their REST endpoints. Do not publish private
runner or supplier APIs, or put their credentials into generated browser clients.

All purchases are simulated. Monetary JSON fields are integer USD cents; the
browser consent `budget` form field is a decimal USD string. Empty resource lists
permit nothing. Grant IDs do not authenticate callers. Child scope can only narrow
live parent scope, and spending consumes the shared ancestor budgets.

JSON APIs normally return `{status:"OK",data:...}` or a structured denial. Health,
console config/logout, HTML forms/redirects, and MCP transport have explicitly
specified response shapes. Supplier policy can return HTTP 200 with `decision:DENY`.
No public endpoint exposes supplier costs or margins. The runner credential route
is secret-bearing and private, with `Cache-Control: no-store`; never log its response.

Purchase and child-provisioning retries bind the authenticated caller and exact
input to their idempotency key. Quote calls create a fresh quote each time despite
requiring a key. Authority requests and direct delegations have no idempotency key.
Offer acceptance replays by request lifecycle; its required key is validated but
does not create a separate binding. Supplier quote/fulfillment retries use their
server-provided `request_id`. Reuse the original purchase key after an uncertain
fulfillment outcome so the existing reservation/order can be reconciled.

MCP is JSON-RPC over Streamable HTTP, not a set of REST `/tools` routes. Use an MCP
SDK and `tools/list` for exact tool schemas; the spec includes `x-mcp-tools` inventory
and `x-mcp-tool` mappings. GET/DELETE session behavior is transport-managed.
Framework-generated OAuth discovery endpoints and upstream Supabase OAuth/token
APIs are outside this repository-owned spec. AgentPass's configured identity UI is
included. See [the rollout runbook](../docs/21-SELF-SERVICE-ROLLOUT.md) for current
hosted verification limits; a documented route does not mean that deployment gate
is complete.

## Validate

After `npm ci`, run:

```sh
npm run check:openapi
```

Use the repository's supported Node version; Node 24 matches the current native
SQLite build. The check validates the OpenAPI document and references, checks
implemented route coverage and canonical onboarding schema parity, validates
existing receipt/denial fixtures, and checks positive/negative HTTP responses using
an isolated in-memory database. It does not contact hosted services or a database.

When changing an HTTP route, update its operation, security, schemas and outcomes
here. Onboarding schemas are exact JSON Schema exports from
`z.toJSONSchema(onboardingSchemas[name])`, without the top-level `$schema` field;
the parity test catches drift. Keep real credentials and secret-bearing examples
out of the spec. HTTP contract and fixture checks do not prove hosted OAuth, worker
execution or real supplier availability.
