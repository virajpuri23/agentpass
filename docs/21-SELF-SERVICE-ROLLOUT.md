# Self-service onboarding implementation and rollout

**Historical snapshot — October 17, 2026.** This record preserves the then-current
Supabase/Manufact configuration, database migration, Vault and preview evidence.
It predates PR #14's merge. For current deployment and hosted provisioning results,
see the [headless release status](23-HEADLESS-RELEASE.md). Any pending gate or rollout
status below reflects October 17 only.

## Implemented local behavior

- Service agents continue to use the headless CLI or existing MCP tools with their
  own opaque credential. Trusted parents can provision a subset child without a UI.
- Human OAuth creates a stable account, personal organization, owner membership
  and per-client connection principal. No organization ID, owner credential or
  budget is supplied by the model. Sign-in creates no grant.
- A separate first-party browser login and explicit bounded consent creates one
  immutable root allocation. The form defaults to quote-only, zero purchase
  budget. Refresh and reconnect reuse the connection and existing allocation.
- Six additive remote MCP tools inspect context and provision/list/get/revoke
  managed children. The trusted backend generates and privately stores each child
  credential. Public responses contain only safe state and effective authority.
- Provisioning intents, child issuance and launch jobs are durable. Runner claims
  are admitted by key hash and exact organization list. A child proves its own
  identity before readiness. Lease loss after credential delivery revokes it.
- Connection revocation and trusted membership removal deny the whole dependent
  grant chain immediately. `AccountService.deactivateMembership()` is an internal
  administrative service operation, not a public/model-selectable endpoint.
- Accounts, membership, client/connection, consent, parent/child grants, managed
  agent and job IDs persist provenance. Audit rows correlate by principal, grant,
  request and trace; join those IDs to the private records. No full OAuth payload,
  raw bearer token or unrestricted runner summary is stored in audit.

The dashboard remains optional inspection. Initial human consent is intentional;
an agent cannot manufacture a new person's authorization. Unattended delegation
then stays within the approved policy.

## Configuration

All OAuth configuration and secrets belong in the private deployment environment.
Never paste secret values into a chat, tool argument, prompt, issue or tracked file.
The local `.env` inventory contains none of the new OAuth/consent/runner variables.
The authorized hosted Supabase schema rollout has since been applied; OAuth
provider settings and client bindings remain unconfigured. Current hosted evidence
and the preview pause are recorded below.

Manufact production remains deployment
`a172a512-c609-42c5-8cff-a4365d5ed4f3`, revision `a808f1690456660ab97c0ff02d98c2689e011d60`,
at `https://fast-steel-94x84.run.mcp-use.com/mcp`. Its 11 saved/default variable
names still include no new OAuth, consent, Vault-store or runner configuration;
secret values were not read. The user authorized sharing only `DATABASE_URL`,
`DATABASE_CA_CERT`, `SUPPLIER_SERVICE_KEY`, `SUPPLIER_URL` and `NODE_ENV` with the
preview environment. Owner, buyer, sourcing-agent and supplier API keys remain
production-only. Production stays on `feat/authority-core` with automatic
deployments; PR #14 has not changed production.

The existing AgentPass Supabase project `ebkcaqaybuklllefvuyv` has only its
`main` branch, labeled PRODUCTION. With the user's approval, four additive
migrations were applied and verified there: `20261017233948_onboarding_accounts`,
`20261017234432_agent_runner_control`, `20261018000216_runner_workspace_assignments`
and `20261018000712_oauth_resource_binding`. The pre-existing row counts are
unchanged: organizations 2, principals 4, grants 30, ledger entries 20 and
purchases 8. All 13 onboarding/control tables have RLS enabled. Vault exists;
`anon` and `authenticated` cannot select ciphertext or plaintext and cannot execute
the token hook; `supabase_auth_admin` can execute it. A bounded private Vault
round-trip passed: ensure, repeat ensure, read, encrypted-at-rest check, remove and
missing-secret rejection. The random fixture was deleted; no real agent key, grant
or purchase was created. This verifies the hosted Vault adapter, not runner delivery.

OAuth is not live: no OAuth resource-client mappings were inserted and the custom
access-token hook has not been enabled. The dashboard's OAuth-server switch was
only changed in an unsaved form; persisted configuration remains off. No host
OAuth client, SMTP delivery or browser login has been verified.

Manufact rejected preview deployment
`66b4a08d-524d-4366-8243-bd2d6005e1d1` before build (`PLAN_LIMIT_PREVIEW_DEPLOYS`,
null source SHA): preview deployments require the Hobby plan or higher. The user
chose to keep the current plan and pause hosted preview rollout. The failed record
has no build or running application. The approved preview environment scopes are
present, but resuming would connect preview code to the same production database
and supplier settings; this is not an isolated staging data plane.

See [A11 configuration](19-A11-OAUTH.md) for issuer, client allowlist, audience and
600-second token requirements. Supabase's default `aud:"authenticated"` is rejected
by AgentPass; use the private audience hook below for approved OAuth clients.

