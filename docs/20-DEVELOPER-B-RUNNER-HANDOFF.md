# Developer B handoff: one real sourcing worker

A owns the authority, consent/OAuth boundary, durable child issuance and private
job protocol. B owns `sourcing-v1` execution, its sandbox/process lifecycle,
model-provider configuration and the live demo runner. All orders remain simulated.
The additive A9 protocol was accepted by B through the user's confirmation in the
coordinating chat. Schemas are exported as `onboardingSchemas` from
`packages/contracts/src/index.ts`; reuse these rather than inventing payloads.

## Existing B baseline

Read-only inventory of `origin/feat/agent-demo` at
`fb4c1568b08c2175d141f807fa32982ef4bccddc` found separate deterministic buyer and
sourcing processes, an IPC launcher, distinct preconfigured keys, real MCP
negotiation and a simulated-purchase demo. The decider exposes an injectable LLM
interface but has no model client implementation; the demo labels decisions
deterministic. None of that branch consumes the new claim/lease/delivery/ready/result
protocol or deduplicates a `launch_id`.

Reuse that authority/MCP behavior. Replace fixed child identity/key assumptions
with the issued child binding from A's job. The current worker expects a structured
`PurchaseTask`, while this accepted job has bounded `task:string`; add a validated
adapter for `sourcing-v1`, keeping task text untrusted. It cannot choose shell
commands, images, credentials, runner identity or authoritative prices. Do not
change the wire field to an object without renewed shared-contract agreement.

## What A supplies

- Connection-bound `provision_agent`, `list_agents`, `get_agent`, `revoke_agent`
  authority services; OAuth/consent and MCP mounting are integrated by the
  coordinating A chat.
- Persisted provisioning intent before secret work, stable private secret name,
  canonical child issuance and one launch job committed in one transaction.
- Authenticated runner admission by credential hash, explicit organization IDs or
  a persisted personal-workspace assignment to one configured trusted runner;
  no organization wildcard or model-selected runner identity.
- Private child-only credential delivery; no parent/owner key, database access or
  secret-store reference is returned. Delivery responses use `Cache-Control:no-store`.
- One 30-second lease per job; worker readiness requires that exact child's own
  authenticated request. A runner cannot declare a process READY.
- Three claims maximum before delivery. After delivered-credential lease loss,
  authority is revoked and the instance fails; the credential is never reassigned.
- Persisted lifecycle/audit IDs and canonical grant/ledger enforcement. A tool's
  successful acceptance or process startup alone never means a working agent.

## Exactly what B must deliver

1. **One fixed `sourcing-v1` runner.** Read `AGENTPASS_CONTROL_URL` and a distinct
   runner credential from B's private runtime environment. Do not accept arbitrary
   images, commands, code templates or a model-supplied organization. Register its
   credential SHA-256 hash and organization allowlist through trusted A deployment
   configuration (`AGENTPASS_RUNNERS_JSON`). The runner never receives SQL/Vault access.
2. **Durable launch deduplication.** Persist `launch_id -> process/run` before
   launching. Concurrent claims/restarts must not start two workers for one launch.
   The task field is untrusted user text; keep it separate from system instructions,
   runtime configuration, credentials and shell execution.
3. **Private credential injection.** Claim a job and fetch its credential through
   the private protocol below. Inject only the child key into its isolated runtime.
   Keep keys out of model messages, task text, URLs, command arguments, stdout,
   traces, provider callbacks, dashboards and results. Do not inherit an owner key.
4. **Prove child identity and readiness.** The child calls the supplied `mcp_url`
   with its own bearer key, calls `get_my_grants`, and verifies the returned grant ID.
   The child then calls the ready route with its own bearer key and exact claim ID.
5. **Execute through MCP.** Request a supplier quote, handle `AUTHORITY_REQUIRED`,
   request authority, wait for an authorized parent's narrowed counteroffer, accept
   it, then resume with the issued grant. Use stable execution idempotency keys.
   All amounts come from the supplier quote. A model cannot approve itself.
6. **Heartbeat and stop.** Heartbeat every 10 seconds. Any denial, expiry,
   `stop:true`, missing claim or uncertainty about launch ownership means stop the
   worker. Persist one terminal result; do not restart a failed/revoked credential.
7. **Provide the real demo runner and evidence.** Add B's `scripts/run-e2e.ts` and
   required worker source/config. Show real MCP calls and persisted receipts/audit,
   including a denied over-budget action and denied action after revocation. An
   optional dashboard consumes the same safe APIs; it is not required for completion.

## Private protocol

These routes live on A's authority service, not the public MCP tool surface.
`AGENTPASS_CONTROL_URL` must reach that service over a private network or an
explicitly approved HTTPS control ingress. The embedded Manufact authority uses
loopback; an external runner cannot reach it merely by knowing the public MCP URL.
Co-locate B's runner or configure private reachability before integration. Never
publish supplier/internal routes as a shortcut.

Runner calls use `Authorization: Bearer <private runner credential>` and JSON.
Every response uses `{status:"OK",data:...}` or the canonical machine-readable
error envelope. IDs are handles, never authentication. The runner is admitted only
for explicit server-configured organizations.

