# Coding-agent workforce demo (Developer B submission package)

> Current entry point: [all demo modes and visuals](25-EXPERIENCES.md). The full
> real-authority run now has 18 checks including wallets. The 12-check results and
> old branch/merge blockers below are historical; the authority integration is in
> `main`. Hosted workforce execution and provider preview hosting remain separate
> verification gates. Use [the stage runbook](24-WORKFORCE-DEMO-RUNBOOK.md) to present.

**What it shows:** a lead coding agent gets a landing page built by four specialist
agents (Design, Security, Hosting, Analytics). AgentPass visibly controls what each
one may touch, blocks what it may not, and lets one agent negotiate a permitted
alternative and resume on its own. Every agent does real, deterministic work; no
authorization event is replayed or fabricated.

## 1. Working demo command

```bash
npm install && npm --prefix apps/mcp/agentpass-manufact install   # once
npm run demo                                                      # on the REAL AgentPass authority: timeline + 12 checks, exit 1 on failure
npm run demo -- --authority mock                                  # same workflow on the labeled in-memory mock (fast offline path)
npm run demo -- --gateway remote                                  # AgentPass → HTTP → B's gateway service; Security agent as a separate process (12 checks)
npm run dev:activity                                              # then open http://127.0.0.1:3200/workforce.html and press Run demo
```

`npm run demo` starts from a **clean seeded state** every time: a fresh copy of
`demo-project/`, a fresh migrated SQLite running Developer A's authority app in-process
with the `demo-project` resource registered, fresh random credentials, and one
owner-issued workforce root grant to the lead (`buyer-agent`). Design, Hosting and
Analytics are **provisioned by the lead** through AgentPass `provision_child` (only the
SHA-256 of each new credential is sent); the external Security agent is a registered
principal in another organization (`sentinel-sec`) that the lead delegates to.

## 2. The workflow (what actually happens)

| Step | Agent | Real action | AgentPass decision |
|---|---|---|---|
| 1 | lead | opens its own session, receives the task | root grant `grant-root-lead` (repo r/w, deploy.preview, analytics.aggregate) |
| 2 | **Design** | reads `src/components/*`, `src/styles/*`; rewrites Hero, Features, stylesheet | delegated `repo.read, repo.write` on `src/components/**`, `src/styles/**` |
| 3 | Design | tries to read `.env` (negative check) | **DENIED RESOURCE_DENIED** |
| 4 | Design | tries to write `src/lib/newsletter.ts` | **DENIED RESOURCE_DENIED** |
| 5 | **Security** (external org `sentinel-sec`) | reads 8 files through the gateway, runs a rule-based scan: 6 findings, 2 high | delegated `repo.read` only on `src/**`, `package.json` |
| 6 | Security | tries `.env` and a file write | **DENIED RESOURCE_DENIED** / **AUTHORITY_REQUIRED INSUFFICIENT_SCOPE** (no `repo.write`) |
| 7 | lead | applies the report's fix: `escapeHtml(name)` in `src/lib/newsletter.ts` | lead's own root grant covers `src/lib` |
| 8 | **Hosting** | attempts `deploy.production` | **AUTHORITY_REQUIRED INSUFFICIENT_SCOPE**, `alternative_scope: deploy.preview` |
| 9 | Hosting | reads the hint; requests exactly `deploy.preview` with a justification | request filed against the lead's grant |
| 10 | lead | counteroffers `deploy.preview` on `preview`, 15-minute expiry | COUNTEROFFERED → Hosting accepts → new grant |
| 11 | Hosting | **real `next build` + `next start`**; returns the URL | ALLOW on the negotiated grant |
| 12 | **Analytics** | computes aggregates from `data/analytics-events.json` in code; 3 rule-based suggestions | delegated `analytics.aggregate` on `landing-page` |
| 13 | Analytics | tries `analytics.raw` | **AUTHORITY_REQUIRED INSUFFICIENT_SCOPE** (no grant carries it) |
| 14 | lead | revokes all 5 temporary grants; each specialist retries | **GRANT_REVOKED** ×4 |

