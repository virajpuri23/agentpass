/**
 * npm run demo [-- --project <dir>] [-- --authority mock] [-- --gateway remote]
 *
 * The coding-agent workforce demo from a clean seeded state: a lead agent
 * coordinates Design, Security (external), Hosting and Analytics specialists
 * on a fresh copy of demo-project/, through AgentPass (Developer A's authority,
 * in-process) or the labeled MOCK, and the real gateways. Prints the timeline,
 * the outputs and the 12 checks from the scope; exits 1 if any check fails.
 * Specialists that are not yet built are reported as missing, never faked.
 *
 * `--gateway remote` runs the protected workforce gateway AND the external
 * Security agent as separate child processes: AgentPass reaches the gateway
 * over HTTP with a service key (exactly how the hosted deployment would), and
 * the lead reaches the Security agent over HTTP with a per-task token while
 * that process alone holds the auditor's credential.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db/database.js';
import { migrateStore } from '../db/migrations.js';
import { seedDatabase } from '../db/seed.js';
import { seedWorkforceRoot } from '../db/seed-workforce.js';
import { sqliteStore } from '../db/store.js';
import { createAuthorityApp } from '../apps/authority/src/app.js';
import type { SupplierService } from '../apps/authority/src/supplier.js';
import { workforceFromEnvironment } from '../apps/authority/src/workforce-client.js';
import type { WorkforceOptions } from '../apps/authority/src/workforce.js';
import { GATEWAY_ENTRY, SECURITY_ENTRY, gatewayServiceEnv, securityServiceEnv, startChildService, type ChildService } from '../apps/workforce/src/processes.js';
import type { SecurityServiceClient } from '../apps/workforce/src/orchestrator.js';
import { RealWorkforceAuthority } from '../apps/workforce/src/real/authority.js';
import { createRealGateways } from '../apps/workforce/src/real/gateways.js';
import { createDemoProjectResource } from '../apps/workforce/src/real/resource-adapter.js';
import type { Trace } from '../apps/workforce/src/agent-base.js';
import { createAnalyticsGateway } from '../apps/workforce/src/gateways/analytics.js';
import { createDeployGateway } from '../apps/workforce/src/gateways/deploy.js';
import { createRepoGateway } from '../apps/workforce/src/gateways/repo.js';
import { MockWorkforceAuthority } from '../apps/workforce/src/mock-authority.js';
import type { WorkforceAuthority } from '../apps/workforce/src/contract.js';
import { runWorkflow, type Credentials, type Specialists, type WorkflowEvent, type WorkflowResult } from '../apps/workforce/src/orchestrator.js';

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

export type AuthorityMode = 'agentpass' | 'mock';
/** `inprocess`: the demo-project adapter is registered directly; `remote`: AgentPass calls B's gateway service over HTTP. */
export type GatewayMode = 'inprocess' | 'remote';

const WORKFORCE_ALLOWED_ACTIONS = ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'] as const;

/**
 * AgentPass itself, in-process on a migrated throwaway SQLite: Developer A's authority app with the
 * demo-project resource registered. Principals: owner-1 and buyer-agent (the lead) from A's admin seed,
 * plus the external security-agent registered under sentinel-sec. The workforce root is issued by owner-1.
 */
