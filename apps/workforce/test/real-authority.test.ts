/**
 * The whole coding-agent workflow against Developer A's REAL authority
 * (in-process AgentPass app on a migrated SQLite, the demo-project resource
 * registered, specialists provisioned with fresh credentials). This is the
 * "real AgentPass authorization calls" gate: no mock anywhere in the path.
 */
import { describe, expect, it } from 'vitest';
import { runDemo } from '../../../scripts/run-workforce.js';

describe('workforce demo on the real AgentPass authority', () => {
  it('passes all 12 scope checks with real grants, provisioning, negotiation, execute gateway and revocation', async () => {
    const out = await runDemo({ authority: 'agentpass' });
    expect(out.error, out.error?.message).toBeUndefined();
    expect(out.result?.authority_source).toBe('AGENTPASS');
    expect(out.checks.filter((c) => !c.pass).map((c) => `${c.n}: ${c.detail}`)).toEqual([]);
    expect(out.passed).toBe(true);

    const grants = out.result!.grants;
    // Provisioned specialists carry server-generated identities; the external auditor keeps its registered one.
    for (const name of ['design', 'hosting', 'analytics']) expect(grants[name]!.subject_principal_id, name).toMatch(/^agent-/);
    expect(grants.security!.subject_principal_id).toBe('security-agent');
    // The negotiated preview grant is a separate, narrower grant than the hosting agent's initial one.
    expect(grants['hosting-preview']!.id).not.toBe(grants.hosting!.id);
    expect(grants['hosting-preview']!.scope.actions).toEqual(['deploy.preview']);
    expect(out.result!.hosting?.deployment?.provider).toBe('local-next-start');
    // AgentPass's own audit log is part of the evidence, not just client-side observations.
    expect(out.audit.some((e) => e.source === 'AGENTPASS' && e.action === 'principal.provision')).toBe(true);
    expect(out.audit.some((e) => e.source === 'AGENTPASS' && e.decision === 'REVOKED')).toBe(true);
    expect(JSON.stringify(out.result)).not.toMatch(/FAKE_FIXTURE|@example\.com/);

    // Money: a $1,000 root wallet, subset wallets, real purchases on AgentPass's ledger, refusals, one counteroffer, one rejection.
    const b = out.result!.budget!;
    expect(b.root_cents).toBe(100000);
    expect(b.wallet_cents).toEqual({ design: 15000, hosting: 10000, analytics: 5000 });
    expect(b.ledger.map((l) => [l.agent, l.sku_id, l.amount_cents])).toEqual([
      ['design-agent', 'stock-photo', 8000], ['lead-agent', 'audit-hour', 16000], ['hosting-agent', 'hosting-slot', 12000], ['analytics-agent', 'data-query', 2500],
    ]);
    expect(b.refused.map((x) => [x.agent, x.code])).toEqual([['design-agent', 'BUDGET_EXCEEDED'], ['hosting-agent', 'BUDGET_EXCEEDED']]);
    expect(b.topups.map((t) => [t.agent, t.decision, t.offered_cents ?? null])).toEqual([['hosting-agent', 'COUNTEROFFER', 12000], ['analytics-agent', 'REJECT', null]]);
    expect(b.spent_cents).toBe(38500);
    expect(b.remaining_cents).toBe(61500); // AgentPass's own ledger agrees
    // The top-up is a separate grant under the root wallet, held by the hosting agent, and the purchase went through it.
    const topup = out.result!.wallets['hosting-topup']!;
    expect(topup.parent_grant_id).toBe('grant-root-wallet');
    expect(topup.subject_principal_id).toBe(out.result!.grants.hosting!.subject_principal_id);
    expect(b.ledger.find((l) => l.agent === 'hosting-agent')!.grant_id).toBe(topup.id);
    // Wallets are revoked with the passes and cannot be used afterwards.
    for (const w of Object.values(out.result!.wallets)) expect(out.result!.revoked).toContain(w.id);
    expect(out.result!.wallet_reuse_after_revoke.length).toBeGreaterThanOrEqual(3);
    expect(out.checks.filter((c) => c.skipped)).toEqual([]);
  }, 300_000);
});
