# AgentPass presentation

Visual thesis: an ink-dark technical poster, warm typography, and one acid-green accent make the authority boundary the focal point.

Content plan: product introduction → interactive architecture → illustrative $850 permission negotiation → MCP and execution details.

Interaction thesis: highlight the current delegation edge, step through money events, and expose replay, overspend, and revocation outcomes with unchanged balances.

This is an explanatory website. Its browser scenario is explicitly illustrative and does not call AgentPass, execute agent models, or move funds. Architecture content comes from the AgentPass repository documentation. The original technical walkthrough is preserved in `dist/architecture.html`.

Run the scenario checks with `node --test test/scenario.check.mjs`. Serve `dist/` with any static HTTP server.

## Published and repository locations

[Private published website](https://agentpass-authority-story-01a14ce3.cheeryball10.chatgpt.site)
(private to the publishing account). This complete static package was copied into
the AgentPass repository from the presentation chat's saved artifact on October
17, 2026 (Pacific). No deployment was performed by that copy.

From the repository root:

```sh
python3 -m http.server 3300 --bind 127.0.0.1 --directory sites/authority-story/dist
node --test sites/authority-story/test/scenario.check.mjs
```

Open `http://127.0.0.1:3300`. `dist/` contains the served source: `index.html`,
`style.css`, `app.mjs`, `scenario.mjs` and the generated `architecture.html` export.
There is no bundler or install step. The scenario tests cover negotiation/spend
and denial/revocation/replay balance behavior. External font and diagram helper
assets may require network access. The smaller original technical diagram is
preserved at [`docs/visuals/technical-flow.html`](../../docs/visuals/technical-flow.html).

For the real authorization demos, plugin and evidence distinctions, use the
[experience catalog](../../docs/25-EXPERIENCES.md).

The original scenario test file is named `scenario.check.mjs` in this copy so the
root Vitest runner does not discover a Node test-runner suite. Run it explicitly
with `node --test` as shown above; scenario behavior and assertions are unchanged.