### Money (added 2026-10-18): the same chain, AgentPass's purchase ledger

The owner also seeds the lead a **$1,000 root wallet** (`grant-root-wallet`: a purchasing grant for the in-process
`service-vendor`, at most $300 per purchase). AgentPass keeps money and file authority in separate grant families, so
every in-house specialist holds a pass *and* a wallet; the external auditor gets no wallet (purchasing grants never
leave the organization) and the lead pays its invoice itself.

| Step | Agent | Real action | AgentPass decision |
|---|---|---|---|
| M1 | lead | delegates a **$150** wallet (stock photos) to Design, **$100** (hosting slots) to Hosting, **$50** (data queries) to Analytics | `grant.delegate`, each a subset of the root wallet |
| M2 | Design | asks to buy 5 stock photos ($200) | **DENIED BUDGET_EXCEEDED** (over the $150 wallet) |
| M3 | Design | buys 2 stock photos ($80) | quote → purchase, reservation + commit on Design's wallet and the root wallet |
| M4 | lead | buys 2 review hours ($160) for Sentinel Sec on the root wallet | ALLOW |
| M5 | Hosting | asks to buy 2 hosting slots ($120) | **DENIED BUDGET_EXCEEDED** (over the $100 wallet) |
| M6 | Hosting | `request_authority` for **$200** more under the root wallet, with a reason | request filed |
| M7 | lead | reads the request; policy caps a top-up at 120% of the original wallet → counteroffers **$120** | COUNTEROFFERED → Hosting accepts → new $120 wallet under the root |
| M8 | Hosting | buys the 2 slots ($120) on the new wallet | ALLOW |
| M9 | Analytics | buys 1 warehouse query ($25) | ALLOW |
| M10 | Analytics | asks for **$500** to buy a raw export of visitor records (`raw-dataset`) | lead **REJECTS** (not something this task may buy) |
| M11 | lead | reads the root balance from AgentPass (`/v1/me` budgets): **$615 left of $1,000** (spent $385) | matches B's own ledger |
| M12 | lead | revokes the 4 wallets with the passes; each specialist tries its old wallet | **INVALID_CALLER** ×3 (provisioned credentials disabled) |

## 3. Observed results

### `npm run demo` (local, 2026-10-18 01:5x UTC, real AgentPass authority)

```
Authority: AgentPass (Developer A's authority, real grants, real execute gateway)

Outputs
  Preview URL: http://127.0.0.1:53687  [local-next-start: local build, not production]
  Security: [high] dangerouslySetInnerHTML fed by an unescaped value at src/components/Signup.tsx:11
  Security: [high] dangerouslySetInnerHTML fed by an unescaped value at src/lib/newsletter.ts:21
  Security: [info] dependency pinned to a non-exact version at package.json:17-20 (4 findings)
  Security fix applied by lead: yes (escapeHtml)
  Analytics: 3788 views, 207 signups, 5.46% conversion
    • twitter converts at 1.9% vs 5.5% site average (15/803 views): rework the landing message for twitter visitors or retarget them with a tailored CTA.
    • 58.1% of page views are mobile but the signup form has no mobile layout: add a stacked, full-width form and a larger submit button.
    • newsletter converts best at 10.8% (46/426 views, 5.5% site average): add a referral prompt for those visitors after signup.

Checks
  PASS   1. Design agent changes actual UI files                 Hero.tsx changed (245 → 606 bytes)
  PASS   2. Design agent cannot read .env                        INSUFFICIENT_SCOPE recorded; .env intact
  PASS   3. Security agent completes a real audit                6 finding(s), high on src/lib/newsletter.ts
  PASS   4. Security agent cannot modify source files            write attempt refused (read-only grant)
  PASS   5. Hosting agent requests production deployment         attempted deploy.production → AUTHORITY_REQUIRED
  PASS   6. AgentPass denies production authorization            OUTSIDE_PARENT_SCOPE with alternative deploy.preview
  PASS   7. Hosting agent requests narrower preview authority    requested deploy.preview; lead counteroffered COUNTEROFFERED
  PASS   8. Hosting agent deploys the preview successfully       http://127.0.0.1:53687 (local-next-start, local)
  PASS   9. Analytics agent computes real aggregate metrics      3788 views, 207 signups, 5.46% conversion, 3 suggestions
  PASS  10. Analytics agent cannot retrieve raw user records     analytics.raw refused; no emails in output
  PASS  11. Temporary grants are revoked after task completion   5 grant(s) revoked
  PASS  12. Attempts to reuse revoked grants fail                design/hosting/analytics-agent: INVALID_CALLER (credential disabled), security-agent: GRANT_REVOKED

12/12 checks passed
```

