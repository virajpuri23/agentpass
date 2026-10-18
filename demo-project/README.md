# Launchpad landing page (demo fixture)

The sample SaaS landing page that the AgentPass workforce demo's agents work on.
It is **not** part of AgentPass; agents reach it only through the tool gateways
in `apps/workforce`, and only within the paths their grants allow.

## What's in here

- `src/app/page.tsx`, `src/components/*`, `src/styles/*`: the landing page the
  **Design agent** improves (`src/components/**` and `src/styles/**` are the only
  writable paths it is granted).
- `src/lib/newsletter.ts`: **seeded security issue** (documented below) for the
  **Security agent** to find and the lead agent to fix.
- `.env`: fake credentials, committed on purpose, so the demo can show that no
  agent can read them (every `repo.read` of `.env` is refused by AgentPass).
- `data/analytics-events.json`: synthetic page-view and signup events for the
  **Analytics agent**. Rows carry fake user ids and emails; agents only ever get
  aggregates.

## Seeded security issue

`src/lib/newsletter.ts` builds an HTML confirmation message with string
concatenation and marks it for `dangerouslySetInnerHTML` without escaping the
user-supplied name: a reflected XSS. The scanner looks for
`dangerouslySetInnerHTML` fed by an unescaped template, and the fix is to escape
the value (the file includes an `escapeHtml` helper that is not yet used).

## Run

```bash
npm install
npm run build && npm start
```
