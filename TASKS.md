# Team Workboard — Owners, Sequence, Gates

**Deadline:** Sunday, Oct 18, 10:00 AM Pacific. Times are suggested Pacific checkpoints, not guaranteed durations.

## First 30–45 minutes (both)

- [ ] Create repo; commit these docs/contracts/fixtures; confirm everyone can clone.
- [ ] Agree on `apps/authority` on port `4100`, `apps/supplier` on `4200`, `apps/dashboard` on `3000`; configurable via env.
- [ ] Freeze names, JSON request/response shapes and auth rules in `docs/02-API-CONTRACTS.md`.
- [ ] Each developer runs mock curl/contract fixtures before implementing backend.
- [ ] Each pushes an independent feature branch and avoids editing the other's code.

## Developer A — Authority + MCP (owns `apps/authority`, `apps/mcp`, `db`)

- [ ] **A1 [P0]:** server, `/health`, API-key-to-principal middleware, seeded principals.
- [ ] **A2 [P0]:** create/root grants, subset-only child delegation, expiration, revocation.
- [ ] **A3 [P0]:** authority request lifecycle: `PENDING` → `COUNTEROFFERED` → `ACCEPTED` / `REJECTED`.
- [ ] **A4 [P0]:** inspect/authorize action; structured `AUTHORITY_REQUIRED`, `DENIED` errors.
- [ ] **A5 [P0]:** atomic ancestor-budget decrement + receipt + idempotency on simulated purchase.
- [ ] **A6 [P0]:** MCP adapter exposes tools and uses identical service functions as HTTP.
- [ ] **A7 [P0]:** tests: grant subset, no forged subject, expired/revoked, idempotent purchase, budget races.
- [ ] **A8 [P1]:** Manufact deployment after core integration and persistence are verified.

## Developer B — Agents + Supplier + Demo (owns `apps/buyer-agent`, `apps/sourcing-agent`, `apps/supplier`, `apps/dashboard`, `scripts`)

- [ ] **B1 [P0]:** stand up seller service with private inventory/costs; exposed quote and simulated order only.
- [ ] **B2 [P0]:** supplier's independent allow/deny policy; `margin.read` always denied to external buyers.
- [ ] **B3 [P0]:** buyer agent spawns sourcing agent (distinct authenticated principal / process).
- [ ] **B4 [P0]:** agent workers call MCP tools and handle `AUTHORITY_REQUIRED` → request/counteroffer → resume.
- [ ] **B5 [P0]:** end-to-end runner and event timeline from real calls; no fake logs.
- [ ] **B6 [P0]:** acceptance demo with controlled $850 quote and a $1,200 denial.
- [ ] **B7 [P1]:** Primitive async agent messaging transport; fallback local transport.
- [ ] **B8 [P1]:** visually clear one-screen dashboard / graph of delegation and decisions.

## Integration checkpoints

| Checkpoint | Gate | Responsible |
|---|---|---|
| Sat 2:00 PM | Shared contract frozen; `GET /health` and mock calls work | Both |
| Sat 5:00 PM | Parent/child delegation + mock supplier quote functional | Both |
| Sat 8:00 PM | Cross-service purchase, immutable quote and denial tests | Both |
| Sat 11:00 PM | Clean-room run, actual MCP tool calls, basic activity view | Both |
| Sun 7:00 AM | Sponsor integration (if safe), deployment, demo recording | Both |
| Sun 9:00 AM | Submission materials locked; final dry run | Both |
| **Sun 10:00 AM** | **Submission due** | **Both** |

These are checkpoints; adapt as needed without compromising mandatory gates.

## Planned follow-on — self-service MCP onboarding

The original checklist above is historical and is not a current completion report.
Use [the detailed A plan](docs/17-SELF-SERVICE-ONBOARDING-PLAN.md) for scope,
ownership and acceptance criteria; see [the headless release status](docs/23-HEADLESS-RELEASE.md)
for the merged deployment and current gates. The [October 17 rollout evidence](docs/21-SELF-SERVICE-ROLLOUT.md)
preserves earlier database, Vault and preview results.

Current implementation scope is Developer A only. PR #14 merged at
`c7e0d3cd054ac47b55e5a397103de1ec09854d46`; its hosted provisioning/no-purchase
verification ran on `7923e871-f0ac-4bf9-9579-ccb2695b967d`, and after-restart
identity/revocation verification ran on `4421a18e-49e8-4946-bd73-cd0300800350`.
Both used the same merged revision. These are verification IDs, not assertions about
the active deployment after documentation changes; consult the dashboard for the
current runtime. Both hosted phases and the final independent audit passed; private
fixture credential files and state were cleaned up. No purchase was executed and no
rollback was tested. Human OAuth remains disabled and Developer B's worker is
deferred. The merged tree matches tested revision `e61f958`: 199 root tests and a
separate 201-test run passed, along with TypeScript checks and the nested MCP build.

- [x] **A9:** [Agreed contract](docs/18-A9-ONBOARDING-CONTRACTS.md); B accepted the proposal via direct
  user confirmation and PR #14 is merged. Shared contracts were promoted by agreement.
- [x] **A10:** seed-free additive migrations; accounts, personal workspaces, memberships and connections; SQLite + disposable PostgreSQL verified.
- [ ] **A11:** OAuth ingress implemented; fixture JWT verification and service bearer compatibility pass. Real provider login/refresh/revocation gate open.
- [x] **A12:** trusted browser consent and bounded connection authority implemented and fixture HTTP tested; zero default budget, no reset. Hosted login remains A11/A16 gate.
- [x] **A13:** six conversational MCP tools implemented; official SDK fixture lifecycle passes, including isolation, private delivery, simulated purchase and revocation.
- [ ] **A14:** private Vault adapter, durable jobs/outbox, runner leases and recovery implemented; SQLite/PG fixture tests and hosted Vault encryption/privilege round-trip pass. Real runner delivery gate open.
- [ ] **A15:** persisted provenance, transactional connection/membership revocation and descendant denial implemented; real B-worker integration open.
- [ ] **A16:** readiness support and hosted additive migrations are verified; the prior preview rollout
  remains paused. Human OAuth/host journeys and full release readiness remain open; see
  [23](docs/23-HEADLESS-RELEASE.md).

**B dependency:** fixed-template worker execution/sandbox and optional dashboard
integration. A owns its authenticated control contract and may verify it with a
labeled fixture until B supplies the actual runtime. Shared contract changes need
both developers' agreement; production rollout remains a separate coordinated gate.

## Merge protocol

- Branches: `feat/authority-core` (A), `feat/agent-demo` (B).
- Each branch may add local stubs for the other service but **must not change shared contracts unilaterally**.
- By Gate 1 both parties use the fixtures in `fixtures/` as executable examples.
- Merge core first, then supplier/agents, then dashboard / sponsor work.
- In a conflict: preserve the frozen contract; adapt implementation rather than changing request shapes unexpectedly.
- Designate **Developer A** as API/contract approver, **Developer B** as demo/UX approver.

## Stop conditions

If P0 full integration is not passing by Sat 11 PM, stop sponsor integrations and UI polish. If still unstable Sunday 7 AM, remove dynamic third-party messaging and drive agents locally through the same MCP endpoints. Record a backup demo only after the live path works; be transparent about prerecorded content.
