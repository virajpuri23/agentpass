# Workforce demo runbook — 2:00 live, judge-facing

**Screen:** `http://127.0.0.1:3200/workforce.html`. An animated stage (Acme's manager and helpers on the left, AgentPass in the middle, the project on the right, the outside security firm bottom right) with a one-sentence caption under it, progress dots, and on the right the 12 checks, a small Results block and a collapsed Technical log with every raw event. No jargon on screen: agents are "the manager" and "helpers", grants are "passes", purchasing grants are "wallets". Green `$` packets are purchases through AgentPass to the vendor box under it; wallet badges on each node show the wallet and what it spent. Every packet that moves on the diagram is a real call by a separate agent session: one "reads/edits the page" move per helper (not one per file), every refusal (✕ at AgentPass, the locked door shakes), the ask-for-less exchange, and the passes being taken back.

## Pre-demo checklist (10 minutes before)

- [ ] `npm install && npm --prefix apps/mcp/agentpass-manufact install` done once; run `npm run demo` once so the npm cache is warm (each run copies `demo-project/` to a temp dir and runs `npm install --prefer-offline` there; cold, that is the only slow part).
- [ ] Port 3200 free (`lsof -iTCP:3200 -sTCP:LISTEN`); otherwise `ACTIVITY_PORT=3210 npm run dev:activity` and open that port.
- [ ] `npm run dev:activity`, open the page, light or dark both fine.
- [ ] Window ≥ 1280 wide so the diagram and the side panel sit side by side. **Speed: Slow** for a narrated run (≈1:40 on screen), Normal ≈0:45, Instant = the raw stream with no animation (≈0:05). Nothing is dropped or reordered; a page refresh catches up instantly to the server's buffer.
- [ ] Badge top left reads **`real AgentPass`** (green) = Developer A's real authority app, real grants, real execute gateway on a fresh SQLite. If it reads `practice mock` (amber) the run is on the labeled in-memory mock: say so, do not present it as the real thing.
- [ ] Do a full rehearsal run and leave the page open: a new run clears it.

## Script (Slow speed, ~2:00)

**Hook** (before pressing Run). *"A manager AI is about to get a landing page built by four helper AIs, one of them from another company. Nobody shares credentials. AgentPass hands each helper a pass that opens only the doors it needs, and you'll watch it say no, let a helper ask for less, and take every pass back, live."* Press **Run demo**.

Then read the caption as it changes; each one is a real event. The beats to point at on the diagram:

1. **The master pass and the wallet.** "The manager gets the job, one master pass and a $1,000 wallet from the owner." Even that pass cannot reach the live site or people's records; even that wallet is capped per purchase.
2. **Design.** Gets its own key, a smaller pass (read and edit, page layout files only) and a $150 wallet for stock photos. It tries to spend $200 on five photos: blocked by AgentPass; it buys two for $80. Then two more red lines: it tries the secrets file and a file outside its pass, both blocked. *(checks 1–2, 13, 15)*
3. **The outside reviewer.** Joins from another company with a look-only pass and **no wallet** (AgentPass never lets money leave the organization): the manager pays its $160 invoice from the root wallet. It does a real review, is blocked from the secrets file and from editing. The manager, which holds an editing pass, fixes the bug. *(checks 3–4, 14)*
4. **Publishing.** Gets a $100 wallet but two hosting slots cost $120: blocked. It asks the manager for $200 more; the manager answers with $120 (policy: a top-up is capped at 120% of the original wallet); it accepts and buys on the new wallet. Then it tries the live site: blocked, and AgentPass says what it may ask for instead. It asks for exactly that; the manager gives a 15-minute test-copy pass; the test copy goes live. *(checks 5–8, 15–16)*
5. **Numbers.** Gets a $50 wallet and buys one warehouse query ($25). Then it asks for $500 to buy a raw export of people's records: the manager rejects it outright. It gets totals (visits, signups, conversion), is blocked from people's individual records. *(checks 9–10, 17)*
6. **Taking the passes and wallets back.** Amber packets from the manager to AgentPass for every pass and wallet; locks appear on the helpers and their badges read "taken back". Then the helpers try their old passes and wallets and every attempt bounces off AgentPass with a ✕. Results shows the money: $385 spent of $1,000, $615 left, as AgentPass's own ledger says. *(checks 11–12, 18)*

**Close.** The caption reads *"Every rule held: 18 of 18"* and the six dots turn green. *"Every yes and no you saw was a real AgentPass decision for a real, separate agent, slowed down so you could follow it."* If asked for detail, open **Technical log**: every raw event with its code.

## If a run fails live

1. Press **Run demo** again: every run starts from a clean seeded state (fresh project copy, fresh SQLite, fresh credentials). A failed run shows a red caption and the failing check; the page stays usable.
4. Do not refresh mid-run to "fix" pacing: a refresh catches up instantly to the server's buffer; change Speed instead.
2. Backup, no browser: in a terminal `npm run demo` prints the same timeline, the money ledger and the 18 checks in about 10 s (`npm run demo -- --authority mock` if the authority itself will not start; say it is the labeled mock: it has no wallets, so the six money checks are reported as not run).
3. Port busy: `ACTIVITY_PORT=3210 npm run dev:activity`.

## Honest wording

- **Real:** authorization decisions (Developer A's authority app running in-process on a fresh SQLite), child provisioning with hashed credentials, delegation as a strict subset, the `AUTHORITY_REQUIRED` → request → counteroffer → accept negotiation, the money (purchasing grants, AgentPass's quote → purchase path with per-action and chain-wide budget checks, its reservation/commit ledger, `BUDGET_EXCEEDED`, the budget request → counteroffer → accept flow, wallet revocation), the file edits (Hero, Features, stylesheet, the `escapeHtml` fix), the rule-based security scan, the `next build` + `next start` preview, the analytics aggregates computed in code, revocation and the failed reuse probes.
- **Simulated / local:** the vendor (stock photos, review hours, hosting slots, data queries) is an in-process stub with fixed prices and simulated orders; no money moves. The "test copy" is a local Next.js build served on a loopback port, not a hosting provider; there is no production target at all, so "the live site" is a refusal of an action no pass carries. The security reviewer's scan is deterministic rules, not an LLM. Agents are deterministic programs, not LLM-driven (that is deliberate: the authorization path is what is on trial).
- **Pacing:** the stream is paced client-side for narration (Speed). Nothing is dropped or reordered; Instant shows the raw stream.
