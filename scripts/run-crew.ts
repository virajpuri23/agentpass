/**
 * npm run crew:run [-- --decision approve|partial|deny] [-- --partial 300] [-- --hosted]
 *
 * The internal "release crew" demo: a lead coding agent holds a $1,000 tool
 * budget, creates Security / Design / QA specialists with their own identities
 * and budget slices, and decides QA's justified top-up request. Real services,
 * real MCP calls, separate processes. Prints a trace and 9 checks; exits 1 on
 * any failure.
 */
import { launchCrew, type Decision, type DecisionRequest } from '../apps/agent-kit/src/crew-launcher.js';
import type { TraceEvent } from '../apps/agent-kit/src/transport.js';
import { RELEASE_CREW } from '../apps/crew-agent/src/roles.js';
import { hostedStack, isolatedStack, type DemoStack } from './demo-stack.js';
import type { Check, DemoEvent } from './run-e2e.js';

const usd = (c: unknown) => (typeof c === 'number' ? `$${(c / 100).toFixed(0)}` : '?');
type Call = Extract<TraceEvent, { kind: 'call' }>;

export async function runCrew(opts: {
  stack: DemoStack;
  decide: (r: DecisionRequest) => Promise<Decision>;
  onEvent?: (e: DemoEvent) => void;
  print?: (line: string) => void;
}) {
  const emit = opts.onEvent ?? (() => {});
  const print = opts.print ?? (() => {});
  const trace: TraceEvent[] = [];
  const checks: Check[] = [];
  const decisions: { request: DecisionRequest; decision: Decision }[] = [];
  const check = (step: number, title: string, pass: boolean, detail: string) => {
    const x = { step, title, pass, detail };
    checks.push(x); emit({ type: 'check', check: x });
  };
  const runner = (text: string) => { emit({ type: 'runner', at: new Date().toISOString(), text }); print(`runner          ${text}`); };
  emit({ type: 'meta', mode: opts.stack.mode, mcp: 'mcpUrl' in opts.stack.connection ? opts.stack.connection.mcpUrl : 'stdio', root: opts.stack.rootGrantId, decider: 'person', scenario: 'release-crew' });

  const crew = await launchCrew({
    connection: opts.stack.connection,
    leadKey: opts.stack.keys.buyer,
    decide: async (request) => { emit({ type: 'decision_needed', request }); return opts.decide(request); },
    onDecision: (request, decision) => { decisions.push({ request, decision }); emit({ type: 'decision_made', request_id: request.request_id, decision }); },
    onTrace: (e) => {
      trace.push(e); emit({ type: 'trace', event: e });
      print(e.kind === 'note' ? `${e.agent.padEnd(15)} » ${e.text}` : `${e.agent.padEnd(15)} ${e.tool}${(e.args as any).action ? ` (${String((e.args as any).action).replace('supplier.', '')})` : ''} -> ${e.status}${e.code ? ` ${e.code}` : ''}`);
    },
    onProcess: (p) => { emit({ type: 'process', at: new Date().toISOString(), agent: p.agent, pid: p.pid, kind: p.kind }); print(`platform        ${p.kind} ${p.agent} (pid ${p.pid})`); },
  });

  try {
    const result = await crew.run(opts.stack.rootGrantId, RELEASE_CREW);
    const s = result.summary as any;
    const kids = (s.children ?? {}) as Record<string, any>;
    const calls = trace.filter((e): e is Call => e.kind === 'call');

    // 1. Only the lead holds the root budget.
    // Specialists' grants name the root as their parent, but none of them may hold the root itself.
    const specialistGrantReads = calls.filter((c) => c.agent !== 'lead-agent' && c.tool === 'get_my_grants' && c.status === 'OK');
    const specialistsSeeRoot = specialistGrantReads.some((c) => ((c.data as any)?.grants ?? []).some((g: any) => g.id === opts.stack.rootGrantId));
    check(1, 'Only the lead holds the $1,000 tool budget', s.root_budget_cents === 100000 && !specialistsSeeRoot,
      `${s.root_grant_id}: ${usd(s.root_budget_cents)}; specialists see only their own slices`);

    // 2. Three specialists, own identities, one tool each.
    const made = calls.filter((c) => c.agent === 'lead-agent' && c.tool === 'provision_child' && c.status === 'OK');
    const principals = new Set(made.map((c) => (c.data as any)?.principal?.id));
    const slicesOk = made.every((c) => { const sc = (c.data as any)?.grant?.scope; return sc?.sku_ids?.length === 1 && sc.total_budget_cents <= 30000; });
    check(2, 'Lead creates 3 specialists with their own identities and one-tool slices', made.length === 3 && principals.size === 3 && slicesOk,
      RELEASE_CREW.map((r) => `${r.label.split(' ')[0]} ${usd(r.slice_cents)} ${r.sku_id}`).join(' · '));

    // 3. Security and Design buy within their slices.
    const sec = kids['security-agent'], des = kids['design-agent'], qa = kids['qa-agent'];
    check(3, 'Security and Design buy within their slices', sec?.amount_cents === 12000 && des?.amount_cents === 18000,
      `Security ${usd(sec?.amount_cents)} scan · Design ${usd(des?.amount_cents)} asset pack`);

    // 4. QA over its slice -> refused -> asks for a top-up with a justification.
    const refused = calls.find((c) => c.agent === 'qa-agent' && c.tool === 'execute_action' && (c.args as any).action === 'supplier.purchase.execute' && c.code === 'BUDGET_EXCEEDED');
    const ask = calls.find((c) => c.agent === 'qa-agent' && c.tool === 'request_authority' && c.status === 'OK');
    const reason = String((ask?.args as any)?.reason ?? '');
    check(4, 'QA is over its slice and asks for a top-up with a justification', !!refused && (ask?.args as any)?.requested_scope?.total_budget_cents === 35000 && reason.length > 20,
      `asked ${usd((ask?.args as any)?.requested_scope?.total_budget_cents)}: “${reason.slice(0, 70)}…”`);

    // 5. The decision is enforced exactly.
    const d = decisions[0]?.decision;
    const expectQty = !d ? -1 : d.decision === 'APPROVE' ? 350 : d.decision === 'PARTIAL' ? Math.floor((d.amount_cents ?? 0) / 100) : 250;
    const words = !d ? 'no decision' : d.decision === 'APPROVE' ? 'approved $350' : d.decision === 'PARTIAL' ? `smaller top-up ${usd(d.amount_cents)}` : 'denied';
    check(5, 'Your decision is enforced exactly', qa?.bought_quantity === expectQty && qa?.amount_cents <= Math.max(expectQty * 100, 25000),
      `${words} → QA bought ${qa?.bought_quantity} of 350 minutes for ${usd(qa?.amount_cents)}`);

    // 6. Wrong tool.
    runner('asks the Design agent to buy a security scan');
    const wrong = await crew.probe('design-agent', 'buy', { sku_id: 'SEC-SCAN', quantity: '1' });
    check(6, 'Design can’t buy a security scan (wrong tool)', wrong.status !== 'OK' && wrong.code === 'INSUFFICIENT_SCOPE', `${wrong.status} ${wrong.code}`);

    // 7. Can't hand out more than what's left.
    const left = 100000 - Number(s.spent_cents ?? 0);
    runner(`asks the lead to give a new helper ${usd(left + 10000)} (only ${usd(left)} left)`);
    const over = await crew.probe('lead-agent', 'over_provision', { cents: String(left + 10000) });
    check(7, 'The lead can’t hand out more than what’s left', over.status !== 'OK' && over.code === 'BUDGET_EXCEEDED', `${usd(left)} left → ${over.code}`);

    // 8 + 9. Revoke Design; Security keeps working.
    runner('the lead revokes the Design agent');
    const revoked = await crew.revoke(des?.grant_id, 'Design work is done; remove its access');
    const after = await crew.probe('design-agent', 'buy', { sku_id: 'DESIGN-PACK', quantity: '1' });
    check(8, 'Revoked Design agent is locked out', revoked.ok && after.status !== 'OK' && after.code === 'INVALID_CALLER', `revoke ${revoked.ok ? 'OK' : revoked.code}; Design → ${after.code}`);
    runner('the Security agent buys a second scan');
    const more = await crew.probe('security-agent', 'buy', { sku_id: 'SEC-SCAN', quantity: '1' });
    const total = Number(s.spent_cents ?? 0) + Number((more.data as any)?.amount_cents ?? 0);
    check(9, 'Other specialists keep working; total stays within $1,000', more.status === 'OK' && total <= 100000, `Security bought another scan; total spent ${usd(total)} of $1,000`);
  } catch (error) {
    check(0, 'Crew run completed', false, `${(error as Error).message}\n${crew.stderr().slice(-5).join('\n')}`);
  } finally {
    await crew.stop();
  }
  const passed = checks.length >= 9 && checks.every((c) => c.pass);
  emit({ type: 'done', passed });
  return { trace, checks, decisions, passed };
}