| Variable | Meaning |
|---|---|
| `MCP_USE_OAUTH_SUPABASE_URL` | Supabase project HTTPS URL; issuer is this URL plus `/auth/v1`. |
| `SUPABASE_PUBLISHABLE_KEY` | Modern public project key (`sb_publishable_...`) for sign-in/provider consent; never use a service-role key. |
| `MCP_PUBLIC_URL` | Canonical HTTPS `/mcp` resource, never derived from request headers. Existing legacy uses remain supported. |
| `AGENTPASS_OAUTH_CLIENT_IDS` | Comma-separated exact approved host client IDs. |
| `AGENTPASS_OAUTH_REDIRECT_URIS` | JSON array of exact registered host callbacks, used for safe already-approved grant redirects. First-party callback is added automatically. |
| `AGENTPASS_CONSENT_CLIENT_ID` | Separate first-party confidential consent client. |
| `AGENTPASS_CONSENT_CLIENT_SECRET` | Private first-party client secret. |
| `AGENTPASS_CONSENT_SESSION_KEY` | 64 lowercase hex characters, 256-bit AES-GCM key. Shared across authority replicas; rotating it invalidates pending sessions. |
| `AGENTPASS_ONBOARDING_SUPPLIER_IDS` | JSON array of explicit permitted supplier IDs; defaults `[]`. |
| `AGENTPASS_ONBOARDING_SKU_IDS` | JSON array of explicit permitted SKU IDs; defaults `[]`. |
| `AGENTPASS_ONBOARDING_MAX_BUDGET_CENTS` | Nonnegative total simulated-purchase consent ceiling; defaults `0`. |
| `AGENTPASS_ONBOARDING_MAX_PER_ACTION_CENTS` | Nonnegative per-purchase ceiling, at most total; defaults `0`. |
| `AGENTPASS_CREDENTIAL_STORE` | `vault` explicitly enables the private PostgreSQL Vault store; no plaintext fallback. |
| `AGENTPASS_RUNNERS_JSON` | JSON array of `{id,keyHash,organizationIds}` admissions; keyHash is SHA-256, not a bearer key. No wildcard organizations. |
| `AGENTPASS_ONBOARDING_RUNNER_ID` | Optional configured trusted runner ID for automatic persisted personal-workspace assignment. |

