# AgentPass private plugin

`agentpass/` is a portable Agent Plugins 1.0 package for the existing hosted MCP
service. It contains one authority workflow skill, a bearer-authenticated remote
MCP connection and an icon. It contains no credentials or server runtime.

Private account plugin: [AgentPass](https://chatgpt.com/plugins/plugins_6ad428cae36c81918fdf82325942bd1f),
version `0.1.0`, release `pluginrel_6ad428cbb5ec8191932b6113eb818f23`.
Update this plugin by its existing ID; do not create another copy.

Create an archive outside the package directory from the repository root:

```bash
python3 -m zipfile -c /tmp/agentpass-plugin.zip apps/mcp/plugins/agentpass
python3 -m zipfile -l /tmp/agentpass-plugin.zip
```

Save the archive through Plugin Creator, then connect it with the intended
principal's provisioned credential using the host's secure connection settings.
Do not paste credentials into chat. A parent and child require separate
authenticated connections. Installing this package does not grant authority.

The service currently supports provisioned agent bearer credentials. Human OAuth
is disabled; the package intentionally does not advertise OAuth or human runner
readiness. Its `get_my_grants` tool provides the existing read-only inspector.
Some hosts may not support API-key connections; do not switch to unauthenticated
access to accommodate them.

For a local Codex connection, a provisioned child can use the existing private
credential file directly through `http_headers_helper`, without copying its token
into configuration or a shell environment:

```toml
[mcp_servers.agentpass]
url = "https://fast-steel-94x84.run.mcp-use.com/mcp"
http_headers_helper = "/absolute/path/to/node --import /absolute/path/to/tsx/dist/loader.mjs /absolute/path/to/agentpass/apps/mcp/src/codex-headers.ts /private/runtime/codex.json https://fast-steel-94x84.run.mcp-use.com/mcp"
```

Use the installed Node 24 and tsx paths and a Codex runtime that supports
`http_headers_helper` (the desktop's bundled runtime supports it; the locally
installed Terminal CLI 0.145.0 does not). Remove any previous
`bearer_token_env_var` for this connection so it cannot override the child header.
The helper rejects expired credentials and endpoint mismatches. Its stdout is
secret transport for Codex only: never run it in a chat-visible terminal. Restart
the host connection after configuration; this does not verify the cloud plugin.

## Verification on October 17, 2026 (Pacific)

- A separately provisioned, zero-budget quote-only child authenticated through the
  private-file helper. The desktop's bundled Codex runtime discovered all 16 tools;
  `describe_authority` and `get_my_grants` succeeded through the helper. Three
  helper integration tests and the root typecheck passed. Rendering the inspector
  inside the desktop chat remains unverified.
- Human signup was deferred in favor of this agent-first connection. An optional
  OAuth deployment failed before promotion because the build omitted
  `migrations/postgres`; the previous bearer deployment remains active. OAuth
  environment additions were removed, Supabase OAuth and its hook were disabled,
  and the previous Site URL was restored. Prepared client registrations, exact
  audience bindings and private configuration were retained for a future rollout.
- Hosted `/health` returned HTTP 200.
- The configured authenticated MCP client discovered 16 deployed tools and
  `get_my_grants` returned the authenticated principal's grants and inspector data.
- An unauthenticated MCP initialization returned HTTP 401 with `INVALID_CALLER`.
- The nested MCP production build and SQLite HTTP MCP integration passed with
  Node 24, including the simulated purchase lifecycle and negative authorization
  cases. Two optional tests were skipped; no disposable PostgreSQL target was set.
- The manifest passed the published plugin schema. The MCP transport passed the
  published MCP schema with its OpenAI auth extension checked separately against
  Plugin Creator's documented bearer-auth format (the portable schema does not
  yet declare host extensions). The saved package was accepted by Plugin Creator.

These are read-only checks of the deployed service. Installation, secure credential
entry and inspector rendering in a new host connection require host verification.
No purchase, grant issuance, revocation or deployment is part of packaging.
