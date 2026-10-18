# Manufact v2 deployment verification — October 17, 2026

> Historical implementation/verification record. Branch names, OAuth state and
> deployment IDs below apply to that milestone. For the consolidated inventory
> and latest documented handoff, see [experiences](25-EXPERIENCES.md) and
> [operations](26-OPERATIONS.md#current-oauth-sign-in-handoff).

The hosted MCP → authority → Developer B supplier flow passed through independent SDK clients. The official mcp-use CLI also connected distinct buyer/sourcing clients and discovered the exact nine contracted tools.

- MCP: https://fast-steel-94x84.run.mcp-use.com/mcp
- Dashboard: https://manufact.com/cloud/org-ab91b9e3-2lgi6/servers/f01e0537-092c-48c0-b6a6-66132aa93099/overview
- Server: `f01e0537-092c-48c0-b6a6-66132aa93099`
- First verified v2 deployment: `0600457a-b145-4c48-9ede-896997b13fdd`
- Verified application commit: `49739cba5296b5fff3afe304eb08becd674a5407`
- Supabase project: `ebkcaqaybuklllefvuyv`; separate private `agentpass` and `supplier` schemas.

## Architecture and configuration

Manufact builds from the repository root and starts `npm --prefix apps/mcp/agentpass-manufact start`. The MCP app starts the existing authority HTTP API and Developer B's unchanged supplier HTTP API on separate private loopback ports. Both use durable PostgreSQL. The public MCP entry is `/mcp`, with a minimal `/health` route; supplier internal endpoints are not mounted on the public server.

Runtime variables: `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPPLIER_DATABASE_URL`, `SUPPLIER_SERVICE_KEY`. Database/service values are write-only Manufact secrets. Omit `AUTHORITY_URL` and `SUPPLIER_URL` in this embedded deployment. The build uses `AUTHORITY_URL=https://authority.invalid` with database variables removed, so registration validation does not connect to real services or disable production HTTPS checks.

Use a distinct bearer key per agent, validated against the hashed Supabase principal keys on every MCP request. Tool arguments never select caller identity. Existing legacy agent-key environment variables on Manufact are not used for authentication by the v2 app. No OAuth authorization server is provided; clients must support custom Authorization headers.

Local CLI aliases `production-buyer` and `production-sourcing` are configured privately. From `apps/mcp/agentpass-manufact`, run:

```sh
npx mcp-use client production-buyer tools list
npx mcp-use client production-buyer tools call get_my_grants
npx mcp-use client production-sourcing tools call get_my_grants
```

For another machine, use the README's `client connect` instructions with each principal's privately provisioned key. Never paste keys into model prompts, GitHub comments, or source files. Supabase publishable/secret API keys are not AgentPass caller credentials.

## Results

| Check | Result |
|---|---|
| Local typechecks and production-mode app build | PASSED |
| Full local suite, including real supplier and disposable PostgreSQL | 69 tests passed, 12 files |
| Hosted `/health`; unauthenticated MCP rejection | 200; 401 |
| Nine tools; distinct buyer/sourcing identities and grants | PASSED |
| Quote-only delegation; trusted supplier quote | $850 |
| Unauthorized purchase recovery | AUTHORITY_REQUIRED / INSUFFICIENT_SCOPE; request_authority; required_scope $850 |
| $1200 request → buyer $900 counteroffer → sourcing acceptance | PASSED |
| Simulated $850 purchase and identical receipt on replay | PASSED |
| Unauthorized request read, self-approval, impersonation, scope escalation | DENIED |
| Price override and supplier private-margin access | DENIED; no private numeric fields |
| Revoked and expired execution | GRANT_REVOKED; GRANT_EXPIRED |
| Concurrent sibling purchases exceeding remaining root budget | One $98.60 purchase; one BUDGET_EXCEEDED |
| Credential/private-source checks on tool output and generated widget assets | PASSED |
| Supabase public API roles accessing either private schema | DENIED |
| Hosted Authority Inspector rendered through a separate local Inspector client | PASSED: buyer-agent identity, live root scope/expiry, $51.40 remaining |

Tools: `describe_authority`, `get_my_grants`, `request_authority`, `get_authority_request`, `respond_authority_request`, `accept_authority_offer`, `delegate_authority`, `execute_action`, `revoke_authority`. Manufact's injected feedback tool was disabled to keep discovery aligned with this contract.

## Persisted evidence

- Authority request: `6f665c04-9078-4dbd-8751-ddf0a0e5e9d7`
- Accepted grant: `22da7fe1-7408-440c-b143-e12cf7ccf2fc`
- Purchase request: `de5aaa1a-3b31-4dac-b403-29f320ba8983`
- Receipt: `21a8fc36-ccdc-4bc5-85d1-004af4c78f91`
- Supplier order: `order-75a9f6bc-c053-47f9-b2d4-1628f5ef7ade`

Supabase contains one supplier order for this purchase and two committed 85000-cent ledger entries: one for the accepted grant and one for `grant-root-buyer`. The receipt matches the original replay response. Audit records include issuance, acceptance, reservation, completion, seller-policy denial, revocation, and revoked-execution denial. Manufact runtime logs independently show the corresponding live MCP tool calls.

These are simulated, persisted demo transactions. The golden-path purchase plus the concurrent-test winner leave 5140 cents on the canonical root. A fresh owner allocation is required before another full $850 purchase demo; the bootstrap preserves spent budgets, receipts and audit history.

## Failures encountered and resolved

- Preview `7236c64a-319e-4405-9d5e-9e7beab68cd2`: free plan disallowed previews; user approved the feature branch as production.
- Deployment `75db8ec4-f134-4338-9da8-f5ef45ccc90b`: nested build context excluded the monorepo; changed to repository root.
- Deployment `8e78ac59-c871-4271-ab20-71e5c8e4c0fd`: production guard rejected an HTTP build placeholder; replaced it with an HTTPS reserved-domain placeholder.
- New local test setup initially assumed Supabase roles existed in plain PostgreSQL and used the wrong ledger column name. Corrected the test setup/assertion; all 69 tests passed afterward.
