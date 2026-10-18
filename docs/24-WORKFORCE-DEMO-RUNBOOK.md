# Workforce demo runbook — 2:30 live, judge-facing

**Screen:** `http://127.0.0.1:3200/workforce.html` (the animated stage: Acme's agents on the left, the AgentPass desk in the middle, the gated project on the right, the external security company bottom right). The page is written for a viewer with only some tech background: agents are "the manager" and "helpers", grants are "passes", the authority is "the security desk", and every caption is a plain sentence. The raw event (agent, kind, code, text) is still there in the small `technical:` line under each caption and in the Technical log, so a technical judge loses nothing. Every packet on the diagram is a real call by a separate agent session.

## Pre-demo checklist (10 minutes before)

- [ ] `npm install && npm --prefix apps/mcp/agentpass-manufact install` done once; run `npm run demo` once so the npm cache is warm (each run copies `demo-project/` to a temp dir and runs `npm install --prefer-offline` there; cold, that is the only slow part).
- [ ] Port 3200 free (`lsof -iTCP:3200 -sTCP:LISTEN`); otherwise `ACTIVITY_PORT=3210 npm run dev:activity` and open that port.
- [ ] `npm run dev:activity`, open the page, window ≥ 1280×800, light or dark both fine.
- [ ] **Speed: Slow** for a narrated run (≈1:40 on screen). Normal is ≈0:40, Instant is the raw stream (≈0:04). Tick **One step at a time** if you want to hold on a beat: playback pauses before every workflow event; **Next**, **→** or **Space** advances. Untick to let it run.
- [ ] Badge top left reads **`running on: real AgentPass`** (green) = Developer A's real authority app, real grants, real execute gateway on a fresh SQLite. If it reads `running on: practice mock` (amber) the run is on the labeled in-memory mock: say so, do not present it as the real thing.
- [ ] Do a full rehearsal run and leave the page open: a new run clears it.

Measured on 2026-10-17 (warm cache, Apple Silicon laptop): 2.1 s from pressing Run to the first event, 3.7 s of real streaming, 5.7 s total wall-clock. On screen: Instant 0:04 · Normal 0:40 · Slow ≈1:40 playing (2:06 measured with ~25 s held in step-through).

## Script (Slow speed, ~2:30)

The on-screen labels use the plain words (manager, helpers, passes, the desk, test copy, live site); the script below uses the technical ones so you can answer questions. Say whichever fits the judge in front of you; the `technical:` line under the caption shows the real event text if someone asks.

**0:00 Hook** (before pressing Run). *"A lead coding agent is about to get a landing page built by four specialist agents, one from another company. Nobody shares credentials. AgentPass decides, per call, what each agent may touch, and you'll see it refuse, negotiate and revoke, live."* Press **Run demo**.

**0:10 Phase 1 — Task and root grant.** Say: *"The owner issued one root grant to the lead. Every other agent will get its own identity and a subset of this, nothing wider."* Point at: the `root grant` packet Owner → Lead and the `lead` row in Authority state (`repo.read, repo.write, deploy.preview, analytics.aggregate`). Evidence: `meta` event, `authority: AGENTPASS`.

**0:25 Phase 2 — Design and the .env refusal.** Say: *"The Design agent is provisioned with its own credential, only its hash reaches AgentPass, and gets read-write on UI files only. It rewrites the hero, then tries to read `.env`: refused."* Point at: the Design node lighting up with its `read + write` pass, green `repo.write` packets to Source code, then the red ✕ at the gate and the shaking `.env` vault. Evidence: `subagent_created`, `authority_delegated`, two `permission_denied` (`.env`, `src/lib/newsletter.ts`); checks 1–2.

**0:50 Phase 3 — External security, read-only; the lead fixes.** Say: *"Sentinel Sec's agent is a separate process in another organization. It gets read-only, finds an unescaped HTML sink, and its own write attempt is refused. The lead applies the fix itself."* Point at: the dashed Security node, `read-only` pass, red packets for `.env` and `repo.write`, then the lead's green `repo.write newsletter.ts`. Evidence: `external_contacted`, `permission_denied` ×2 (INSUFFICIENT_SCOPE), `fix_applied`; checks 3–4; Outputs → Security findings (2 high).

**1:20 Phase 4 — Production refused, preview negotiated, live URL.** Say: *"Hosting tries production. AgentPass refuses but says what it may ask for instead. It asks for exactly that, the lead counteroffers a 15-minute preview-only grant, and the preview ships."* Point at: red ✕ on the Production vault, the amber `may I deploy.preview?` packet up to the lead, the green `deploy.preview · 15 min` back, the `hosting-preview` row appearing, then the preview URL in Outputs. Evidence: `permission_denied` (deploy.production, AUTHORITY_REQUIRED), `narrower_requested`, `permission_granted`, `deployment_completed`; checks 5–8.

**1:50 Phase 5 — Aggregates, never raw rows.** Say: *"Analytics may compute aggregates: 3,788 views, 207 signups, 5.46 % conversion, three suggestions. Its request for raw user records, emails included, is refused."* Point at: green packet to Analytics aggregates, red ✕ and the shaking Raw user records vault, the metrics line in Outputs. Evidence: `analytics_analyzed`, `permission_denied` (analytics.raw); checks 9–10.

**2:10 Phase 6 — Revocation and dead credentials.** Say: *"Task done: the lead revokes all five temporary grants. The specialists try again with their old grants and every call fails; the provisioned credentials are disabled."* Point at: locks on the three specialist nodes, `revoked` badges, strike-through rows, `5 revoked`. Evidence: `authority_revoked` ×5; checks 11–12 (`INVALID_CALLER` for provisioned agents, `GRANT_REVOKED` for the external one).

**2:25 Close.** Point at the six green dots and *"12 of 12 checks passed"*. *"Every refusal, grant and revocation you saw was a real AgentPass decision on a real agent session, replayed at talking speed."*

## If a run fails live

1. Press **Run demo** again: every run starts from a clean seeded state (fresh project copy, fresh SQLite, fresh credentials). A failed run shows a red caption and the failing check; the page stays usable.
2. Backup, no browser: in a terminal `npm run demo` prints the same timeline and the 12 checks in about 10 s (`npm run demo -- --authority mock` if the authority itself will not start; say it is the labeled mock).
3. Port busy: `ACTIVITY_PORT=3210 npm run dev:activity`.
4. Do not refresh mid-run to "fix" pacing: a refresh catches up instantly to the server's buffer; use Speed/Step through instead.

## Honest wording

- **Real:** authorization decisions (Developer A's authority app running in-process on a fresh SQLite), child provisioning with hashed credentials, delegation as a strict subset, the `AUTHORITY_REQUIRED` → request → counteroffer → accept negotiation, the file edits (Hero, Features, stylesheet, the `escapeHtml` fix), the rule-based security scan, the `next build` + `next start` preview, the analytics aggregates computed in code, revocation and the failed reuse probes.
- **Simulated / local:** the "preview deploy" is a local Next.js build served on a loopback port, not a hosting provider; there is no production target at all, so "production refused" is a refusal of an action no grant carries. The security agent's scan is deterministic rules, not an LLM. Agents are deterministic programs, not LLM-driven (that is deliberate: the authorization path is what is on trial).
- **Pacing:** the stream is paced client-side for narration (Speed, Step through). Nothing is dropped or reordered; Instant shows the raw stream.
