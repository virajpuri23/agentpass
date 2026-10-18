/**
 * npm run demo [-- --project <dir>] [-- --keep]
 *
 * The coding-agent workforce demo from a clean seeded state: a lead agent
 * coordinates Design, Security (external), Hosting and Analytics specialists
 * on a fresh copy of demo-project/, through the MOCK authority (labeled) and
 * the real gateways. Prints the timeline, the outputs and the 12 checks from
 * the scope; exits 1 if any check fails. Specialists that are not yet built
 * are reported as missing, never faked.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Trace } from '../apps/workforce/src/agent-base.js';
import { createAnalyticsGateway } from '../apps/workforce/src/gateways/analytics.js';
import { createDeployGateway } from '../apps/workforce/src/gateways/deploy.js';
import { createRepoGateway } from '../apps/workforce/src/gateways/repo.js';
import { MockWorkforceAuthority } from '../apps/workforce/src/mock-authority.js';
import { runWorkflow, type Specialists, type WorkflowEvent, type WorkflowResult } from '../apps/workforce/src/orchestrator.js';

const SOURCE = fileURLToPath(new URL('../demo-project/', import.meta.url));
const argv = process.argv.slice(2);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const clock = () => new Date().toISOString().slice(11, 23);

export type Check = { n: number; title: string; pass: boolean; detail: string };

/** Loads whichever specialist agents exist on this branch. */
async function loadSpecialists(): Promise<{ specialists: Specialists; missing: string[] }> {
  const specialists: Specialists = {};
  const missing: string[] = [];
  const tryLoad = async (name: keyof Specialists, file: string, fn: string) => {
    try { const m = await import(file); specialists[name] = m[fn]; } catch { missing.push(name); }
  };
  await tryLoad('design', '../apps/workforce/src/agents/design.js', 'runDesignAgent');
  await tryLoad('security', '../apps/workforce/src/agents/security.js', 'runSecurityAgent');
  await tryLoad('analytics', '../apps/workforce/src/agents/analytics.js', 'runAnalyticsAgent');
  return { specialists, missing };
}

/** Live stream for the demo UI: real workflow events, agent trace lines, then the outputs. */
export type WorkforceStreamEvent =
  | { type: 'meta'; authority: 'MOCK' | 'AGENTPASS'; project: string; missing: string[] }
  | { type: 'event'; event: WorkflowEvent }
  | { type: 'trace'; at: string; agent: string; kind: string; text: string; code?: string }
  | { type: 'outputs'; outputs: DemoOutputs }
  | { type: 'check'; check: Check }
  | { type: 'done'; passed: boolean };

export interface DemoOutputs {
  before: { hero: string; newsletter: string };
  after: { hero: string; newsletter: string };
  design?: unknown;
  security?: unknown;
  hosting?: unknown;
  analytics?: unknown;
  fix_applied: boolean;
  grants: Record<string, unknown>;
  revoked: string[];
  reuse_after_revoke: unknown[];
}

