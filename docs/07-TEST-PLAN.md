# Test Plan — Must-Pass Acceptance Matrix

The judge-facing security claim is only as strong as the negative tests. Run all mandatory tests before calling the MVP complete.

## Functional golden path

| ID | Given | When | Expected |
|---|---|---|---|
| F01 | Buyer root grant $1000 | Buyer delegates quote scope to sourcing | Child grant created, purchase permission absent |
| F02 | Quote-only sourcing child | Requests PACK-500 quote x500 | Seller returns $850 trusted quote |
| F03 | Same quote-only grant | Attempts purchase | `AUTHORITY_REQUIRED`, next action `request_authority` |
| F04 | Root grant $1000 | Child asks $1200, parent offers $900 | Counteroffer valid, narrower, still pending child acceptance |
| F05 | Child accepts | AgentPass issues new purchase grant | Grant subject matches authenticated child and scope $900 |
| F06 | Valid $850 quote and grant | Child purchases via gateway | One order, receipt, $850 counted against every ancestor |
| F07 | Parent revokes grant | Child retries new action | `GRANT_REVOKED` |

## Security negative tests

| ID | Scenario | Expected |
|---|---|---|
| S01 | Child passes `agent_id=buyer-agent` in body | `INVALID_CALLER` / identity unaffected |
| S02 | Child attempts to widen parent scope to new supplier | `OUTSIDE_PARENT_SCOPE` |
| S03 | Child attempts $1200 child grant under $1000 parent | `OUTSIDE_PARENT_SCOPE` |
| S04 | Child extends grant expiry past parent expiry | `OUTSIDE_PARENT_SCOPE` |
| S05 | Child increases delegation depth | `OUTSIDE_PARENT_SCOPE` |
| S06 | Child approves own authority request | 403, unchanged request |
| S07 | Child requests `supplier.margin.read` | Seller denies; no internal cost/margin fields returned |
| S08 | Agent sends modified price with trusted quote ID | Server ignores/rejects price override; charges only trusted quote |
| S09 | Revoked ancestor | Descendant cannot execute |
| S10 | Expired grant | No action |
| S11 | Two concurrent child purchases exceed root combined budget | At most budget-eligible purchases commit |
| S12 | Repeat idempotency key after successful $850 purchase | Same receipt; no extra charge or fulfillment |
| S13 | Quote expired | `QUOTE_EXPIRED`, no debit |
| S14 | Unknown action `read_all_supplier_data` | Denied; no arbitrary dispatcher |
| S15 | Seller service unreachable | Fail closed; no confirmed purchase |
| S16 | Unknown API key | 401; no agent access |

## Automated suites

- **Dev A:** `auth.test.ts`, `grant-subset.test.ts`, `requests.test.ts`, `budget-ledger.test.ts`, `gateway.test.ts`, `mcp-tools.test.ts`.
- **Dev B:** `supplier-policy.test.ts`, `private-data.test.ts`, `quote.test.ts`, `fulfill-idempotency.test.ts`, `agent-runner.test.ts`.
- **Integration:** `scripts/run-e2e.ts`, with test summary printed and nonzero exit on any failure.

## UI/demo assertions

- Timeline is driven by persisted events, not fake local state transitions.
- Root vs child grant graph displays actual IDs and limits.
- Receipt includes `simulated: true`, amount 85000 cents, actual grant ID.
- Denied supplier data cannot appear accidentally in HTTP response, MCP text, audit logs, or dashboard.
- Reset script restores DBs and agent sessions without manual database editing.

## Priorities when time is short

Minimum non-negotiable: F01–F07; S01, S03, S06, S07, S08, S09, S11, S12, S16. Run the remaining S tests if time permits. Never skip budget/idempotency checks while showing autonomous spending.
