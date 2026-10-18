/**
 * The external Security agent as its own process: forked with an allow-listed
 * environment that holds only ITS credential, reached by the lead with a
 * per-task token, auditing a real AgentPass grant over HTTP.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECURITY_ENTRY, securityServiceEnv, startChildService, type ChildService } from '../src/processes.js';
import { RealWorkforceAuthority, type RealSession } from '../src/real/authority.js';
import type { SecurityReport } from '../src/agents/security.js';
import { copyDemoProject, cred, startAgentPass, type AgentPassFixture } from './helpers.js';

const LEAD_SENTINEL = `lead-secret-${cred()}`;
const TOKEN = cred();
let root: string;
let agentpass: AgentPassFixture;
let svc: ChildService;
let env: Record<string, string>;
let lead: RealSession;

const post = (path: string, body: unknown, token: string | null = TOKEN) => fetch(`${svc.url}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-task-token': token } : {}) }, body: JSON.stringify(body),
});

beforeAll(async () => {
  root = copyDemoProject('agentpass-secsvc-');
  agentpass = await startAgentPass(root);
  // Pollute the parent's environment the way a careless launcher might; the child must not inherit any of it.
  process.env.LEAD_CREDENTIAL = LEAD_SENTINEL;
  process.env.AGENTPASS_OWNER_KEY = agentpass.keys.owner;
  env = securityServiceEnv({ credential: agentpass.keys.security, taskToken: TOKEN, repoRoot: root, authorityUrl: agentpass.url });
  svc = await startChildService(SECURITY_ENTRY, env);
  const auth = new RealWorkforceAuthority({ authorityUrl: agentpass.url, identity: { organization_id: 'buyer-co', owner_principal_id: 'owner-1' } });
  const s = await auth.connect(agentpass.keys.lead);
  if (s.status !== 'OK') throw new Error('lead connect failed');
  lead = s.data as RealSession;
}, 60_000);

afterAll(async () => {
  delete process.env.LEAD_CREDENTIAL; delete process.env.AGENTPASS_OWNER_KEY;
  await svc?.stop(); await agentpass?.stop(); rmSync(root, { recursive: true, force: true });
});

describe('security agent service', () => {
  it('holds only its own credential: the lead credential (and the rest of the parent env) is absent from the child', () => {
    const values = Object.values(env);
    expect(values).not.toContain(LEAD_SENTINEL);
    expect(values).not.toContain(agentpass.keys.lead);
    expect(values).not.toContain(agentpass.keys.owner);
    expect(values).toContain(agentpass.keys.security);
    expect(Object.keys(env).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'NO_COLOR'].includes(k)).sort())
      .toEqual(['PORT', 'SECURITY_AUTHORITY_URL', 'SECURITY_CREDENTIAL', 'SECURITY_HOST', 'SECURITY_REPO_ROOT', 'SECURITY_TASK_TOKEN']);
    // And in the running process itself, where the OS lets us look.
    const pid = svc.child.pid!;
    const live = process.platform === 'linux' ? readFileSync(`/proc/${pid}/environ`, 'utf8')
      : process.platform === 'darwin' ? execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }) : undefined;
    if (live !== undefined) {
      expect(live).not.toContain(LEAD_SENTINEL);
      expect(live).not.toContain(agentpass.keys.lead);
      expect(live).toContain('SECURITY_TASK_TOKEN=');
    }
  });

  it('answers health without a token but refuses everything else without the task token (401)', async () => {
    expect((await fetch(`${svc.url}/health`)).status).toBe(200);
    const body = { authority_url: agentpass.url };
    expect((await post('/identify', body, null)).status).toBe(401);
    const wrong = await post('/identify', body, 'wrong-token');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ status: 'DENIED', code: 'INVALID_CALLER' });
    expect((await post('/audit', { grant_id: 'g', ...body }, 'wrong-token')).status).toBe(401);
  });

  it('refuses to use its credential against an authority other than the pinned one', async () => {
    for (const authority_url of ['http://127.0.0.1:1', 'https://attacker.invalid', 'http://example.com']) {
      const res = await post('/identify', { authority_url });
      expect(res.status, authority_url).toBe(400);
    }
  });

  it('identifies itself as the external principal, audits a delegated grant and reports the high XSS finding', async () => {
    const who = await (await post('/identify', { authority_url: agentpass.url })).json();
    expect(who).toEqual({ status: 'OK', data: { principal_id: 'security-agent', organization_id: 'sentinel-sec' } });

    const g = await lead.delegate({ parent_grant_id: agentpass.rootGrantId, recipient_principal_id: 'security-agent', scope: {
      actions: ['repo.read'], resources: ['src/**', 'package.json'], expires_at: new Date(Date.now() + 600_000).toISOString(), max_delegation_depth: 0, max_executions: 40,
    } });
    expect(g.status).toBe('OK');
    const grant_id = (g as { data: { id: string } }).data.id;

    const res = await post('/audit', { grant_id, authority_url: agentpass.url });
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string; data: { report: SecurityReport; trace: { kind: string; text: string }[] } };
    expect(json.status).toBe('OK');
    const { report, trace } = json.data;
    expect(report.generated_by).toBe('sentinel-sec/security-agent (deterministic rules)');
    expect(report.findings.some((f) => f.file === 'src/lib/newsletter.ts' && f.severity === 'high')).toBe(true);
    expect(report.denied.map((d) => d.what)).toEqual(['negative check: repo.read .env', 'negative check: repo.write src/lib/newsletter.ts']);
    expect(trace.filter((l) => l.kind === 'denied')).toHaveLength(2);
    expect(JSON.stringify(json)).not.toMatch(/FAKE_FIXTURE/);

    // The revoked grant is unusable from that process too (the reuse-after-revoke proof the orchestrator collects).
    expect((await lead.revoke({ grant_id, reason: 'test done' })).status).toBe('OK');
    const probe = await (await post('/probe', { grant_id, authority_url: agentpass.url, action: 'repo.read', resource: 'src/x' })).json();
    expect(probe.status).toBe('OK');
    expect(probe.data.status).not.toBe('OK');
    expect(probe.data.code).toBe('GRANT_REVOKED');
    const again = await post('/audit', { grant_id, authority_url: agentpass.url });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ status: 'DENIED', code: 'GRANT_REVOKED' });
  }, 60_000);
});
