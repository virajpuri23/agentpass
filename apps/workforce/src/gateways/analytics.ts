/**
 * Analytics gateway: computes aggregates in code from the synthetic dataset.
 * `aggregate` needs analytics.aggregate; `raw` needs analytics.raw (which no
 * demo grant carries). Nothing user-identifying leaves `aggregate`.
 */
import { readFileSync } from 'node:fs';
import type { ApiResult, WorkforceSession } from '../contract.js';

export interface AnalyticsEvent { id: number; type: 'page_view' | 'signup'; ts: string; user_id: string; source: string; path?: string; device?: string; email?: string }

export interface AnalyticsSummary {
  dataset: string;
  period: { from: string; to: string; days: number };
  page_views: number;
  signups: number;
  conversion_rate: number;
  by_source: { source: string; page_views: number; signups: number; conversion_rate: number }[];
  by_device: { device: string; page_views: number; share: number }[];
  daily: { date: string; page_views: number; signups: number }[];
  /** Computed, not generated: the gateway never includes ids or emails. */
  contains_pii: false;
}

export interface AnalyticsGateway {
  aggregate(session: WorkforceSession, grant_id: string, dataset: string): Promise<ApiResult<AnalyticsSummary>>;
  raw(session: WorkforceSession, grant_id: string, dataset: string): Promise<ApiResult<AnalyticsEvent[]>>;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 10000) / 10000 : 0);

export function summarize(dataset: string, events: AnalyticsEvent[]): AnalyticsSummary {
  const views = events.filter((e) => e.type === 'page_view');
  const signups = events.filter((e) => e.type === 'signup');
  const group = <K extends string>(items: AnalyticsEvent[], key: (e: AnalyticsEvent) => K) => {
    const m = new Map<K, AnalyticsEvent[]>();
    for (const e of items) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
    return m;
  };
  const sources = [...new Set(events.map((e) => e.source))].sort();
  const by_source = sources.map((source) => {
    const v = views.filter((e) => e.source === source).length, s = signups.filter((e) => e.source === source).length;
    return { source, page_views: v, signups: s, conversion_rate: pct(s, v) };
  }).sort((a, b) => b.page_views - a.page_views);
  const byDevice = group(views, (e) => e.device ?? 'unknown');
  const by_device = [...byDevice].map(([device, list]) => ({ device, page_views: list.length, share: pct(list.length, views.length) })).sort((a, b) => b.page_views - a.page_views);
  const byDay = group(events, (e) => e.ts.slice(0, 10));
  const daily = [...byDay.keys()].sort().map((date) => ({ date, page_views: byDay.get(date)!.filter((e) => e.type === 'page_view').length, signups: byDay.get(date)!.filter((e) => e.type === 'signup').length }));
  const ts = events.map((e) => e.ts).sort();
  return {
    dataset,
    period: { from: ts[0]!, to: ts[ts.length - 1]!, days: daily.length },
    page_views: views.length, signups: signups.length, conversion_rate: pct(signups.length, views.length),
    by_source, by_device, daily, contains_pii: false,
  };
}

export function createAnalyticsGateway(file: string): AnalyticsGateway {
  const load = () => JSON.parse(readFileSync(file, 'utf8')) as { dataset: string; events: AnalyticsEvent[] };
  return {
    async aggregate(session, grant_id, dataset) {
      const auth = await session.authorize({ grant_id, action: 'analytics.aggregate', resource: dataset });
      if (auth.status !== 'OK') return auth;
      const data = load();
      if (data.dataset !== dataset) return { status: 'ERROR', code: 'INVALID_REQUEST', reason: `Unknown dataset ${dataset}` };
      return { status: 'OK', data: summarize(dataset, data.events) };
    },
    async raw(session, grant_id, dataset) {
      const auth = await session.authorize({ grant_id, action: 'analytics.raw', resource: dataset });
      if (auth.status !== 'OK') return auth;
      return { status: 'OK', data: load().events };
    },
  };
}
