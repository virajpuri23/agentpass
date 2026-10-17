# A11 — MCP OAuth ingress

The remote MCP app accepts Auth0 user access tokens when all of these variables
are configured:

| Variable | Requirement |
|---|---|
| `MCP_USE_OAUTH_AUTH0_DOMAIN` | Auth0 tenant issuer/domain configured to publish its JWKS. |
| `MCP_PUBLIC_URL` | Canonical HTTPS URL of the MCP endpoint, including `/mcp`. Localhost HTTP is allowed only for development. |
| `AGENTPASS_OAUTH_CLIENT_IDS` | Comma-separated exact client IDs approved for the MCP connection, configured by an operator. |
| `MCP_USE_OAUTH_AUTH0_AUDIENCE` | Optional compatibility alias. If set, it must identify the same canonical resource as `MCP_PUBLIC_URL`. Leave it unset otherwise. |

Set all three required values together. A partial or unsafe configuration fails
startup. With all OAuth values absent, legacy opaque agent credentials continue
to work. Never derive the MCP resource from the inbound `Host` or forwarded-host
headers.

Configure the Auth0 API audience to the exact `MCP_PUBLIC_URL` and grant the
`agentpass:connect` API permission to each approved client. The scope identifies
permission to connect to AgentPass; supplier actions and budgets continue to be
controlled by persisted AgentPass grants. Access tokens must have an `iat` and
`exp` no more than 600 seconds apart. Configure refresh according to the host's
requirements; an MCP refresh must not create a new AgentPass connection or reset
its grants.

The installed `mcp-use@2.8.2` Auth0 resource-server provider publishes the
protected-resource and authorization metadata and supplies issuer, signature,
JWKS, resource-audience and expiry validation. AgentPass additionally requires a
verified allowlisted `client_id` or `azp`, rejects conflicting client claims,
rejects Auth0 client-credentials (`@clients`) subjects for human account
bootstrap, requires `agentpass:connect`, limits token size, and enforces the
600-second lifetime. It does not treat an Auth0 client ID or a model-provided
field as the user's identity; the verified issuer and subject are passed to the
authority service, which resolves persisted account and connection state.

Opaque service-agent credentials remain supported. They are checked against the
canonical authority `GET /v1/me` path on each MCP request and resolve to that
persisted agent principal. A token with JWT structure is always handled as a JWT;
failed JWT verification is never retried as a service key. Database and
authority failures deny access.

For the first-party browser consent client, use a separate verifier configured
with only its approved client ID. Do not add it to
`AGENTPASS_OAUTH_CLIENT_IDS` unless it is also meant to use the public MCP
connection flow. Consent still requires the one-use, CSRF-bound browser state
described in [A9](18-A9-ONBOARDING-CONTRACTS.md); a valid OAuth token alone is
not consent to issue authority.

Keep client IDs and provider settings in the deployment's private environment
configuration. Do not commit provider secrets. Provider revocation notifications
are not assumed; the maximum accepted access-token lifetime bounds provider-side
revocation delay, while AgentPass connection or membership revocation is checked
against persisted state on each request.

## Verification boundary

The automated OAuth tests use a local test signing key and local JWKS fixture.
They cover valid signatures and resource binding, invalid issuer/audience/signature,
expiry and token lifetime, client allowlisting/conflicts, missing scope, Auth0
machine subjects, service-key compatibility, and the no-JWT-fallback rule. They
do not use a real Auth0 tenant, ChatGPT/Claude registration, user consent browser,
or hosted database. Real host login, refresh, and revocation behavior remain
unverified until private provider configuration and callback registration are
available.
