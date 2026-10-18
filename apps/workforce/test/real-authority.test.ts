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
  }, 300_000);
});