With money (2026-10-18, `npm run demo`, real AgentPass authority):

```
Money  (AgentPass purchase ledger; the vendor is an in-process stub, nothing is paid for real)
  Root wallet $1,000 → wallets: design $150, hosting $100, analytics $50
  design-agent     bought 2 × stock-photo for $80
  lead-agent       bought 2 × audit-hour for $160
  hosting-agent    bought 2 × hosting-slot for $120
  analytics-agent  bought 1 × data-query for $25
  design-agent     refused 5 × stock-photo $200 (BUDGET_EXCEEDED)
  hosting-agent    refused 2 × hosting-slot $120 (BUDGET_EXCEEDED)
  hosting-agent    asked $200 for hosting-slot → counteroffer $120 (policy caps a top-up at 120% of the original $100 wallet)
  analytics-agent  asked $500 for raw-dataset → rejected (raw-dataset is not something this task may buy)
  Spent $385; AgentPass says $615 left of $1,000
  PASS  13. Root wallet is $1,000; helper wallets are subsets of it
  PASS  14. Helpers buy through AgentPass with real receipts
  PASS  15. Spending over a wallet is refused (BUDGET_EXCEEDED)
  PASS  16. Hosting asks for more; the manager counteroffers less; hosting accepts and buys
  PASS  17. A top-up for raw user records is rejected by the manager
  PASS  18. Spend stays within $1,000, matches AgentPass’s ledger, and wallets die with the passes
18/18 checks passed
```

`--authority mock` still passes its 12; the six money checks are reported as **not run** there (the mock has no wallets), never faked.

### Test commands

```
$ npm run typecheck        → clean
$ npm test                 → Test Files 27 passed; Tests 149 passed | 2 skipped (A's Postgres suites need a DB URL)
```

Suites specific to this demo (`apps/workforce/test/`, `apps/activity/test/`):
`mock-authority` (12 rules), `gateways` (6, incl. a real build + serve), `design-agent`,
`security-agent`, `analytics-agent`, `hosting-agent` (2), and `activity` (6, one of which
runs the whole workflow through the live stream and asserts 12/12).

## 4. Screenshots

| Before (fixture) | After (Design agent's real edit, served by the Hosting agent's build) |
|---|---|
| ![before](evidence/landing-before.jpg) | ![after](evidence/landing-after.jpg) |

The demo screen (`/workforce.html`): agent team · authority state (grants, holders,
scopes, revocations, allow/deny/negotiate/revoke counters) · execution timeline ·
outputs (before/after, findings + fix, preview URL, analytics) · the 12 checks.

## 5. What is real and what is mocked

