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

## Verification on October 17, 2026 (Pacific)

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
