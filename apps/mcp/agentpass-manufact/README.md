# AgentPass Manufact MCP App

The official `mcp-apps` scaffold, adapted to the existing AgentPass authority API. See the repository [Manufact setup](../../../docs/26-OPERATIONS.md) for installation, authentication, Supabase persistence, deployment, client configuration, and demo verification.

This adapter uses published `mcp-use@2.8.2`. The scaffold generated on October 17 pinned an unpublished `2.10.1`; npm's `latest` tag pointed to an accidental `3.0.0-canary` release. The app deliberately pins a published v2 release.

`index.ts` default-exports `MCPServer` and exports every statically declared tool reference. `get_my_grants` binds the read-only `views/authority-inspector` view. Every request validates its own AgentPass bearer key against `/v1/me`, and each operation forwards that same credential to the authority API. No shared buyer key, tool-selected identity, or authority implementation exists here.

Two backend modes:

- `AUTHORITY_URL`: existing authority API over HTTPS (loopback HTTP allowed for local development).
- `DATABASE_URL` + `SUPPLIER_SERVICE_KEY`: start the existing authority API on an internal loopback port with Supabase persistence. Use an external HTTPS `SUPPLIER_URL`, or set `SUPPLIER_DATABASE_URL` and omit `SUPPLIER_URL` to run Developer B's unchanged supplier HTTP app privately in the same container. Both schemas must be initialized before startup. Do not also set `AUTHORITY_URL`.

Run schema setup explicitly before starting the embedded mode. Build with only a non-secret placeholder `AUTHORITY_URL`; runtime secrets are resolved at server startup, not embedded in the build. The managed repository must include the repository root because embedded authority imports Developer A's existing modules.
