/**
 * Analytics agent: turns the gateway's PII-free aggregate into insights and
 * 2-3 actionable suggestions, entirely in code (no LLM). It never sees a raw
 * row: the one `raw()` call it makes is a traced negative check that the
 * authority must refuse (its grant carries analytics.aggregate only).
 */
import { noteDenied, type AgentContext } from '../agent-base.js';
import type { ApiResult } from '../contract.js';
import type { AnalyticsSummary } from '../gateways/analytics.js';

export const CONVERSION_BENCHMARK = 0.03;
/** A source needs this many page views before its conversion rate is trusted. */
export const MIN_VIEWS_PER_SOURCE = 50;

export interface SourceInsight { source: string; page_views: number; signups: number; conversion_rate: number }

export interface AnalyticsInsights {
  /** Highest conversion_rate among sources with >= MIN_VIEWS_PER_SOURCE views (null if none qualify). */
  best_source: SourceInsight | null;
  worst_source: SourceInsight | null;
  /** Fraction of page views from device "mobile" (0..1). */
  mobile_share: number;
  /** Signups in the last 7 days vs the 7 days before, as a percent change (null if the earlier week had none). */
  last7_vs_prev7_signups_pct: number | null;
  last7_signups: number;
  prev7_signups: number;
  conversion_rate: number;
  benchmark: typeof CONVERSION_BENCHMARK;
}

export interface AnalyticsResult {
  summary: AnalyticsSummary;
  insights: AnalyticsInsights;
  suggestions: string[];
  /** Refusals the agent ran into, including its deliberate negative check. */
  denied: { what: string; code: string }[];
  computed_by: 'analytics-agent (code, no LLM)';
}

const pctText = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure: everything here is arithmetic over the summary, so tests can check it against the dataset. */
export function deriveInsights(summary: AnalyticsSummary): AnalyticsInsights {
  const qualified = summary.by_source.filter((s) => s.page_views >= MIN_VIEWS_PER_SOURCE);
  const byRate = [...qualified].sort((a, b) => b.conversion_rate - a.conversion_rate || a.source.localeCompare(b.source));
  const pick = (s: typeof byRate[number] | undefined): SourceInsight | null =>
    s ? { source: s.source, page_views: s.page_views, signups: s.signups, conversion_rate: s.conversion_rate } : null;

  const mobile = summary.by_device.find((d) => d.device === 'mobile');
  const mobile_share = summary.page_views ? Math.round(((mobile?.page_views ?? 0) / summary.page_views) * 10000) / 10000 : 0;

  const days = [...summary.daily].sort((a, b) => a.date.localeCompare(b.date));
  const last7 = days.slice(-7), prev7 = days.slice(-14, -7);
  const sum = (list: typeof days) => list.reduce((n, d) => n + d.signups, 0);
  const last7_signups = sum(last7), prev7_signups = sum(prev7);
  const last7_vs_prev7_signups_pct = prev7_signups ? round1(((last7_signups - prev7_signups) / prev7_signups) * 100) : null;

  return {
    best_source: pick(byRate[0]),
    worst_source: pick(byRate.length > 1 ? byRate[byRate.length - 1] : undefined),
    mobile_share,
    last7_vs_prev7_signups_pct,
    last7_signups,
    prev7_signups,
    conversion_rate: summary.conversion_rate,
    benchmark: CONVERSION_BENCHMARK,
  };
}

/**
 * Rule-based suggestions, most actionable first, capped at 3 and never fewer
 * than 2. Every line cites the numbers it was derived from.
 */