async function agentpassStack(root: string, gateway: GatewayMode, log: (line: string) => void) {
  const cred = () => randomBytes(24).toString('base64url');
  const keys = { owner: cred(), lead: cred(), sourcing: cred(), supplierAgent: cred(), security: cred() };
  const db = openDatabase(join(root, '..', `authority-${randomBytes(4).toString('hex')}.sqlite`));
  const store = sqliteStore(db);
  await migrateStore(store, 'sqlite');
  seedDatabase(db, { 'owner-1': keys.owner, 'buyer-agent': keys.lead, 'sourcing-agent': keys.sourcing, 'supplier-agent': keys.supplierAgent });
  db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('sentinel-sec', 'Sentinel Security (external)');
  db.prepare('INSERT INTO principals(id,organization_id,kind,role) VALUES(?,?,?,?)').run('security-agent', 'sentinel-sec', 'AGENT', 'SERVICE');
  db.prepare('INSERT INTO principal_keys(key_id,principal_id,key_hash) VALUES(?,?,?)').run('seed:security-agent', 'security-agent', createHash('sha256').update(keys.security).digest('hex'));
  const rootGrantId = 'grant-root-lead';
  await seedWorkforceRoot(store, { grant_id: rootGrantId, owner_principal_id: 'owner-1', subject_principal_id: 'buyer-agent', scope: {
    actions: ['repo.read', 'repo.write', 'security.audit.run', 'deploy.preview', 'analytics.aggregate.read'],
    supplier_ids: [], sku_ids: [], max_per_action_cents: 0, total_budget_cents: 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), max_delegation_depth: 3,
    resources: [{ resource: 'demo-project', organization_id: 'buyer-co', owner_principal_id: 'owner-1', paths: ['src/', 'package.json'] }],
    max_executions: 200,
  } });
  const analyticsFile = join(root, 'data/analytics-events.json');
  const children: ChildService[] = [];
  let workforce: WorkforceOptions;
  let stopAdapter = async () => {};
  if (gateway === 'remote') {
    // B's gateway as its own process with a fresh service key; AgentPass is configured exactly like the hosted
    // server would be (WORKFORCE_RESOURCES_JSON + WORKFORCE_GATEWAY_URL + WORKFORCE_SERVICE_KEY) and keeps
    // repo_root so its own path validation still runs before every call.
    const serviceKey = cred();
    const gw = await startChildService(GATEWAY_ENTRY, gatewayServiceEnv({ serviceKey, repoRoot: root, analyticsFile, organization_id: 'buyer-co', owner_principal_id: 'owner-1' }), { onLog: (l) => log(`[gateway] ${l}`) });
    children.push(gw);
    workforce = workforceFromEnvironment({
      WORKFORCE_RESOURCES_JSON: JSON.stringify([{ resource: 'demo-project', organization_id: 'buyer-co', owner_principal_id: 'owner-1', repo_root: root, allowed_actions: [...WORKFORCE_ALLOWED_ACTIONS] }]),
      WORKFORCE_GATEWAY_URL: gw.url, WORKFORCE_SERVICE_KEY: serviceKey,
    })!;
  } else {
    const adapter = createDemoProjectResource({ repoRoot: root, analyticsFile, organization_id: 'buyer-co', owner_principal_id: 'owner-1' });
    workforce = { resources: [adapter] };
    stopAdapter = () => adapter.stop();
  }
  const supplier: SupplierService = {
    async policy() { return false; },
    async quote() { throw new Error('unused'); }, async getQuote() { throw new Error('unused'); }, async fulfill() { throw new Error('unused'); },
  };
  const app = createAuthorityApp({ db: store, supplier, workforce });
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const authorityUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = new RealWorkforceAuthority({ authorityUrl, identity: { organization_id: 'buyer-co', owner_principal_id: 'owner-1' }, ownerCredential: keys.owner, defaultMaxExecutions: 40 });
  // The external Security agent as its own process: only IT receives the auditor's credential; the lead gets a per-task token.
  let securityService: SecurityServiceClient | undefined;
  let credentials: Credentials = { lead: keys.lead, security: keys.security };
  if (gateway === 'remote') {
    const token = cred();
    const sec = await startChildService(SECURITY_ENTRY, securityServiceEnv({ credential: keys.security, taskToken: token, repoRoot: root, analyticsFile, authorityUrl }), { onLog: (l) => log(`[security-agent] ${l}`) });
    children.push(sec);
    securityService = { url: sec.url, token, authority_url: authorityUrl };
    credentials = { lead: keys.lead }; // the lead process never holds the auditor's credential
  }
  return {
    auth: auth as WorkforceAuthority, rootGrantId, credentials, securityService,
    gateways: createRealGateways({ repoRoot: root, analyticsFile }),
    async stop() { await stopAdapter(); for (const ch of children) await ch.stop(); await new Promise((r) => server.close(r)); db.close(); },
  };
}

