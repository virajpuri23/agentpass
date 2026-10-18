# Building the specialist agents (internal brief for parallel work)

Branch: `feat/agent-demo`. Scope: `apps/workforce/**` only. Do not touch
`apps/authority/**`, `apps/mcp/**`, `db/**`, `packages/contracts/**`, or
`demo-project/**` (the agents EDIT the project at runtime; its source is the
fixture and stays as committed).

## What already exists (use it, don't rebuild it)

- `apps/workforce/src/contract.ts`: `WorkforceSession` (authorize / requestAuthority /
  respond / accept / revoke), result envelope, error codes.
- `apps/workforce/src/mock-authority.ts`: `MockWorkforceAuthority` (labeled MOCK).
  Tests: `apps/workforce/test/mock-authority.test.ts`.
- Gateways in `apps/workforce/src/gateways/`: `repo` (list/read/write with glob
  allow-lists; `.env` always refused), `deploy` (`production` refused by authority
  with a `deploy.preview` hint; `preview` runs a real `next build` + `next start`),
  `analytics` (`aggregate` computed in code; `raw` needs `analytics.raw`).
  Tests: `apps/workforce/test/gateways.test.ts` (shows how to set up a session,
  grants and a throwaway project copy).
- `apps/workforce/src/agent-base.ts`: `AgentContext`, `isError`, `noteDenied`.
- `demo-project/`: the landing page. `src/components/*` + `src/styles/globals.css`
  are the Design agent's writable paths. `src/lib/newsletter.ts` has the seeded
  XSS (see `demo-project/README.md`). `data/analytics-events.json` is the dataset.

## Rules for every agent

1. An agent file exports one function `run<Name>Agent(ctx: AgentContext, task): Promise<Result>`.
   It uses only `ctx.session`, `ctx.grant_id` and `ctx.gateways`.
2. **Real work, deterministic.** No LLM calls. Edits, scans and metrics are code.
3. Every gateway call that is refused goes through `noteDenied` so the trace shows it.
   Negative tests the scope requires are part of the agent's run (e.g. Design tries to
   read `.env`, Security tries to write a file), clearly traced as "negative check".
4. Results are structured (typed) and must not contain anything the agent was not
   allowed to read.
5. One vitest file per agent in `apps/workforce/test/`, using the setup pattern from
   `gateways.test.ts` (temp copy of demo-project + MOCK authority + per-agent grant).

## Grants each agent receives from the lead (the orchestrator issues these)

| Agent | actions | resources |
|---|---|---|
| design-agent | repo.read, repo.write | `src/components/**`, `src/styles/**` |
| security-agent (org `sentinel-sec`, external) | repo.read | `src/**`, `package.json` |
| hosting-agent | repo.read, (deploy.preview only after negotiation) | `src/**`, `package.json`, `preview` |
| analytics-agent | analytics.aggregate | `landing-page` |
