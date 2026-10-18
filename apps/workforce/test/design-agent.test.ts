/**
 * Design agent against the MOCK authority and a throwaway copy of demo-project.
 * No install or build: the agent only edits files through the repo gateway.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../src/agent-base.js';
import { HERO_HEADLINE, runDesignAgent } from '../src/agents/design.js';
import type { ApiResult, WorkforceScope, WorkforceSession } from '../src/contract.js';
import { createRepoGateway } from '../src/gateways/repo.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ok = async <T>(p: Promise<ApiResult<T>>): Promise<T> => { const r = await p; expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('OK'); return (r as { data: T }).data; };

/** sha256 of every file in the project copy, keyed by '/'-relative path. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

let root: string;
let auth: MockWorkforceAuthority;
let lead: WorkforceSession, design: WorkforceSession, auditor: WorkforceSession;
let rootId: string;
let designGrant: string, readOnlyGrant: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentpass-design-'));
  cpSync(SOURCE, root, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
  auth = new MockWorkforceAuthority();
  auth.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: 'k-lead' });
  auth.addPrincipal({ id: 'design-agent', organization_id: 'acme', credential: 'k-design' });
  auth.addPrincipal({ id: 'auditor-agent', organization_id: 'acme', credential: 'k-auditor' });
  rootId = auth.issueRoot({ issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
    resources: ['src/**', 'package.json', 'preview', 'landing-page'], expires_at: later(60), max_delegation_depth: 2,
  } }).id;
  [lead, design, auditor] = await Promise.all(['k-lead', 'k-design', 'k-auditor'].map((k) => ok(auth.connect(k))));
  const give = async (to: string, scope: Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>) =>
    (await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: to, scope: { ...scope, expires_at: later(30), max_delegation_depth: 0 } }))).id;
  designGrant = await give('design-agent', { actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'] });
  readOnlyGrant = await give('auditor-agent', { actions: ['repo.read'], resources: ['src/**', 'package.json'] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctxFor = (name: string, session: WorkforceSession, grant_id: string, trace: Parameters<AgentContext['trace']>[0][]): AgentContext => ({
  name, session, grant_id, gateways: { repo: createRepoGateway(root) }, trace: (l) => trace.push(l),
});

describe('design agent', () => {
  it('rewrites Hero, Features and the stylesheet through the gateway, leaves everything else alone, and records both refusals', async () => {
    const beforeFs = fingerprint(root);
    const trace: Parameters<AgentContext['trace']>[0][] = [];
    const result = await runDesignAgent(ctxFor('design-agent', design, designGrant, trace));
    const afterFs = fingerprint(root);

    // Real, deterministic edits.
    expect(result.changed_files.sort()).toEqual(['src/components/Features.tsx', 'src/components/Hero.tsx', 'src/styles/globals.css']);
    for (const f of result.changed_files) expect(result.after[f], f).not.toBe(result.before[f]);
    expect(result.before['src/components/Hero.tsx']).toContain('<h1>Launchpad</h1>');
    expect(result.after['src/components/Hero.tsx']).toContain(HERO_HEADLINE);
    expect(result.after['src/components/Hero.tsx']).toMatch(/className="button button-primary"/);
    expect(result.after['src/components/Features.tsx']).toContain('feature-grid');
    expect(result.after['src/styles/globals.css']).toContain('--brand');
    expect(result.after['src/styles/globals.css']).toContain('@media (prefers-color-scheme: dark)');
    expect(result.after['src/styles/globals.css']).toContain('.button');
    expect(readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8')).toBe(result.after['src/components/Hero.tsx']);

    // Signup.tsx is read but untouched: its confirmationHtml usage stays for the Security agent to find.
    expect(result.after['src/components/Signup.tsx']).toBe(result.before['src/components/Signup.tsx']);
    expect(result.after['src/components/Signup.tsx']).toContain('confirmationHtml(name)');

    // Nothing outside components/styles changed, and the secrets are intact.
    const changedOnDisk = Object.keys(afterFs).filter((f) => afterFs[f] !== beforeFs[f]).sort();
    expect(changedOnDisk).toEqual(result.changed_files.sort());
    expect(Object.keys(afterFs).sort()).toEqual(Object.keys(beforeFs).sort()); // no new files (the lib write was refused)
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('FAKE_FIXTURE');
    expect(readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8')).toContain("'<strong>Thanks, ' + name +");

    // The negative checks were refused and are part of the result and the trace.
    expect(result.denied).toEqual([
      { what: 'negative check: repo.read .env', code: 'RESOURCE_DENIED' },
      { what: 'negative check: repo.write src/lib/newsletter.ts', code: 'RESOURCE_DENIED' },
    ]);
    expect(trace.filter((l) => l.kind === 'denied').map((l) => l.code)).toEqual(['RESOURCE_DENIED', 'RESOURCE_DENIED']);

    // The result only contains files it was allowed to read.
    for (const k of [...Object.keys(result.before), ...Object.keys(result.after)]) expect(k).toMatch(/^src\/(components|styles)\//);
    expect(JSON.stringify(result)).not.toMatch(/FAKE_FIXTURE|not-a-real-password|DATABASE_URL/);
  });

  it('runs identically a second time: no further changes', async () => {
    const before = fingerprint(root);
    const result = await runDesignAgent(ctxFor('design-agent', design, designGrant, []));
    expect(result.changed_files).toEqual([]);
    expect(fingerprint(root)).toEqual(before);
  });

  it('negative: with a read-only grant the first write is refused, the run aborts and nothing changes', async () => {
    const before = fingerprint(root);
    const fresh = mkdtempSync(join(tmpdir(), 'agentpass-design-ro-'));
    try {
      cpSync(SOURCE, fresh, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
      const pristine = fingerprint(fresh);
      const trace: Parameters<AgentContext['trace']>[0][] = [];
      const ctx: AgentContext = { name: 'auditor-agent', session: auditor, grant_id: readOnlyGrant, gateways: { repo: createRepoGateway(fresh) }, trace: (l) => trace.push(l) };
      await expect(runDesignAgent(ctx)).rejects.toThrow(/repo.write src\/components\/Hero.tsx failed: INSUFFICIENT_SCOPE/);
      expect(trace.some((l) => l.kind === 'denied' && l.code === 'INSUFFICIENT_SCOPE')).toBe(true);
      expect(fingerprint(fresh)).toEqual(pristine); // reads happened, but not a single byte changed
    } finally { rmSync(fresh, { recursive: true, force: true }); }
    expect(fingerprint(root)).toEqual(before);
  });

  it('negative: the design grant cannot be used from another principal\'s session', async () => {
    await expect(runDesignAgent(ctxFor('auditor-agent', auditor, designGrant, []))).rejects.toThrow(/INVALID_CALLER/);
  });
});