export async function runDemo(opts: { project?: string; authority?: AuthorityMode; gateway?: GatewayMode; print?: (l: string) => void; onStream?: (e: WorkforceStreamEvent) => void } = {}) {
  const stream = opts.onStream ?? (() => {});
  const mode: AuthorityMode = opts.authority ?? 'agentpass';
  const gatewayMode: GatewayMode = opts.gateway ?? 'inprocess';
  const print = opts.print ?? (() => {});
  // AgentPass's path guard requires the canonical repository root (macOS tmp dirs are symlinks).
  const root = realpathSync(opts.project ?? mkdtempSync(join(tmpdir(), 'agentpass-workforce-')));
  if (!opts.project) {
    cpSync(SOURCE, root, { recursive: true, filter: (s) => !/node_modules|\.next/.test(s) });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--silent'], { cwd: root, stdio: 'ignore' });
  }
  const before = { hero: readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8'), newsletter: readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8') };

  // Clean seeded authority: fresh random credentials, one root grant to the lead.
  let auth: WorkforceAuthority, rootGrantId: string, credentials: Credentials, gateways: Parameters<typeof runWorkflow>[0]['gateways'];
  let securityService: SecurityServiceClient | undefined;
  let stopStack = async () => {};
  if (mode === 'agentpass') {
    // Child-process logs (one JSON line per request) shown compactly: the remote hop is part of the story.
    const childLog = (l: string) => {
      const m = /^\[([^\]]+)\] (\{.*\})$/.exec(l);
      if (!m) return print(c(90, l));
      try { const j = JSON.parse(m[2]!); print(c(90, `${clock()}  [${m[1]}] ${[j.method, j.path, j.status, j.action, j.replay ? 'replay' : '', j.port ? `listening on ${j.port}` : '', j.error ? `error ${j.name}` : ''].filter(Boolean).join(' ')}`)); }
      catch { print(c(90, l)); }
    };
    const stack = await agentpassStack(root, gatewayMode, childLog);
    ({ auth, rootGrantId, credentials, gateways, securityService } = stack);
    stopStack = stack.stop;
  } else {
    if (gatewayMode === 'remote') throw new Error('--gateway remote needs the AgentPass authority (drop --authority mock)');
    const mock = new MockWorkforceAuthority();
    const cred = () => randomBytes(24).toString('base64url');
    credentials = { lead: cred(), design: cred(), security: cred(), hosting: cred(), analytics: cred() };
    mock.addPrincipal({ id: 'lead-agent', organization_id: 'acme', credential: credentials.lead });
    mock.addPrincipal({ id: 'design-agent', organization_id: 'acme', credential: credentials.design! });
    mock.addPrincipal({ id: 'security-agent', organization_id: 'sentinel-sec', credential: credentials.security! });
    mock.addPrincipal({ id: 'hosting-agent', organization_id: 'acme', credential: credentials.hosting! });
    mock.addPrincipal({ id: 'analytics-agent', organization_id: 'acme', credential: credentials.analytics! });
    rootGrantId = mock.issueRoot({ id: 'grant-root-lead', issuer: 'owner-1', subject: 'lead-agent', organization_id: 'acme', scope: {
      actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'],
      resources: ['src/**', 'package.json', 'preview', 'landing-page'],
      expires_at: new Date(Date.now() + 3600_000).toISOString(), max_delegation_depth: 2,
    } }).id;
    auth = mock;
    gateways = { repo: createRepoGateway(root), deploy: createDeployGateway(root), analytics: createAnalyticsGateway(join(root, 'data/analytics-events.json')) };
  }
  const { specialists, missing } = await loadSpecialists();
  const trace: Trace = (l) => {
    stream({ type: 'trace', at: new Date().toISOString(), agent: l.agent, kind: l.kind, text: l.text, code: l.code });
    print(`${clock()}  ${l.agent.padEnd(16)} ${l.kind === 'denied' ? c(31, l.text) : l.kind === 'result' ? c(32, l.text) : l.kind === 'note' ? c(36, '» ' + l.text) : l.text}`);
  };
  stream({ type: 'meta', authority: auth.source, project: root, missing });

  let result: WorkflowResult | undefined, error: Error | undefined;
  try { result = await runWorkflow({ authority: auth, credentials, rootGrantId, gateways, specialists, securityService, trace, onEvent: (event) => stream({ type: 'event', event }) }); }
  catch (e) { error = e as Error; }
  finally { await gateways.deploy.stopAll(); }

  const after = { hero: readFileSync(join(root, 'src/components/Hero.tsx'), 'utf8'), newsletter: readFileSync(join(root, 'src/lib/newsletter.ts'), 'utf8') };
  const env = readFileSync(join(root, '.env'), 'utf8');
  const audit = await auth.audit();
  const r = result;
  /** A specialist's real principal id: provisioned agents get server-generated ids, so look it up via its grant. */
  const pid = (agent: string) => r?.grants[agent.replace(/-agent$/, '')]?.subject_principal_id ?? agent;
  const refused = (agent: string, resource: string) => audit.some((e) => e.principal_id === pid(agent) && e.decision !== 'ALLOW' && e.resource === resource);
  const refusedAction = (agent: string, action: string) => audit.some((e) => e.principal_id === pid(agent) && e.action === action && e.decision !== 'ALLOW' && !['ISSUED', 'REVOKED', 'REQUESTED', 'COUNTEROFFERED', 'ACCEPTED', 'REJECTED'].includes(e.decision));
  const checks: Check[] = [];
  const check = (n: number, title: string, pass: boolean, detail: string) => { const x = { n, title, pass, detail }; checks.push(x); stream({ type: 'check', check: x }); };
  const sec = r?.security as { findings?: { file: string; severity: string }[] } | undefined;
  const an = r?.analytics as { summary?: { page_views: number; signups: number; conversion_rate: number }; suggestions?: string[] } | undefined;

  check(1, 'Design agent changes actual UI files', before.hero !== after.hero, missing.includes('design') ? 'design agent not built yet' : `Hero.tsx changed (${before.hero.length} → ${after.hero.length} bytes)`);
  check(2, 'Design agent cannot read .env', refused('design-agent', '.env') && env.includes('FAKE_FIXTURE'), refused('design-agent', '.env') ? `${audit.find((e) => e.principal_id === pid('design-agent') && e.resource === '.env')?.reason_code ?? 'refused'} recorded; .env intact` : 'no .env refusal recorded');
  check(3, 'Security agent completes a real audit', !!sec?.findings?.some((f) => f.file === 'src/lib/newsletter.ts' && f.severity === 'high'), missing.includes('security') ? 'security agent not built yet' : `${sec?.findings?.length ?? 0} finding(s), high on src/lib/newsletter.ts`);
  check(4, 'Security agent cannot modify source files', refusedAction('security-agent', 'repo.write'), 'write attempt refused (read-only grant)');
  check(5, 'Hosting agent requests production deployment', r?.hosting?.production_attempt.status !== undefined, `attempted deploy.production → ${r?.hosting?.production_attempt.status}`);
  // The mock answers INSUFFICIENT_SCOPE; AgentPass answers OUTSIDE_PARENT_SCOPE (production is in no ancestor). Both must name preview as the way forward.
  const prodCode = r?.hosting?.production_attempt.code;
  check(6, 'AgentPass denies production authorization', ['INSUFFICIENT_SCOPE', 'OUTSIDE_PARENT_SCOPE'].includes(prodCode ?? '') && r?.hosting?.production_attempt.alternative?.[0] === 'deploy.preview', `${prodCode ?? 'no code'} with alternative ${r?.hosting?.production_attempt.alternative?.join(', ') ?? 'none'}`);
  check(7, 'Hosting agent requests narrower preview authority', r?.hosting?.negotiation?.requested.actions.join() === 'deploy.preview', `requested ${r?.hosting?.negotiation?.requested.actions.join(', ')}; lead counteroffered ${r?.hosting?.negotiation?.status}`);
  check(8, 'Hosting agent deploys the preview successfully', !!r?.hosting?.deployment?.url, r?.hosting?.deployment ? `${r.hosting.deployment.url} (${r.hosting.deployment.provider}, local)` : r?.hosting?.failure?.reason ?? 'no deployment');
  check(9, 'Analytics agent computes real aggregate metrics', !!an?.summary && an.summary.signups > 0 && (an.suggestions?.length ?? 0) >= 2, missing.includes('analytics') ? 'analytics agent not built yet' : `${an?.summary?.page_views} views, ${an?.summary?.signups} signups, ${((an?.summary?.conversion_rate ?? 0) * 100).toFixed(2)}% conversion, ${an?.suggestions?.length} suggestions`);
  check(10, 'Analytics agent cannot retrieve raw user records', refusedAction('analytics-agent', 'analytics.raw') && !JSON.stringify(an ?? {}).includes('@example.com'), 'analytics.raw refused; no emails in output');
  check(11, 'Temporary grants are revoked after task completion', (r?.revoked.length ?? 0) >= 4 && Object.values(r?.grants ?? {}).every((g) => r!.revoked.includes(g.id)), `${r?.revoked.length ?? 0} grant(s) revoked`);
  // GRANT_REVOKED for a delegated principal; INVALID_CALLER for a provisioned child, whose credential AgentPass disables on revocation.
  check(12, 'Attempts to reuse revoked grants fail', (r?.reuse_after_revoke.length ?? 0) >= 4 && r!.reuse_after_revoke.every((x) => ['GRANT_REVOKED', 'INVALID_CALLER'].includes(x.code)), r?.reuse_after_revoke.map((x) => `${x.agent}: ${x.code}${x.code === 'INVALID_CALLER' ? ' (credential disabled)' : ''}`).join(', ') ?? '');

  const fixApplied = !!r?.fix?.applied && after.newsletter.includes('escapeHtml(name)');
  await stopStack();
  stream({ type: 'outputs', outputs: { before, after, design: r?.design, security: r?.security, hosting: r?.hosting, analytics: r?.analytics, fix_applied: fixApplied, grants: r?.grants ?? {}, revoked: r?.revoked ?? [], reuse_after_revoke: r?.reuse_after_revoke ?? [] } });
  const passed = checks.every((x) => x.pass);
  stream({ type: 'done', passed });
  if (!opts.project) rmSync(root, { recursive: true, force: true });
  return { result, error, checks, missing, fixApplied, before, after, audit, passed };
}

async function main() {
  const project = argv.includes('--project') ? argv[argv.indexOf('--project') + 1] : undefined;
  const authority: AuthorityMode = argv.includes('--authority') && argv[argv.indexOf('--authority') + 1] === 'mock' ? 'mock' : 'agentpass';
  const gateway: GatewayMode = argv.includes('--gateway') && argv[argv.indexOf('--gateway') + 1] === 'remote' ? 'remote' : 'inprocess';
  console.log(c(1, `\nAgentPass workforce demo: a coding agent and four specialists build a landing page (authority: ${authority}, gateway: ${gateway}${gateway === 'remote' ? ', security agent: separate process' : ''})\n`));
  const out = await runDemo({ project, authority, gateway, print: (l) => console.log(l) });
  if (out.error) console.log(c(31, `\nWorkflow error: ${out.error.message}`));
  console.log(c(1, '\nAuthority: ') + (out.result?.authority_source === 'MOCK' ? c(33, 'MOCK (run with the default to use AgentPass)') : c(32, 'AgentPass (Developer A\'s authority, real grants, real execute gateway)')));
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