/** Non-interactive decision for the CLI: --decision approve|partial|deny, --partial <dollars>. */
export function cliDecider(argv: string[]): (r: DecisionRequest) => Promise<Decision> {
  const kind = (argv.includes('--decision') ? argv[argv.indexOf('--decision') + 1] : 'partial')!.toUpperCase();
  const partial = Number(argv.includes('--partial') ? argv[argv.indexOf('--partial') + 1] : 300) * 100;
  return async () => (kind === 'APPROVE' ? { decision: 'APPROVE' } : kind === 'DENY' ? { decision: 'DENY' } : { decision: 'PARTIAL', amount_cents: partial });
}

async function main() {
  const argv = process.argv.slice(2);
  const stack = argv.includes('--hosted') ? hostedStack({ scenario: 'release-crew' }) : await isolatedStack({ scenario: 'release-crew' });
  console.log(`\nAgentPass: release crew (internal) · ${stack.mode} · root ${stack.rootGrantId}\n`);
  const { checks, passed } = await runCrew({ stack, decide: cliDecider(argv), print: (l) => console.log(`${new Date().toISOString().slice(11, 23)}  ${l}`) });
  await stack.stop();
  console.log('\nResults');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.step}. ${c.title.padEnd(68)} ${c.detail}`);
  console.log(passed ? `\n${checks.length}/${checks.length} checks passed\n` : `\n${checks.filter((c) => !c.pass).length} check(s) failed\n`);
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
