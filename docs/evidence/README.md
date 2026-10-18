# Demo evidence

These assets are historical captures, not continuously refreshed status. See the
[full experience catalog](../25-EXPERIENCES.md#visuals-and-presentation-assets) for
source, dates, expected behavior and reproduction commands.

| File | Evidence class |
|---|---|
| `hosted-run-2026-10-17.json` | Recorded hosted supplier trace; replayed with a recording label by the activity server |
| `workforce-screen.jpg` | Local workforce stage screenshot, earlier 12-check version |
| `landing-before.jpg`, `landing-after.jpg` | Local Launchpad fixture before/after Design-agent edits |
| `presentation-scenario-verified.png` | Fresh browser check of this repository copy; illustrative receipt/retry/denials, no backend calls |
| `presentation-site.png` | Explanatory presentation website screenshot; scripted scenario |
| `local-run-inspection.png` | Authenticated local console capture with a $850 simulated receipt |
| `hosted-delegation-workflow.png` | Authenticated hosted branch capture with a $3.40 simulated receipt |

The last three images were copied from existing reviewed captures on October 17,
2026 (Pacific) so the repository no longer depends on private temporary paths.
No screenshot contains a bearer credential. Grant/principal/receipt IDs identify
records and do not establish authentication or authority. Available budgets,
expiry and UI details may have changed since capture.

Only the existing hosted trace is a recording consumed by the activity server.
Do not place arbitrary JSON exports in this directory: the recording picker lists
all `.json` files and expects `trace`, `checks` and `passed` fields.