export async function runDemo(opts: { project?: string; print?: (l: string) => void; onStream?: (e: WorkforceStreamEvent) => void } = {}) {
  const stream = opts.onStream ?? (() => {});
  const print = opts.print ?? (() => {});
  const root = opts.project ?? mkdtempSync(join(tmpdir(), 'agentpass-workforce-'));
  if (!opts.project) {
    cpSync(SOURCE, root, { recursive: true, filter: (s) => !/node_modules|\.next/.test(s) });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--silent'], { cwd: root, stdio: 'ignore' });
  }
  const before = { hero: readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8'), newsletter: readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8') };

  // Clean seeded authority: fresh random credentials, one root grant to the lead.
  const auth = new MockWorkforceAuthority();
  const cred = () => randomBytes(24).toString('base64url');
  const credentials = { lead: cred(), design: cred(), security: cred(), hosting: cred(), analytics: cred() };
  auth.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: credentials.lead });
  auth.addPrincipal({ id: 'design-agent', organization_id: 'acme', credential: credentials.design });
  auth.addPrincipal({ id: 'security-agent', organization_id: 'sentinel-sec', credential: credentials.security });
  auth.addPrincipal({ id: 'hosting-agent', organization_id: 'acme', credential: credentials.hosting });
  auth.addPrincipal({ id: 'analytics-agent', organization_id: 'acme', credential: credentials.analytics });
  const root_grant = auth.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
    actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
    resources: ['src/**', 'package.json', 'preview', 'landing-page'],
    expires_at: new Date(Date.now() + 3600_000).toISOString(), max_delegation_depth: 2,
  } });

  const gateways = { repo: createRepoGateway(root), deploy: createDeployGateway(root), analytics: createAnalyticsGateway(join(root, 'data/analytics-events.json')) };
  const { specialists, missing } = await loadSpecialists();
  const trace: Trace = (l) => {
    stream({ type: 'trace', at: new Date().toISOString(), agent: l.agent, kind: l.kind, text: l.text, code: l.code });
    print(`${clock()}  ${l.agent.padEnd(16)} ${l.kind === 'denied' ? c(31, l.text) : l.kind === 'result' ? c(32, l.text) : l.kind === 'note' ? c(36, '» ' + l.text) : l.text}`);
  };
  stream({ type: 'meta', authority: auth.source, project: root, missing });

  let result: WorkflowResult | undefined, error: Error | undefined;
  try { result = await runWorkflow({ authority: auth, credentials, rootGrantId: root_grant.id, gateways, specialists, trace, onEvent: (event) => stream({ type: 'event', event }) }); }
  catch (e) { error = e as Error; }
  finally { await gateways.deploy.stopAll(); }

  const after = { hero: readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8'), newsletter: readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8') };
  const env = readFileSync(join(root, '.env'), 'utf8');
  const audit = await auth.audit();
  const denied = (agent: string, resource: string) => audit.some((e) => e.principal_id === agent && e.decision === 'DENY' && e.resource === resource);
  const r = result;
  const checks: Check[] = [];
  const check = (n: number, title: string, pass: boolean, detail: string) => { const x = { n, title, pass, detail }; checks.push(x); stream({ type: 'check', check: x }); };
  const sec = r?.security as { findings?: { file: string; severity: string }[] } | undefined;
  const an = r?.analytics as { summary?: { page_views: number; signups: number; conversion_rate: number }; suggestions?: string[] } | undefined;

  check(1, 'Design agent changes actual UI files', before.hero !== after.hero, missing.includes('design') ? 'design agent not built yet' : `Hero.tsx changed (${before.hero.length} → ${after.hero.length} bytes)`);
  check(2, 'Design agent cannot read .env', denied('design-agent', '.env') && env.includes('FAKE_FIXTURE'), denied('design-agent', '.env') ? 'RESOURCE_DENIED recorded; .env intact' : 'no .env denial recorded');
  check(3, 'Security agent completes a real audit', !!sec?.findings?.some((f) => f.file === 'src/lib/newsletter.ts' && f.severity === 'high'), missing.includes('security') ? 'security agent not built yet' : `${sec?.findings?.length ?? 0} finding(s), high on src/lib/newsletter.ts`);
  check(4, 'Security agent cannot modify source files', audit.some((e) => e.principal_id === 'security-agent' && e.action === 'repo.write' && e.decision !== 'ALLOW'), 'write attempt refused (read-only grant)');
  check(5, 'Hosting agent requests production deployment', r?.hosting?.production_attempt.status !== undefined, `attempted deploy.production → ${r?.hosting?.production_attempt.status}`);
  check(6, 'AgentPass denies production authorization', r?.hosting?.production_attempt.code === 'INSUFFICIENT_SCOPE' && r?.hosting?.production_attempt.alternative?.[0] === 'deploy.preview', `INSUFFICIENT_SCOPE with alternative deploy.preview`);
  check(7, 'Hosting agent requests narrower preview authority', r?.hosting?.negotiation?.requested.actions.join() === 'deploy.preview', `requested ${r?.hosting?.negotiation?.requested.actions.join(', ')}; lead counteroffered ${r?.hosting?.negotiation?.status}`);
  check(8, 'Hosting agent deploys the preview successfully', !!r?.hosting?.deployment?.url, r?.hosting?.deployment ? `${r.hosting.deployment.url} (${r.hosting.deployment.provider}, local)` : r?.hosting?.failure?.reason ?? 'no deployment');
  check(9, 'Analytics agent computes real aggregate metrics', !!an?.summary && an.summary.signups > 0 && (an.suggestions?.length ?? 0) >= 2, missing.includes('analytics') ? 'analytics agent not built yet' : `${an?.summary?.page_views} views, ${an?.summary?.signups} signups, ${((an?.summary?.conversion_rate ?? 0) * 100).toFixed(2)}% conversion, ${an?.suggestions?.length} suggestions`);
  check(10, 'Analytics agent cannot retrieve raw user records', audit.some((e) => e.principal_id === 'analytics-agent' && e.action === 'analytics.raw' && e.decision !== 'ALLOW') && !JSON.stringify(an ?? {}).includes('@example.com'), 'analytics.raw refused; no emails in output');
  check(11, 'Temporary grants are revoked after task completion', (r?.revoked.length ?? 0) >= 4 && Object.values(r?.grants ?? {}).every((g) => r!.revoked.includes(g.id)), `${r?.revoked.length ?? 0} grant(s) revoked`);
  check(12, 'Attempts to reuse revoked grants fail', (r?.reuse_after_revoke.length ?? 0) >= 4 && r!.reuse_after_revoke.every((x) => x.code === 'GRANT_REVOKED'), r?.reuse_after_revoke.map((x) => `${x.agent}: ${x.code}`).join(', ') ?? '');

  const fixApplied = !!r?.fix?.applied && after.newsletter.includes('escapeHtml(name)');
  stream({ type: 'outputs', outputs: { before, after, design: r?.design, security: r?.security, hosting: r?.hosting, analytics: r?.analytics, fix_applied: fixApplied, grants: r?.grants ?? {}, revoked: r?.revoked ?? [], reuse_after_revoke: r?.reuse_after_revoke ?? [] } });
  const passed = checks.every((x) => x.pass);
  stream({ type: 'done', passed });
  if (!opts.project) rmSync(root, { recursive: true, force: true });
  return { result, error, checks, missing, fixApplied, before, after, audit, passed };
}