| Method/path | JSON body | Success data |
|---|---|---|
| `POST /internal/agent-jobs/claim` | `{idempotency_key}` | `{job:null}` or job with `job_id,agent_id,claim_id,launch_id,template_id,task,grant_id,lease_expires_at` |
| `POST /internal/agent-jobs/:job_id/credential` | `{claim_id}` | `{credential,mcp_url,expires_at}`; private/no-store |
| `POST /internal/agent-jobs/:job_id/heartbeat` | `{claim_id}` | `{stop:false,lease_expires_at}` for a live lease; denial means stop |
| `POST /v1/agent-runs/:job_id/ready` | `{claim_id}` | Agent instance; **child bearer**, never runner bearer |
| `POST /internal/agent-jobs/:job_id/result` | `{claim_id,outcome:"COMPLETED"|"FAILED",summary}` | Agent instance with persisted execution outcome |

- Repeat an exact claim idempotency key to recover its current live claim. Use a
  fresh key for a new poll after `job:null`. A stale prior claim key never claims a
  different job. Retain the same `launch_id` across pre-delivery lease recovery.
- Repeat credential retrieval only for the same live claim. A records delivery
  before reading the secret; a lost reply is treated conservatively as delivery.
- The ready request is refused before credential delivery or for a different child,
  expired claim, revoked authority or terminal job.
- `COMPLETED` requires READY. Identical live result replay is accepted; changed replay
  is denied. Raw summaries are not persisted or echoed because they may contain
  provider exceptions/secrets; A stores outcome and an input hash only. Result
  inspection currently means lifecycle plus correlated canonical action/audit
  evidence, not an arbitrary document/output-artifact store.
- Revocation is enforced by authority before best-effort secret cleanup or worker
  shutdown. Delayed polling cannot keep a revoked grant usable.

## Local and hosted configuration gates

A's startup enables the control surface through the onboarding configuration.
Relevant private deployment settings:

- `MCP_PUBLIC_URL`: canonical HTTPS MCP resource and worker endpoint.
- `AGENTPASS_CREDENTIAL_STORE=vault` with `DATABASE_URL`: enables Supabase Vault
  storage through the backend SQL role. No plaintext or process-memory fallback is
  enabled in production. Missing storage returns `SERVICE_UNAVAILABLE`.
- `AGENTPASS_RUNNERS_JSON`: array of `{id,keyHash,organizationIds}` admissions.
  Supply hashes privately; never commit real runner credentials or tenant IDs.
  Alternatively set `AGENTPASS_ONBOARDING_RUNNER_ID` to an existing trusted runner
  ID. The user approved automatic persisted assignment for consented personal
  workspaces. Only that runner may have an empty explicit organization list;
  assignment conflicts fail closed. B authenticates normally and receives only
  admitted jobs. Without a live worker, PROVISIONING must not be presented as running.
- Apply the ordered account and runner migrations with the seed-free migration
  command before compatible application code. Do not reset demo keys or ledgers.
- OAuth/consent values and host setup are in `19-A11-OAUTH.md` and the coordinating
  consent runbook. First-login/default spending is zero. A real purchase demo needs
  a trusted policy cap and explicit human consent/allocation; reconnect must not
  replenish it. Existing hosted budgets must be read before selecting the demo.

Before enabling Vault, verify extension availability and use a dedicated backend
role. Revoke PUBLIC/anon/authenticated/worker access to Vault secrets/decrypted views
and creation/deletion functions; keep Vault out of public Data API exposure. SQL
parameter/body logging must not capture secret arguments. A's adapter uses
parameterized `vault.create_secret` and `vault.decrypted_secrets`; actual Vault
storage/privileges are UNVERIFIED until a dedicated staging test passes. See the
[official Vault documentation](https://supabase.com/docs/guides/database/vault).

## Supplier recovery dependency, separate from normal happy-path execution

B's supplier must eventually expose an agreed, service-authenticated, read-only
lookup by A's original fulfillment `request_id`. It must return immutable public
outcome evidence bound to buyer, quote, supplier/SKU, quantity, USD amount and a
completed order ID, and must never create an order. Without this primitive,
uncertain fulfillment after expiry/revocation remains safely reserved; it is not
safe to retry fulfillment or release funds from a denial alone. This endpoint is
not invented by A; add it only through a coordinated contract change.

## Acceptance and evidence

A's local tests label the secret store and runner FIXTURE. They prove durable
intent, issuance/job atomicity, restart recovery, idempotency, tenant isolation,
lease races, private no-store delivery, child readiness, revocation and failure
recovery on SQLite and disposable PostgreSQL. They do not launch B's model worker.

B's integrated gate must prove:

- New verified user -> trusted consent -> provision -> one real child process ->
  own-key MCP authentication -> permitted simulated action -> inspect -> revoke.
- Same-account reconnect preserves workspace/usage; a second person is isolated.
- $1,200 request narrowed to an authorized $900 -> trusted $850 simulated purchase
  -> exact replay with one supplier order and one debit per ancestor (using an
  explicitly authorized fresh allocation).
- Missing scope, supplier-private-data access, forged identity, duplicate launch,
  budget race, expired lease and post-revocation action are denied.
- Restart after issuance/claim/launch creates no duplicate child/worker/order; after
  delivery uncertainty, A revokes rather than reassigns the credential.
- Exact commit, migration versions, deployment/control/MCP URLs, sanitized
  connection/agent/job/claim/receipt/audit IDs and outcomes are recorded. Test both
  real ChatGPT and Claude hosts before claiming either host journey complete.

Production rollout, actual Auth0/Vault configuration and both real host journeys
remain coordinated staging gates. Do not merge into an auto-deploying branch or
run hosted migrations as an incidental test.