| Component | Status |
|---|---|
| Design edits, security scan, build + preview server, analytics math, revocation | **Real.** Deterministic code, no LLM calls, separate sessions per agent. |
| Tool gateways (`apps/workforce/src/gateways/`) | **Real.** The only path to files, deploys and data; `.env` is never readable, writable or listed. |
| Preview deployment | **Real local build** (`next build` + `next start`), labeled `provider: local-next-start`. No Vercel account was available on the build machine; nothing claims production. |
| Security agent as an external company | **Real separate principal and org** (`sentinel-sec`) with its own credential and a read-only grant. With `--gateway remote` it is a **separate process** (`apps/workforce/src/security-service.ts`) that alone holds its credential; the lead reaches it over HTTP with a per-task token and never sees the credential (tested). The default run keeps it in-process. |
| **Authority service** | **Real AgentPass** (Developer A's authority, `docs/11-WORKFORCE-CONTRACT.md`). `apps/workforce/src/real/authority.ts` adapts B's agent contract to A's wire contract; `apps/workforce/src/real/resource-adapter.ts` is the registered `demo-project` resource that AgentPass's execute gateway invokes after validating the live chain, paths and quota. The labeled in-memory mock remains as the fast offline test path (`--authority mock`). |
| Agent identities | **Real.** Design/Hosting/Analytics are provisioned by the lead via `provision_child` (server-generated ids, fresh credentials, hashes only on the wire); revoking their grant disables the credential (`INVALID_CALLER` on reuse). Security is a registered principal in `sentinel-sec`, delegated to cross-organization. |
| Agent-to-agent messaging | In-process calls through the orchestrator. Primitive was deliberately not integrated. |
| **Money** | **Real AgentPass purchase ledger**: purchasing grants (`$1,000` root wallet → subset wallets), A's quote → purchase path with per-action and chain-wide budget checks, reservation/commit ledger entries, `BUDGET_EXCEEDED`, the budget request → counteroffer → accept flow, wallet revocation and dead-wallet probes (`apps/workforce/src/wallet.ts`, `real/authority.ts`). The **vendor is simulated** (`apps/workforce/src/real/vendor.ts`: fixed catalog, simulated orders, implements A's `SupplierService` in-process); no money moves. |

## 6. Git summary

Ten commits on `feat/agent-demo`, merged to `main` via PRs #21 (agents, orchestrator,
demo command) and #22 (demo screen): **49 files, +5,670 lines**.

```
ccb2eed  workforce authority contract + labeled MOCK (12 rule tests)
b61df0d  demo landing page + repo/deploy/analytics gateways
7b9fd42  demo project's fake .env fixture (tracked on purpose)
40e18c2  agent base context + brief for the specialist agents
99d4d28  Hosting agent: production refused → preview negotiated → real local deploy
49f5780  lead orchestrator + npm run demo (12 checks)
b489d44  Analytics agent (code-derived insights, rule-based suggestions)
c0c5c66  Design + Security agents with tests
e77f813  unwrap specialist envelopes; exclude worktrees from vitest
de955ca  single-screen workforce demo UI driven by real events
```

Developer A's areas (`apps/authority/**`, `apps/mcp/**`, `db/**`, `packages/contracts/**`)
were not modified.

## 7. Remaining integration blockers