Register exactly `https://<canonical-origin>/onboarding/callback` for the consent
client, using `client_secret_basic` token authentication. Enable Supabase OAuth
2.1 and configure its authorization path as `/onboarding/identity` at the canonical
Site URL. This trusted route supports email OTP sign-in and provider client
approval/denial, then the connection budget review occurs separately. Configure
the email template to display the OTP code; no bearer token enters browser storage.
Supabase's default mail sender is restricted to project team addresses and two
messages per hour. Public email onboarding requires configured production SMTP
and suitable rate limits; see [Supabase email delivery](https://supabase.com/docs/guides/auth/auth-smtp).
Configure provider-approved host callback/registration separately. Keep
the consent client outside the public host allowlist unless deliberately approved
for that separate use. Consent sessions expire after five minutes, use random
HttpOnly/Secure/SameSite=Lax cookies, store only hashed IDs and encrypted payloads,
and are bound to state, PKCE, human account, exact connection and CSRF token.
No email claim establishes account identity or organization membership. OAuth
requires the supported `openid` scope; supplier permissions come only from grants.

The migration installs `agentpass.oauth_access_token_hook(jsonb)` and the private
`oauth_resource_clients(client_id,resource)` configuration table. Populate that
table with each approved host client ID and the first-party consent client ID,
all mapped to the exact staging or production `/mcp` resource they serve. Use
different OAuth clients for different resources; do not repoint a production
client to staging. Enable
the hook in Supabase Auth's Custom Access Token Hook setting. Do not change an
existing hook without reconciling its policy. It preserves normal sign-in tokens,
and sets only approved OAuth clients' audience and a lifetime of at most 600s.
It ignores editable user metadata, anonymous sessions and service-role claims.
Only `supabase_auth_admin` and the private backend owner can execute it; PUBLIC,
anon and authenticated roles receive no access. Client registration alone does
not add a client to this table or the application's allowlist.

Service policy limits consent to one hour and delegation depth two (narrower than
the agreed maximum 24-hour connection lifetime). Child depth decreases from the
parent. Existing canonical ancestor ledger and supplier policy govern every effect.
Connection limits are ten live children, three pending launches, five new intents
per minute; retries of the same request do not replenish budget or create children.

The user approved automatic assignment to one configured trusted runner. Set
`AGENTPASS_ONBOARDING_RUNNER_ID` to an ID already present in the private runner
admissions. A consented personal workspace receives a durable assignment on its
first provisioning intent; models cannot select a runner or organization.
Conflicting assignments fail closed. Existing explicit organization admissions
remain supported, and an empty organization list only works for the configured
automatic runner. There is no wildcard. Real execution still needs B's worker.

## Schema-first staging procedure

Use Node 24 and a dedicated disposable/staging database for any new environment.
The existing AgentPass production project has already received the four additive
migrations above under explicit approval; preserve their checksum history. Migration commands load
the environment already present in the process; they do not implicitly load `.env`.
They do not seed demo identities, need demo agent keys or log a database URL.

```sh
npm run db:migrate -- --target postgres
# SQLite development alternative, using AUTHORITY_DB_PATH:
npm run db:migrate -- --target sqlite
```

The base schema is retained. Ordered account and runner migrations are recorded
with SHA-256 checksums in `schema_migrations`. PostgreSQL additions use the private
`agentpass` schema with RLS and no PUBLIC grants or permissive public policies.
The backend role is privileged and must remain private; RLS is not a substitute
for canonical account/authority checks. Startup with OAuth enabled checks all
migration checksums and refuses missing or edited history. It does not migrate.

To resume, first resolve the hosting target with the user; the current Manufact
plan does not permit a preview. Sharing the existing production database and
supplier settings with preview is already explicitly authorized. Then register
separate preview OAuth clients, configure the canonical Site URL and identity path,
populate exact resource bindings, enable the token hook, and set the private
application configuration above before running the host journeys. Verify
private runner-control network access separately. New public MCP tools
never proxy internal job/credential routes. B workers need a private authority URL
and only their admitted runner key; spawned children receive only their own key.

For rollback, return to the previous compatible code and retain additive tables,
grants, keys, ledger and audit history. Do not drop identity records or reset
allocations. Disable new signup/provisioning configuration until dependencies are
healthy; revocation and expiry remain canonical enforcement boundaries.

## Evidence and remaining gates

**FIXTURE:** local signing keys/JWKS prove JWT validation, while mocked provider
code exchange proves browser state, PKCE, CSRF and account binding. Local HTTP
tests complete consent → provision → private delivery → child readiness → simulated
purchase → result → revoke. They verify persisted grants/approvals, one ancestor
debit, no reconnect allocation reset, isolation and immediate revocation. This is
not a hosted Supabase Auth, model-worker, ChatGPT or Claude success claim.

**PASSED:** account/migration and runner suites include SQLite and disposable local
PostgreSQL. Full suite/typecheck/build results and exact revision are recorded
after final integration verification below.

Final local code revision: `7e9af22` (documentation-only updates follow). Node 24:
root TypeScript check, nested MCP TypeScript check and production build passed.
All **191 tests passed, none skipped, across 28 files**, with both disposable
PostgreSQL variables enabled and files run serially. This includes the original
golden path, official SDK MCP lifecycle, ES256 JWT checks, trusted OTP/consent,
resource hook, assignment restart, revocation, isolation and shared-budget races.
The A-only readiness follow-up also reproduced and fixed expired-lease access
without control polling: principal and ancestor checks now reject delivered
children with expired or invalid leases before any protected action. A bounded
25-row reconciliation pass runs at startup and every ten seconds in both authority
entry points, recovers pending issuance and retries private-secret cleanup; shutdown
waits for an active pass. Tests cover child and descendant denial, startup recovery,
and cleanup failure/retry. Authorization does not depend on that timer firing.

OAuth startup now requires the complete trusted consent/login configuration.
Runner/Vault settings without OAuth fail instead of silently enabling legacy mode.
The old `MCP_USE_OAUTH_SUPABASE_JWT_SECRET` setting is rejected: the installed
provider would otherwise select shared-secret verification rather than ES256/JWKS.
Documentation links and `git diff --check` also pass. No GitHub Actions workflow
is configured in this checkout; local checks are the available automated evidence.

**PAUSED / UNVERIFIED:** the user paused hosted preview rollout after the plan
rejection. Real Supabase OAuth/client/hook setup, B's fixed-template model/sandbox worker,
real ChatGPT and Claude login/refresh/reconnect,
and staged hosted persistence/rollback. These need private configuration or B's
runtime; none can be inferred from a green fixture test. Hosted schema and Vault
checks above passed independently of these remaining gates. B's branch
`feat/agent-demo` at `fb4c1568b08c2175d141f807fa32982ef4bccddc` contains separate
deterministic buyer/sourcing processes and a real MCP simulated-purchase demo.
It has no model client and does not consume the new private runner protocol.
The fetched A target contains no buyer/sourcing worker source.

Before a rollout approval, capture one new person in ChatGPT, the same account in
Claude, and a second isolated person; correlate exact revision/migration versions,
issuer/resource/client IDs, connection/agent/job IDs, audit trace and simulated
receipt. Complete permitted action, denial, result, revocation, refresh, reconnect,
concurrent budget and secret-leak checks in both hosts. Review the exact head and
required checks before any production merge; the A target auto-deploys.

See [the B runtime handoff](20-DEVELOPER-B-RUNNER-HANDOFF.md). A15/A16 remain open
until these real integration gates pass.

The user's current scope is **Developer A only**. The A-owned implementation and
local fixture gates are complete; B's worker is deferred rather than implemented
by A. Full A11/A16 release acceptance still needs a running compatible deployment,
Supabase OAuth/client/hook and email configuration, and the real ChatGPT/Claude
login, refresh, reconnect, isolation and revocation evidence. The user has paused
the hosted preview rollout, so these are pending release gates, not local passes.
