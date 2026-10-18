/**
 * Gateways against the MOCK authority and a throwaway copy of demo-project.
 * The deploy test does a real `next build` + `next start`, so it is slower.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResult, WorkforceScope, WorkforceSession } from '../src/contract.js';
import { createAnalyticsGateway, summarize } from '../src/gateways/analytics.js';
import { createDeployGateway } from '../src/gateways/deploy.js';
import { createRepoGateway } from '../src/gateways/repo.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const code = (r: ApiResult<unknown>) => (r.status === 'OK' ? 'OK' : r.code);
const ok = async <T>(p: Promise<ApiResult<T>>): Promise<T> => { const r = await p; expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('OK'); return (r as { data: T }).data; };

let root: string;
let auth: MockWorkforceAuthority;
let lead: WorkforceSession, design: WorkforceSession, security: WorkforceSession, hosting: WorkforceSession, analytics: WorkforceSession;
let rootId: string;
const grants: Record<string, string> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentpass-project-'));
  cpSync(SOURCE, root, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
  // Next refuses a symlinked node_modules, so install for real in the copy (lockfile, offline-first cache).
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--silent'], { cwd: root, stdio: 'ignore' });

  auth = new MockWorkforceAuthority();
  for (const [id, cred] of [['lead-agent', 'k-lead'], ['design-agent', 'k-design'], ['security-agent', 'k-security'], ['hosting-agent', 'k-hosting'], ['analytics-agent', 'k-analytics']]) {
    auth.addPrincipal({ id: id!, organization_id: id === 'security-agent' ? 'sentinel-sec' : 'acme', credential: cred! });
  }
  rootId = auth.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
    resources: ['src/**', 'package.json', 'preview', 'landing-page'], expires_at: later(60), max_delegation_depth: 2,
  } }).id;
  [lead, design, security, hosting, analytics] = await Promise.all(['k-lead', 'k-design', 'k-security', 'k-hosting', 'k-analytics'].map((k) => ok(auth.connect(k))));
  const give = async (to: string, scope: Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>) =>
    (await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: to, scope: { ...scope, expires_at: later(30), max_delegation_depth: 0 } }))).id;
  grants.design = await give('design-agent', { actions: ['repo.read', 'repo.write'], resources: ['src/components/**', 'src/styles/**'] });
  grants.security = await give('security-agent', { actions: ['repo.read'], resources: ['src/**', 'package.json'] });
  grants.hosting = await give('hosting-agent', { actions: ['repo.read'], resources: ['src/**', 'package.json'] });
  grants.analytics = await give('analytics-agent', { actions: ['analytics.aggregate'], resources: ['landing-page'] });
}, 240_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('repo gateway', () => {
  it('lets the design agent read and write inside its UI paths and produces a real change', async () => {
    const repo = createRepoGateway(root);
    const files = await ok(repo.list(design, grants.design!, 'src/components'));
    expect(files).toEqual(['src/components/Features.tsx', 'src/components/Hero.tsx', 'src/components/Signup.tsx']);
    const hero = await ok(repo.read(design, grants.design!, 'src/components/Hero.tsx'));
    const updated = hero.content.replace('<h1>Launchpad</h1>', '<h1>Ship your SaaS in an afternoon</h1>');
    await ok(repo.write(design, grants.design!, 'src/components/Hero.tsx', updated));
    expect(readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8')).toContain('Ship your SaaS in an afternoon');
  });
  it('refuses .env for everyone, writes outside the UI paths, and path escapes', async () => {
    const repo = createRepoGateway(root);
    expect(code(await repo.read(design, grants.design!, '.env'))).toBe('RESOURCE_DENIED');
    expect(code(await repo.read(security, grants.security!, '.env'))).toBe('RESOURCE_DENIED');
    expect(code(await repo.write(design, grants.design!, 'src/lib/newsletter.ts', 'x'))).toBe('RESOURCE_DENIED');
    const secWrite = await repo.write(security, grants.security!, 'src/components/Hero.tsx', 'x');
    expect(secWrite).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE' }); // read-only grant: recoverable, but the lead will never grant it
    expect(code(await repo.read(design, grants.design!, '../../etc/hosts'))).toBe('RESOURCE_DENIED');
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('FAKE_FIXTURE');
    const everything = await ok(repo.list(security, grants.security!, 'src'));
    expect(everything.some((f) => f.includes('.env'))).toBe(false);
  });
  it('lets the security agent read source but only with its own session', async () => {
    const repo = createRepoGateway(root);
    const nl = await ok(repo.read(security, grants.security!, 'src/lib/newsletter.ts'));
    expect(nl.content).toContain('dangerouslySetInnerHTML');
    expect(code(await repo.read(design, grants.security!, 'src/lib/newsletter.ts'))).toBe('INVALID_CALLER');
  });
});

describe('analytics gateway', () => {
  it('computes aggregates from the dataset and never includes ids or emails', async () => {
    const gw = createAnalyticsGateway(join(root, 'data/analytics-events.json'));
    const s = await ok(gw.aggregate(analytics, grants.analytics!, 'landing-page'));
    expect(s.page_views).toBeGreaterThan(3000);
    expect(s.signups).toBeGreaterThan(100);
    expect(s.conversion_rate).toBeCloseTo(s.signups / s.page_views, 4);
    expect(s.by_source.map((b) => b.source).sort()).toEqual(['ads', 'hn', 'newsletter', 'organic', 'twitter']);
    expect(s.daily).toHaveLength(14);
    expect(JSON.stringify(s)).not.toMatch(/@example\.com|"user_id"|u_[0-9a-z]{4}/);
    const raw = JSON.parse(readFileSync(join(root, 'data/analytics-events.json'), 'utf8'));
    expect(summarize('landing-page', raw.events).signups).toBe(raw.events.filter((e: any) => e.type === 'signup').length);
  });
  it('refuses raw rows with a recoverable denial the agent must not be able to satisfy', async () => {
    const gw = createAnalyticsGateway(join(root, 'data/analytics-events.json'));
    const r = await gw.raw(analytics, grants.analytics!, 'landing-page');
    expect(r.status).toBe('AUTHORITY_REQUIRED');
    // and even the lead's root grant does not carry analytics.raw
    expect(code(await gw.raw(lead, rootId, 'landing-page'))).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('deploy gateway', () => {
  it('refuses production with a preview hint, then builds and serves a real local preview after negotiation', async () => {
    const gw = createDeployGateway(root);
    try {
      const prod = await gw.deploy(hosting, grants.hosting!, 'production');
      expect(prod).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE' });
      expect((prod as any).alternative_scope.actions).toEqual(['deploy.preview']);

      const preview: WorkforceScope = { actions: ['deploy.preview'], resources: ['preview'], expires_at: later(20), max_delegation_depth: 0 };
      const req = await ok(hosting.requestAuthority({ parent_grant_id: rootId, requested_scope: preview, reason: 'production refused; preview offered as the alternative' }));
      await ok(lead.respond({ request_id: req.request_id, decision: 'COUNTEROFFER', offered_scope: preview }));
      const g = await ok(hosting.accept({ request_id: req.request_id, idempotency_key: 'deploy-1' }));

      const d = await ok(gw.deploy(hosting, g.id, 'preview'));
      expect(d.provider).toBe('local-next-start');
      expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const html = await (await fetch(d.url)).text();
      expect(html).toContain('Ship your SaaS in an afternoon'); // the design agent's edit, served for real
    } finally {
      await gw.stopAll();
    }
  }, 180_000);
});
