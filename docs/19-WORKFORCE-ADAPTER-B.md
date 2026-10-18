# Workforce authority adapter (Developer B) and the action schemas B needs

**Status:** B is building the four-agent coding workflow against a **MOCK** authority
(`apps/workforce/src/mock-authority.ts`) behind the interface in
`apps/workforce/src/contract.ts`. Every mock output and audit event carries
`source: 'MOCK'`. When Developer A publishes `docs/11-WORKFORCE-CONTRACT.md`, the
real client replaces the mock in one factory; agents and gateways don't change.

## Actions the demo needs (proposal for A)

| Action | Resource (allow-list glob) | Used by | Note |
|---|---|---|---|
| `repo.read` | file path, e.g. `src/**`, `package.json` | Design, Security | `.env` must never match any granted glob |
| `repo.write` | file path, e.g. `src/components/**`, `src/styles/**` | Design (and the lead's fix) | Security is read-only |
| `deploy.preview` | environment: `preview` | Hosting | granted only after negotiation |
| `deploy.production` | environment: `production` | Hosting (attempt) | **never delegated below the owner**; refusal must point at `deploy.preview` |
| `analytics.aggregate` | dataset: `landing-page` | Analytics | computed metrics only |
| `analytics.raw` | dataset | Analytics (attempt) | refused: rows carry user ids/emails |
| `secrets.read` | — | (nobody) | exists so the denial is explicit |

## Semantics B relies on (the mock enforces all of these; see `apps/workforce/test/mock-authority.test.ts`)

1. Identity comes from the credential that opened the session; a grant id in an
   argument is never proof of holding it (`INVALID_CALLER`).
2. Delegation is a strict subset: actions ⊆ parent, resources ⊆ parent allow-list,
   expiry ≤ parent, depth decreases. Empty `resources` means nothing, not everything.
3. `authorize({grant_id, action, resource})` checks the **live chain** (unrevoked,
   unexpired, every link holds the action and resource) and returns one
   `Authorization` the gateway acts on.
4. Missing **action** → `AUTHORITY_REQUIRED` + `required_scope` + `next_action:
   request_authority`; for `deploy.production` also `alternative_scope` naming
   `deploy.preview`. Out-of-scope **resource** (e.g. `.env`) → `DENIED
   RESOURCE_DENIED`, not recoverable.
5. Negotiation: child `requestAuthority` → parent `respond(COUNTEROFFER|REJECT)` →
   child `accept(idempotency_key)`; offers must be ⊆ parent **and** ⊆ request;
   the requester can't respond to its own request; accept is idempotent.
6. Revocation stops the grant and every descendant immediately; reuse fails
   with `GRANT_REVOKED`.
7. Audit: one event per decision with `principal_id`, `grant_id`, `action`,
   `resource`, `decision`, `reason_code`, `source`.

## Request to A

Publish the generic-action contract (or confirm the table above), including the
`alternative_scope` hint on production refusals. B will swap the mock the same
hour. Until then the demo UI and `npm run demo` label authority as **MOCK**.