export function suggest(ins: AnalyticsInsights): string[] {
  const site = pctText(ins.conversion_rate);
  const out: string[] = [];

  if (ins.worst_source && ins.worst_source.conversion_rate < ins.conversion_rate) {
    const w = ins.worst_source;
    const fix = w.source === 'ads'
      ? 'pause the campaign or retarget it at the segments that convert'
      : `rework the landing message for ${w.source} visitors or retarget them with a tailored CTA`;
    out.push(`${w.source} converts at ${pctText(w.conversion_rate)} vs ${site} site average (${w.signups}/${w.page_views} views): ${fix}.`);
  }
  if (ins.mobile_share > 0.5) {
    out.push(`${pctText(ins.mobile_share)} of page views are mobile but the signup form has no mobile layout: add a stacked, full-width form and a larger submit button.`);
  }
  if (ins.best_source && ins.best_source.conversion_rate > ins.conversion_rate) {
    const b = ins.best_source;
    out.push(`${b.source} converts best at ${pctText(b.conversion_rate)} (${b.signups}/${b.page_views} views, ${site} site average): add a referral prompt for those visitors after signup.`);
  }
  if (ins.conversion_rate < ins.benchmark) {
    out.push(`Overall conversion ${site} is below the ${pctText(ins.benchmark, 0)} benchmark: move the signup form above the fold and cut the form to one field.`);
  } else if (out.length < 2) {
    out.push(`Overall conversion ${site} already beats the ${pctText(ins.benchmark, 0)} benchmark: protect it by keeping the form above the fold on every variant.`);
  }
  if (out.length < 2) {
    const trend = ins.last7_vs_prev7_signups_pct;
    out.push(trend === null
      ? `Signups went from ${ins.prev7_signups} to ${ins.last7_signups} week over week (no baseline, 0% comparable): keep traffic steady before changing the page.`
      : `Signups moved ${trend >= 0 ? '+' : ''}${trend}% week over week (${ins.prev7_signups} → ${ins.last7_signups}): ${trend >= 0 ? 'keep the current channel mix' : 'review what changed in the channel mix'} before the next release.`);
  }
  return out.slice(0, 3);
}

export async function runAnalyticsAgent(ctx: AgentContext, dataset = 'landing-page'): Promise<ApiResult<AnalyticsResult>> {
  const gw = ctx.gateways.analytics;
  if (!gw) return { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'analytics agent was started without an analytics gateway' };
  const denied: AnalyticsResult['denied'] = [];

  ctx.trace({ agent: ctx.name, kind: 'call', text: `analytics.aggregate(${dataset}) via grant ${ctx.grant_id}` });
  const agg = await gw.aggregate(ctx.session, ctx.grant_id, dataset);
  if (noteDenied(ctx, `analytics.aggregate(${dataset})`, agg)) return agg; // fail closed: no summary, no result
  const summary = agg.data;
  ctx.trace({ agent: ctx.name, kind: 'note', text: `aggregate received: ${summary.page_views} views, ${summary.signups} signups over ${summary.period.days} days (contains_pii=${summary.contains_pii})` });

  const insights = deriveInsights(summary);
  const suggestions = suggest(insights);
  ctx.trace({ agent: ctx.name, kind: 'note', text: `insights computed in code: conversion ${pctText(insights.conversion_rate)}, best ${insights.best_source?.source ?? 'n/a'}, worst ${insights.worst_source?.source ?? 'n/a'}, mobile ${pctText(insights.mobile_share)}` });

  // Negative check: raw rows carry user ids and emails; this grant must not reach them.
  ctx.trace({ agent: ctx.name, kind: 'call', text: `negative check: analytics.raw(${dataset}) — expecting a refusal` });
  const raw = await gw.raw(ctx.session, ctx.grant_id, dataset);
  if (noteDenied(ctx, `negative check analytics.raw(${dataset})`, raw)) {
    denied.push({ what: `analytics.raw(${dataset})`, code: raw.code });
  } else {
    // Should never happen with the demo grants; refuse to carry the rows anywhere and say so loudly.
    ctx.trace({ agent: ctx.name, kind: 'note', text: `UNEXPECTED: analytics.raw(${dataset}) was allowed (${raw.data.length} rows discarded, not reported)` });
    return { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'grant unexpectedly allows analytics.raw; refusing to proceed with raw access' };
  }

  const result: AnalyticsResult = { summary, insights, suggestions, denied, computed_by: 'analytics-agent (code, no LLM)' };
  ctx.trace({ agent: ctx.name, kind: 'result', text: `${suggestions.length} suggestions, ${denied.length} refusal(s) recorded`, data: { insights, suggestions, denied } });
  return { status: 'OK', data: result };
}