1. **A's workforce contract is on A's branch, not `main` yet.** This demo merges
   `codex/onboarding-contracts` (PRs #14/#18/#20) into `feat/agent-demo`; the real-authority
   path lands on `main` together with A's stack.
2. **Hosted run.** The workforce demo has not been run against the Manufact deployment
   (which only exposes the purchase-contract tools today); it runs locally.
3. **Security agent as a separate process.** Done locally (`--gateway remote`, see
   section 8); the hosted run still needs the gateway deployed next to A's server.
4. **Real preview hosting.** Vercel was not configured on the build machine; previews are
   real local builds and labeled as such.
5. **A's open PR #14** (self-service onboarding contracts) is waiting on Developer B's
   agreement to the A↔B runner protocol.

## 8. Hosted gateway (B's protected execution service)

A's authority can call B's resource adapter over HTTP instead of in-process
(docs/11, "Protected execution adapter"). B's side is
`apps/workforce/src/gateway-service.ts` (Express app) with the entry
`apps/workforce/src/gateway-main.ts`:

| Route | Auth | Behaviour |
|---|---|---|
| `GET /health` | none | `{status:'OK', resource:'demo-project', executions}` |
| `POST /internal/workforce/execute` | `X-Service-Key` (constant-time compare, 401 otherwise) | body `{execution_id, principal, input}` validated with `workforceActionSchema`; paths re-derived like A's `requestedPaths` and re-resolved with `resolveWorkforcePath` under the gateway's own root (400 on traversal, dotfiles, symlinks, absolute paths); dispatched to `createDemoProjectResource(...).execute`; returns `{status:'OK', data}` |

Deduplication: `execution_id` is the durable idempotency key. The service keeps
completed results in an in-memory map for the lifetime of the process (a replay
returns the first result and executes nothing; a concurrent duplicate awaits the
in-flight call). A multi-instance deployment would move that map to shared
storage. One JSON log line per request (`method, path, status, ms, service_key:
valid|invalid|missing, action, replay`); no bodies, paths, file contents or keys.

`npm run demo -- --gateway remote` runs exactly this topology locally: the
gateway is forked (`node --import tsx`) on a loopback port with a fresh random
service key, A's authority is configured through `workforceFromEnvironment`, and
the Security agent is forked as its own process (`security-main.ts`) with an
allow-listed environment that contains its credential and the task token, never
the lead's credential. Observed 2026-10-18: **12/12 checks passed**, the gateway
log shows one `POST /internal/workforce/execute` per protected action, and check
12 shows `security-agent: GRANT_REVOKED` probed from the separate process.

### Environment A's server needs (all three together)

| Variable | Value |
|---|---|
| `WORKFORCE_RESOURCES_JSON` | `[{"resource":"demo-project","organization_id":"buyer-co","owner_principal_id":"owner-1","repo_root":"<canonical project root>","allowed_actions":["repo.read","repo.write","security.audit.run","deploy.preview","analytics.aggregate.read"]}]` |
| `WORKFORCE_GATEWAY_URL` | the gateway's **HTTPS** URL (loopback HTTP is the only non-TLS form A accepts; redirects are refused) |
| `WORKFORCE_SERVICE_KEY` | the same secret the gateway holds (set as a secret, never in the repo) |

A keeps validating paths against `repo_root` before every call, so `repo_root`
must be a real directory on A's host as well as the gateway's.

### Environment the gateway needs

| Variable | Meaning |
|---|---|
| `WORKFORCE_SERVICE_KEY` | shared secret A presents as `X-Service-Key` (required) |
| `WORKFORCE_REPO_ROOT` | project the gateway operates on; realpath'd at startup (required) |
| `WORKFORCE_ANALYTICS_FILE` | events dataset (default `<root>/data/analytics-events.json`) |
| `WORKFORCE_ORG`, `WORKFORCE_OWNER` | resource owner identity (default `buyer-co`, `owner-1`) |
| `PORT`, `WORKFORCE_HOST` | listen port (default 4300) and bind address (default `0.0.0.0`) |

Start command: `node --import tsx apps/workforce/src/gateway-main.ts`.

The Security agent process takes `SECURITY_CREDENTIAL`, `SECURITY_TASK_TOKEN`,
`SECURITY_REPO_ROOT`, optional `SECURITY_AUTHORITY_URL` (pins which authority it
will use its credential against), `PORT` and `SECURITY_HOST`. Its routes
(`POST /identify`, `/audit`, `/probe`, all behind `X-Task-Token`) take the
authority URL in the body, which must be HTTPS or loopback and match the pin.

### Caveat: file actions need a shared repository root

From docs/11: filesystem registrations need a canonical shared repository root;
when the authority and the gateway run on different hosts without that shared
filesystem, file actions (`repo.read`, `repo.write`, `security.audit.run`,
`deploy.preview`) **fail closed**, because A resolves `repo_root` locally before
calling the gateway and the gateway resolves it again on its side. On Manufact
that means the gateway must be co-located with A's server (same container and
checkout) or only the non-file actions (`analytics.aggregate.read`) would work.
Nothing has been deployed or configured on Manufact for this; that decision is
the main session's.