async function main() {
  const project = argv.includes('--project') ? argv[argv.indexOf('--project') + 1] : undefined;
  console.log(c(1, '\nAgentPass workforce demo: a coding agent and four specialists build a landing page\n'));
  const out = await runDemo({ project, print: (l) => console.log(l) });
  if (out.error) console.log(c(31, `\nWorkflow error: ${out.error.message}`));
  console.log(c(1, '\nAuthority: ') + (out.result?.authority_source === 'MOCK' ? c(33, 'MOCK (Developer A\'s generic-action contract not yet wired)') : 'AgentPass'));
  if (out.missing.length) console.log(c(33, `Specialists not built yet (not faked): ${out.missing.join(', ')}`));
  console.log(c(1, '\nOutputs'));
  const h = out.result?.hosting;
  if (h?.deployment) console.log(`  Preview URL: ${h.deployment.url}  [${h.deployment.provider}: local build, not production]`);
  const sec = out.result?.security as any;
  if (sec?.findings) for (const f of sec.findings) console.log(`  Security: [${f.severity}] ${f.rule} at ${f.file}:${f.line}`);
  console.log(`  Security fix applied by lead: ${out.fixApplied ? 'yes (escapeHtml)' : 'no'}`);
  const an = out.result?.analytics as any;
  if (an?.summary) { console.log(`  Analytics: ${an.summary.page_views} views, ${an.summary.signups} signups, ${(an.summary.conversion_rate * 100).toFixed(2)}% conversion`); for (const s of an.suggestions ?? []) console.log(`    • ${s}`); }
  console.log(c(1, '\nChecks'));
  for (const x of out.checks) console.log(`  ${x.pass ? c(32, 'PASS') : c(31, 'FAIL')}  ${String(x.n).padStart(2)}. ${x.title.padEnd(52)} ${c(90, x.detail)}`);
  const n = out.checks.filter((x) => x.pass).length;
  console.log(out.passed ? c(32, `\n${n}/12 checks passed\n`) : c(31, `\n${n}/12 checks passed\n`));
  process.exit(out.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
