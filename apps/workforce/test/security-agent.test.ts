/**
 * Security agent (external org `sentinel-sec`, read-only grant) against the
 * MOCK authority and a throwaway copy of demo-project, plus unit tests of the
 * pure scanner.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../src/agent-base.js';
import { RULES, runSecurityAgent, scanSource } from '../src/agents/security.js';
import type { ApiResult, WorkforceScope, WorkforceSession } from '../src/contract.js';
import { createRepoGateway } from '../src/gateways/repo.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ok = async <T>(p: Promise<ApiResult<T>>): Promise<T> => { const r = await p; expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('OK'); return (r as { data: T }).data; };

let root: string;
let auth: MockWorkforceAuthority;
let lead: WorkforceSession, security: WorkforceSession, narrow: WorkforceSession;
let rootId: string;
let securityGrant: string, narrowGrant: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentpass-security-'));
  cpSync(SOURCE, root, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
  auth = new MockWorkforceAuthority();
  auth.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: 'k-lead' });
  auth.addPrincipal({ id: 'security-agent', organization_id: 'sentinel-sec', credential: 'k-security' });
  auth.addPrincipal({ id: 'narrow-agent', organization_id: 'acme', credential: 'k-narrow' });
  rootId = auth.issueRoot({ issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
    resources: ['src/**', 'package.json', 'preview', 'landing-page'], expires_at: later(60), max_delegation_depth: 2,
  } }).id;
  [lead, security, narrow] = await Promise.all(['k-lead', 'k-security', 'k-narrow'].map((k) => ok(auth.connect(k))));
  const give = async (to: string, scope: Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>) =>
    (await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: to, scope: { ...scope, expires_at: later(30), max_delegation_depth: 0 } }))).id;
  securityGrant = await give('security-agent', { actions: ['repo.read'], resources: ['src/**', 'package.json'] });
  narrowGrant = await give('narrow-agent', { actions: ['repo.read'], resources: ['src/components/**'] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctxFor = (name: string, session: WorkforceSession, grant_id: string, trace: Parameters<AgentContext['trace']>[0][] = []): AgentContext => ({
  name, session, grant_id, gateways: { repo: createRepoGateway(root) }, trace: (l) => trace.push(l),
});

describe('security agent', () => {
  it('finds the seeded XSS at the right lines, passes the secret check, notes loose pins, and is refused .env and the write', async () => {
    const trace: Parameters<AgentContext['trace']>[0][] = [];
    const report = await runSecurityAgent(ctxFor('security-agent', security, securityGrant, trace));

    expect(report.generated_by).toBe('sentinel-sec/security-agent (deterministic rules)');
    expect(report.scanned_files).toBeGreaterThanOrEqual(6);

    // R1: the producer (string concatenation) and the sink are both reported, high.
    const r1 = report.findings.filter((f) => f.rule === RULES.R1);
    expect(r1.map((f) => [f.file, f.line, f.severity])).toEqual([
      ['src/components/Signup.tsx', 11, 'high'],
      ['src/lib/newsletter.ts', 21, 'high'],
    ]);
    const producer = r1.find((f) => f.file === 'src/lib/newsletter.ts')!;
    expect(producer.evidence).toBe("return '<strong>Thanks, ' + name + '!</strong> Check your inbox to confirm.';");
    expect(producer.fix).toContain('wrap the user value with escapeHtml() from src/lib/newsletter.ts');
    expect(r1.find((f) => f.file === 'src/components/Signup.tsx')!.evidence).toContain('dangerouslySetInnerHTML');

    // R2: no secrets in src/** (the fake ones live in .env, which it cannot read), reported as a passed check.
    expect(report.findings.some((f) => f.rule === RULES.R2)).toBe(false);
    expect(report.passed_checks.some((c) => c.startsWith('R2 ') && c.includes(RULES.R2))).toBe(true);

    // R3: informational, only the caret-pinned devDependencies.
    const r3 = report.findings.filter((f) => f.rule === RULES.R3);
    expect(r3.every((f) => f.severity === 'info' && f.file === 'package.json')).toBe(true);
    expect(r3.map((f) => f.evidence.split('"')[1]).sort()).toEqual(['@types/node', '@types/react', '@types/react-dom', 'typescript']);
    const pkgLines = readFileSync(join(root, 'package.json'), 'utf8').split('\n');
    for (const f of r3) expect(pkgLines[f.line - 1]!.trim()).toBe(f.evidence);

    // Negative checks: .env is never a resource; the write needs repo.write, which this grant lacks.
    expect(report.denied).toEqual([
      { what: 'negative check: repo.read .env', code: 'RESOURCE_DENIED' },
      { what: 'negative check: repo.write src/lib/newsletter.ts', code: 'INSUFFICIENT_SCOPE' },
    ]);
    expect(trace.filter((l) => l.kind === 'denied').map((l) => l.code)).toEqual(['RESOURCE_DENIED', 'INSUFFICIENT_SCOPE']);
    expect(readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8')).toContain("'<strong>Thanks, ' + name +");

    // The report never carries anything it was not allowed to read (it names `.env` only as the refused negative check).
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/FAKE_FIXTURE|not-a-real-password|DATABASE_URL|SESSION_SECRET|STRIPE_SECRET_KEY/);

    // Every read the agent made was authorized by the MOCK authority under its own grant.
    const reads = (await auth.audit()).filter((e) => e.principal_id === 'security-agent' && e.action === 'repo.read');
    expect(reads.filter((e) => e.decision === 'ALLOW').length).toBeGreaterThanOrEqual(report.scanned_files);
    expect(reads.filter((e) => e.decision === 'DENY').map((e) => e.resource)).toEqual(['.env']);
  });

  it('negative: a grant that does not cover src/** cannot even list the tree, and the run aborts', async () => {
    const trace: Parameters<AgentContext['trace']>[0][] = [];
    await expect(runSecurityAgent(ctxFor('narrow-agent', narrow, narrowGrant, trace))).rejects.toThrow(/repo.list src failed: RESOURCE_DENIED/);
    expect(trace.filter((l) => l.kind === 'denied')).toHaveLength(1);
  });
});

describe('scanSource (pure rules)', () => {
  const fixture = () => ({
    'src/components/Signup.tsx': readFileSync(join(SOURCE, 'src/components/Signup.tsx'), 'utf8'),
    'src/lib/newsletter.ts': readFileSync(join(SOURCE, 'src/lib/newsletter.ts'), 'utf8'),
    'package.json': readFileSync(join(SOURCE, 'package.json'), 'utf8'),
  });

  it('is deterministic and clears R1 once the producer escapes its input', () => {
    const files = fixture();
    expect(scanSource(files)).toEqual(scanSource(files));
    const fixed = { ...files, 'src/lib/newsletter.ts': files['src/lib/newsletter.ts'].replace("' + name + '", "' + escapeHtml(name) + '") };
    expect(scanSource(files).filter((f) => f.rule === RULES.R1)).toHaveLength(2);
    expect(scanSource(fixed).filter((f) => f.rule === RULES.R1)).toHaveLength(0);
  });

  it('flags a bare prop at the sink, a template-literal producer, and a planted secret; ignores constants and sanitized values', () => {
    const files = {
      'src/a.tsx': 'export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n',
      'src/b.tsx': 'import { greet } from "./g";\nexport const B = ({ n }: { n: string }) => <p dangerouslySetInnerHTML={{ __html: greet(n) }} />;\n',
      'src/g.ts': 'export const greet = (who: string) => `<b>Hi ${who}</b>`;\n',
      'src/c.tsx': 'export const C = () => <p dangerouslySetInnerHTML={{ __html: "<b>static</b>" }} />;\n',
      'src/d.tsx': 'export const D = ({ n }: { n: string }) => <p dangerouslySetInnerHTML={{ __html: escapeHtml(n) }} />;\n',
      'src/k.ts': 'export const key = "sk_live_ABCDEFGHIJKLMNOP1234";\n',
      'README.md': 'AKIAABCDEFGHIJKLMNOP is only an example here, outside src/\n',
    };
    const out = scanSource(files);
    expect(out.filter((f) => f.rule === RULES.R1).map((f) => `${f.file}:${f.line}`)).toEqual(['src/a.tsx:1', 'src/b.tsx:2', 'src/g.ts:1']);
    const secret = out.filter((f) => f.rule === RULES.R2);
    expect(secret.map((f) => f.file)).toEqual(['src/k.ts']);
    expect(secret[0]!.evidence).not.toContain('ABCDEFGHIJKLMNOP1234'); // redacted in the report
    expect(out.some((f) => f.file === 'README.md')).toBe(false);
    expect(out.some((f) => ['src/c.tsx', 'src/d.tsx'].includes(f.file))).toBe(false);
  });
});
