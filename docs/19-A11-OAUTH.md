# A11 — Supabase OAuth ingress and trusted consent links

The remote MCP app accepts verified Supabase user access tokens when all of
these settings are configured:

| Variable | Requirement |
|---|---|
| `MCP_USE_OAUTH_SUPABASE_URL` | Supabase project origin, such as `https://<project-ref>.supabase.co`; no path. |
| `MCP_PUBLIC_URL` | Canonical HTTPS MCP resource URL ending in `/mcp`. This existing setting alone does not enable OAuth. |
| `AGENTPASS_OAUTH_CLIENT_IDS` | Comma-separated list of exact, operator-approved Supabase OAuth client IDs. |

Set all three required values together, along with the trusted consent client,
session key and `SUPABASE_PUBLISHABLE_KEY` described below. OAuth without that
complete login/consent path fails startup. When Supabase OAuth and its client allowlist are absent,
`MCP_PUBLIC_URL` by itself leaves legacy opaque-agent authentication enabled.
Legacy Auth0 OAuth variables are rejected so a provider change cannot silently
leave a deployment in bearer-only mode. Never derive the MCP resource from the
inbound `Host` or forwarded-host headers.

Configure Supabase Auth OAuth 2.1 with the approved MCP clients and exact
redirect URIs. Configure asymmetric JWT signing with ES256 and a published
project JWKS; startup rejects `MCP_USE_OAUTH_SUPABASE_JWT_SECRET` because the
installed provider would otherwise switch to legacy shared-secret verification.
The installed `mcp-use@2.8.2` `oauthSupabaseProvider` publishes Supabase Auth
discovery metadata and verifies the signature, issuer, expiration, JWKS key,
and configured audience. AgentPass additionally requires the `authenticated`
role, `is_anonymous: false`, a verified allowlisted `client_id` (or compatible
`azp`), consistent subject/user IDs when both are present, the exact canonical
MCP `aud`, the standard `openid` OAuth scope, and an access-token lifetime of
no more than 600 seconds. Conflicting or missing client identity claims,
service-role tokens, anonymous users, oversized/stale tokens, and Supabase's
default `authenticated` audience are rejected. Do not derive authority from
email, `user_metadata`, client names, or other model-visible fields.

Supabase OAuth supports standard OIDC scopes rather than application-specific
scopes. The SDK advertises and requires `openid`; AgentPass budgets, actions,
suppliers and delegation continue to come from persisted AgentPass grants.
Supabase's default access-token audience is `authenticated`, so configure a
private Custom Access Token Hook that sets `aud` to the canonical
`MCP_PUBLIC_URL` for only the vetted AgentPass MCP clients. The hook must retain
the normal user `sub`, `role`, `is_anonymous`, and OAuth `client_id` claims, and
cap `exp` at `iat + 600`. Tokens with the default or a different audience fail
closed. Do not deploy a token hook that selects its audience from an untrusted
request parameter or user metadata.

Supabase's standard token expiry defaults to one hour. Reduce the issued
access-token lifetime to at most 600 seconds (including refreshed access
tokens) to meet the verifier limit; the Custom Access Token Hook applies the
same cap. Configure the host's refresh behavior as required. Refreshing an MCP
token must not create a new AgentPass connection or reset its grants.

Opaque service-agent credentials remain supported alongside OAuth. They are
checked against canonical authority `GET /v1/me` on each MCP request and resolve
to the persisted agent principal. A token with JWT structure is always handled
as a JWT; failed JWT verification is never retried as a service key. The opaque
path receives only an internal SDK gate scope after `/v1/me` succeeds; it does
not gain human identity or consent. Database and authority failures deny access.

The trusted sign-in form accepts either a numeric email code or the original
Supabase sign-in link copied from the email without opening it. This supports
default Supabase email templates without custom SMTP. Links must use the configured
project origin and verification path; the server sends only the token hash to
Supabase and checks the verified email against the pending sign-in session. It
never follows the submitted URL or its redirect. Supabase default email delivery
restrictions still apply.

For the first-party browser consent client, use a separate verifier configured
with only its approved client ID. Do not add it to
`AGENTPASS_OAUTH_CLIENT_IDS` unless it is also meant to use the public MCP
connection flow. Configure `AGENTPASS_CONSENT_CLIENT_ID`,
`AGENTPASS_CONSENT_CLIENT_SECRET`, and a 64-character hex
`AGENTPASS_CONSENT_SESSION_KEY` together with `SUPABASE_PUBLISHABLE_KEY`. The consent verifier checks the same
issuer, ES256 signature/JWKS, exact MCP audience, scope and token lifetime, with
its separate client allowlist. Set the bounded policy with
`AGENTPASS_ONBOARDING_SUPPLIER_IDS`, `AGENTPASS_ONBOARDING_SKU_IDS`,
`AGENTPASS_ONBOARDING_MAX_BUDGET_CENTS`, and
`AGENTPASS_ONBOARDING_MAX_PER_ACTION_CENTS`. Consent still requires the
one-use, CSRF-bound browser state described in
[A9](18-A9-ONBOARDING-CONTRACTS.md); a valid OAuth token alone is not consent
to issue authority.

The MCP server exposes the six account-onboarding tools from the shared A9
contract: `get_onboarding_context`, `provision_agent`, `list_agents`,
`get_agent`, `revoke_agent`, and `revoke_connection`. Context inspection adds a
trusted `/onboarding?connection=...` link as a separate text block when the
persisted connection requires consent. The link uses `MCP_PUBLIC_URL`; the
connection ID comes from the authority response, and the consent form remains
hosted by the authority service. The MCP server proxies only GET and POST
requests under `/onboarding`, caps request bodies at 2 KiB, forwards only cookie,
origin and content-type, and never forwards the MCP bearer token. These tools
use the authenticated HTTP MCP request; private runner claim, credential,
heartbeat and result endpoints are not published as MCP tools. The existing
CLI opaque-agent onboarding path remains available.

`MCP_PUBLIC_URL` is the canonical resource/audience. The private Custom Access
Token Hook must use an operator-maintained mapping from approved client IDs to
that resource; do not infer it from deployment request headers. Keep Supabase
client IDs and settings in private environment configuration. Do not commit
provider secrets or mutate hosted OAuth settings as part of local development.
Supabase OAuth grants can be revoked from Supabase; AgentPass connection or
membership revocation is checked against persisted state on each request.

## Verification boundary

The automated OAuth tests use a locally generated ES256 key and local JWKS
fixture. They cover valid signatures, exact issuer/audience, expiry and
token lifetime, client allowlisting/conflicts, anonymous and non-user roles,
missing scope, user ID consistency, service-key compatibility, and the no-JWT
fallback rule. They do not use a hosted Supabase project, real registered MCP
clients, or a hosted database. The consent proxy has local positive and negative
tests for its header allowlist, redirect/cookie preservation, method restriction
and 2 KiB body limit. The MCP onboarding fixture exercises public tool routes
with a local authority. Real host login, refresh, revocation, and the hosted
custom audience hook remain unverified until configured in the Supabase project.

Supabase references: [MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication),
[OAuth token security](https://supabase.com/docs/guides/auth/oauth-server/token-security),
and [OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows).
