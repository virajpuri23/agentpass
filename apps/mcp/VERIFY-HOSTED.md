# Developer A hosted verification

Use Node 24 and the existing private root `.env`. From the repository root:

```sh
node --env-file=.env --import tsx apps/mcp/verify-hosted.ts
```

This command targets only the AgentPass demo MCP endpoint at `https://fast-steel-94x84.run.mcp-use.com/mcp` and checks the dedicated AgentPass Supabase project. It needs `BUYER_API_KEY`, `SOURCING_API_KEY`, `SUPPLIER_API_KEY`, `DATABASE_URL`, and the existing `DATABASE_CA_CERT` when required. No supplier URL or owner key is needed. Never put credentials in command arguments or source files.

Each run uses **$5.10 of simulated root budget**, creates an isolated $5.10 parent grant, and revokes it in cleanup. It never resets the database, renews the root, restores inventory, or widens existing grants. It refuses to run without sufficient active root budget. If the process is forcibly terminated, its temporary grants expire within 15 minutes; inspect any uncertain purchases before rerunning. Run against an idle demo: concurrent spending is detected and reported as a failure.

The checks exercise all nine tools with independent buyer, sourcing and supplier clients: quote-only recovery, a $1200 request narrowed to $3.40, a $1.70 purchase and identical receipt replay, and two $3.40 sibling purchases racing for $3.40 remaining parent authority. Exactly one sibling succeeds. Missing/invalid credentials, another company's request read, self-approval, scope widening, impersonation, private margins, revoked grants and expired grants must fail.

Read-only SQL correlates the two resulting supplier orders and immutable receipts with six committed ledger entries (leaf, temporary parent and root for each purchase), the exact $5.10 root debit, and audit decisions. Output contains only a compact result and evidence IDs. The script asserts that MCP output contains neither the supplied credentials nor private supplier field names.

## Verified October 17, 2026

- Application deployment: `0600457a-b145-4c48-9ede-896997b13fdd`, application commit `49739cba5296b5fff3afe304eb08becd674a5407`.
- Hosted check: **PASSED**, run `verify-f0c70cfe-3043-4212-aec7-fe786d7d7f3d`.
- Authority request: `c405bcfa-05e0-4af7-a3e6-d1fc1701f566`.
- Temporary parent: `d6290fcf-aacd-46ae-8834-876f2cfa7509` (**revoked**).
- Receipts: `016d7178-e616-4aea-ae87-0fa2e4c30488`, `33a52d28-cc62-469e-bfec-8b69d453d034`.
- Root remaining after verification: **$41.20**. This is a snapshot; read `get_my_grants` again before a demo.
- The first verification attempt also made $5.10 of simulated purchases, then failed because its expiry-test payload incorrectly included a quote ID. The payload was corrected and that run's parent was revoked. Both runs' receipts and audit history were preserved.
- Local validation: root TypeScript check passed; **69 tests passed in 12 files**, using a fresh disposable database on local PostgreSQL 17. The database was dropped afterward. Node 24.21.0 was used.

The existing $850 scenario's persisted request, receipt, order and ledger were independently re-read and correlated during this work. This new run deliberately uses smaller purchases because the canonical $1000 root has already been spent. It does not establish three fresh $850 runs or a new deployment/restart test. The automated MCP check also does not verify visual rendering of the Authority Inspector.

Developer B can connect separate buyer/sourcing clients to the same hosted MCP URL and implement the autonomous agent runner. A new full $850 demo needs an explicitly owner-approved fresh allocation; reseeding must preserve the existing ledger. Self-service organization/agent/supplier registration remains outside this verification change and needs an agreed shared API contract.
