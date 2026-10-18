# Workforce demo runbook — 2:00 live, judge-facing

**Screen:** `http://127.0.0.1:3200/workforce.html`. One button, one plain-English story that appears line by line: five chips for the team (manager + four helpers), a "What happens" list (one ✓ / ✕ / ! line per real AgentPass decision), a small Results block, the 12 checks, and a collapsed Technical log with every raw event for anyone who asks. No jargon on screen: agents are "the manager" and "helpers", grants are "passes", the authority is "AgentPass".

## Pre-demo checklist (10 minutes before)

- [ ] `npm install && npm --prefix apps/mcp/agentpass-manufact install` done once; run `npm run demo` once so the npm cache is warm (each run copies `demo-project/` to a temp dir and runs `npm install --prefer-offline` there; cold, that is the only slow part).
- [ ] Port 3200 free (`lsof -iTCP:3200 -sTCP:LISTEN`); otherwise `ACTIVITY_PORT=3210 npm run dev:activity` and open that port.
- [ ] `npm run dev:activity`, open the page, light or dark both fine.
- [ ] **Speed: Slow** for a narrated run (≈1:30 on screen), Normal ≈0:45, Instant = the raw stream (≈0:05). Nothing is dropped or reordered; a page refresh catches up instantly to the server's buffer.
- [ ] Badge top left reads **`real AgentPass`** (green) = Developer A's real authority app, real grants, real execute gateway on a fresh SQLite. If it reads `practice mock` (amber) the run is on the labeled in-memory mock: say so, do not present it as the real thing.
- [ ] Do a full rehearsal run and leave the page open: a new run clears it.

## Script (Slow speed, ~2:00)

**Hook** (before pressing Run). *"A manager AI is about to get a landing page built by four helper AIs, one of them from another company. Nobody shares credentials. AgentPass hands each helper a pass that opens only the doors it needs, and you'll watch it say no, let a helper ask for less, and take every pass back, live."* Press **Run demo**.

Then read the lines as they appear; each one is a real event. The beats to point at:

1. **The master pass.** "The manager gets the job and one master pass from the owner." Even that pass cannot reach the live site or people's records.
2. **Design.** Gets its own key and a smaller pass (read and edit, page layout files only). Two red lines: it tries the secrets file and a file outside its pass, both blocked. *(checks 1–2)*
3. **The outside reviewer.** Joins from another company with a look-only pass, does a real review, is blocked from the secrets file and from editing. The manager, which holds an editing pass, fixes the bug. *(checks 3–4)*
4. **Publishing.** Tries the live site: blocked, and AgentPass says what it may ask for instead. It asks for exactly that; the manager gives a 15-minute test-copy pass; the test copy goes live. *(checks 5–8)*
5. **Numbers.** Gets totals (visits, signups, conversion), is blocked from people's individual records. *(checks 9–10)*
6. **Taking the passes back.** One line grows as the five passes are taken back; the chips turn red. Then the helpers try their old passes and every attempt is blocked. *(checks 11–12)*

**Close.** The green line: *"Every rule held: 12 of 12 checks passed."* *"Every yes and no you saw was a real AgentPass decision for a real, separate agent, slowed down so you could follow it."* If asked for detail, open **Technical log**: every raw event with its code.

## If a run fails live

1. Press **Run demo** again: every run starts from a clean seeded state (fresh project copy, fresh SQLite, fresh credentials). A failed run shows a red line and the failing check; the page stays usable.
2. Backup, no browser: in a terminal `npm run demo` prints the same timeline and the 12 checks in about 10 s (`npm run demo -- --authority mock` if the authority itself will not start; say it is the labeled mock).
3. Port busy: `ACTIVITY_PORT=3210 npm run dev:activity`.

## Honest wording

- **Real:** authorization decisions (Developer A's authority app running in-process on a fresh SQLite), child provisioning with hashed credentials, delegation as a strict subset, the `AUTHORITY_REQUIRED` → request → counteroffer → accept negotiation, the file edits (Hero, Features, stylesheet, the `escapeHtml` fix), the rule-based security scan, the `next build` + `next start` preview, the analytics aggregates computed in code, revocation and the failed reuse probes.
- **Simulated / local:** the "test copy" is a local Next.js build served on a loopback port, not a hosting provider; there is no production target at all, so "the live site" is a refusal of an action no pass carries. The security reviewer's scan is deterministic rules, not an LLM. Agents are deterministic programs, not LLM-driven (that is deliberate: the authorization path is what is on trial).
- **Pacing:** the stream is paced client-side for narration (Speed). Nothing is dropped or reordered; Instant shows the raw stream.
