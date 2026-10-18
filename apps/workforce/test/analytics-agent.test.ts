/**
 * Analytics agent against the MOCK authority and a throwaway copy of
 * demo-project. Metrics are checked against a direct pass over the raw
 * dataset, which the agent itself is never allowed to read.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../src/agent-base.js';
import type { ApiResult, WorkforceScope, WorkforceSession } from '../src/contract.js';
import { createAnalyticsGateway, type AnalyticsEvent } from '../src/gateways/analytics.js';
import { MockWorkforceAuthority } from '../src/mock-authority.js';
import { deriveInsights, runAnalyticsAgent, type AnalyticsResult } from '../src/agents/analytics.js';

const SOURCE = fileURLToPath(new URL('../../../demo-project/', import.meta.url));
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const ok = async <T>(p: Promise<ApiResult<T>>): Promise<T> => { const r = await p; expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('OK'); return (r as { data: T }).data; };

let root: string;
let auth: MockWorkforceAuthority;
let lead: WorkforceSession, analytics: WorkforceSession;
let rootId: string, analyticsGrant: string, wrongGrant: string;
let events: AnalyticsEvent[];
type TraceLine = Parameters<AgentContext['trace']>[0];

const makeCtx = (grant_id: string, lines: TraceLine[] = []): AgentContext => ({
  name: 'analytics-agent', session: analytics, grant_id,
  gateways: { analytics: createAnalyticsGateway(join(root, 'data/analytics-events.json')) },
  trace: (l) => lines.push(l),
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'agentpass-analytics-'));
  cpSync(SOURCE, root, { recursive: true, filter: (src) => !/node_modules|\.next/.test(src) });
  events = (JSON.parse(readFileSync(join(root, 'data/analytics-events.json'), 'utf8')) as { events: AnalyticsEvent[] }).events;

  auth = new MockWorkforceAuthority();
  auth.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: 'k-lead' });
  auth.addPrincipal({ id: 'analytics-agent', organization_id: 'acme', credential: 'k-analytics' });
  rootId = auth.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
    resources: ['src/**', 'package.json', 'preview', 'landing-page'], expires_at: later(60), max_delegation_depth: 2,
  } }).id;
  [lead, analytics] = await Promise.all(['k-lead', 'k-analytics'].map((k) => ok(auth.connect(k))));
  const give = async (scope: Omit<WorkforceScope, 'expires_at' | 'max_delegation_depth'>) =>
    (await ok(lead.delegate({ parent_grant_id: rootId, recipient_principal_id: 'analytics-agent', scope: { ...scope, expires_at: later(30), max_delegation_depth: 0 } }))).id;
  analyticsGrant = await give({ actions: ['analytics.aggregate'], resources: ['landing-page'] });
  wrongGrant = await give({ actions: ['repo.read'], resources: ['src/**'] }); // a real grant, just not for analytics
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('analytics agent', () => {
  let result: AnalyticsResult;
  const lines: TraceLine[] = [];

  beforeAll(async () => { result = await ok(runAnalyticsAgent(makeCtx(analyticsGrant, lines))); });

  it('reports metrics that match a direct computation over the dataset', () => {
    const views = events.filter((e) => e.type === 'page_view'), signups = events.filter((e) => e.type === 'signup');
    expect(result.summary.page_views).toBe(views.length);
    expect(result.summary.signups).toBe(signups.length);
    expect(result.summary.conversion_rate).toBeCloseTo(signups.length / views.length, 4);
    expect(result.insights.conversion_rate).toBe(result.summary.conversion_rate);
    expect(result.insights.benchmark).toBe(0.03);
    expect(result.computed_by).toBe('analytics-agent (code, no LLM)');
  });

  it('derives best/worst source, mobile share and the week-over-week signup change in code', () => {
    const views = events.filter((e) => e.type === 'page_view');
    const rate = (source: string) => {
      const v = views.filter((e) => e.source === source).length, s = events.filter((e) => e.type === 'signup' && e.source === source).length;
      return { v, rate: s / v };
    };
    const sources = [...new Set(events.map((e) => e.source))].map((source) => ({ source, ...rate(source) })).filter((s) => s.v >= 50).sort((a, b) => b.rate - a.rate);
    const ins = deriveInsights(result.summary);
    expect(ins).toEqual(result.insights);
    expect(ins.best_source?.source).toBe(sources[0]!.source);
    expect(ins.worst_source?.source).toBe(sources[sources.length - 1]!.source);
    expect(ins.best_source!.conversion_rate).toBeCloseTo(sources[0]!.rate, 4);
    // the dataset is built so these are the answers; pin them so a regression in the rules is visible
    expect(ins.best_source?.source).toBe('newsletter');
    expect(ins.worst_source?.source).toBe('twitter');

    expect(ins.mobile_share).toBeCloseTo(views.filter((e) => e.device === 'mobile').length / views.length, 4);
    expect(ins.mobile_share).toBeGreaterThan(0.5);

    const days = [...new Set(events.map((e) => e.ts.slice(0, 10)))].sort();
    expect(days).toHaveLength(14);
    const signupsOn = (ds: string[]) => events.filter((e) => e.type === 'signup' && ds.includes(e.ts.slice(0, 10))).length;
    const prev = signupsOn(days.slice(0, 7)), last = signupsOn(days.slice(7));
    expect(ins.prev7_signups).toBe(prev);
    expect(ins.last7_signups).toBe(last);
    expect(ins.last7_vs_prev7_signups_pct).toBeCloseTo(((last - prev) / prev) * 100, 1);
  });

  it('produces 2 or 3 rule-based suggestions that each cite a computed percentage', () => {
    expect(result.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
    for (const s of result.suggestions) expect(s).toMatch(/\d+(\.\d+)?%/);
    const site = (result.summary.conversion_rate * 100).toFixed(1);
    expect(result.suggestions[0]).toContain(`twitter converts at ${(result.insights.worst_source!.conversion_rate * 100).toFixed(1)}%`);
    expect(result.suggestions[0]).toContain(`${site}% site average`);
    expect(result.suggestions.some((s) => s.includes('mobile') && s.includes(`${(result.insights.mobile_share * 100).toFixed(1)}%`))).toBe(true);
    expect(result.suggestions.some((s) => s.startsWith('newsletter converts best'))).toBe(true);
  });

  it('was refused raw rows (traced as a denial) and leaks no user ids or emails', () => {
    expect(result.denied).toEqual([{ what: 'analytics.raw(landing-page)', code: 'INSUFFICIENT_SCOPE' }]);
    const denials = lines.filter((l) => l.kind === 'denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]!.text).toMatch(/negative check analytics\.raw\(landing-page\) → AUTHORITY_REQUIRED INSUFFICIENT_SCOPE/);
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/user_id|email|@example\.com|u_[0-9a-z]{4}/);
    expect(result.summary.contains_pii).toBe(false);
  });

  it('is recorded in the audit trail as an aggregate ALLOW and a raw refusal, from the MOCK source', async () => {
    const trail = (await auth.audit()).filter((e) => e.principal_id === 'analytics-agent' && e.grant_id === analyticsGrant);
    expect(trail.some((e) => e.action === 'analytics.aggregate' && e.decision === 'ALLOW')).toBe(true);
    expect(trail.some((e) => e.action === 'analytics.raw' && e.decision === 'AUTHORITY_REQUIRED' && e.reason_code === 'INSUFFICIENT_SCOPE')).toBe(true);
    expect(trail.every((e) => e.source === 'MOCK')).toBe(true);
  });

  it('fails closed with a result status when its grant lacks analytics.aggregate', async () => {
    const lines: TraceLine[] = [];
    const r = await runAnalyticsAgent(makeCtx(wrongGrant, lines));
    expect(r).toMatchObject({ status: 'AUTHORITY_REQUIRED', code: 'INSUFFICIENT_SCOPE' });
    expect((r as { required_scope?: WorkforceScope }).required_scope?.actions).toEqual(['analytics.aggregate']);
    expect(lines.filter((l) => l.kind === 'denied')).toHaveLength(1);
    expect(lines.some((l) => l.kind === 'result')).toBe(false);
  });

  it('fails cleanly when started without an analytics gateway', async () => {
    const ctx: AgentContext = { ...makeCtx(analyticsGrant), gateways: {} };
    expect(await runAnalyticsAgent(ctx)).toMatchObject({ status: 'ERROR', code: 'INVALID_REQUEST' });
  });
});
