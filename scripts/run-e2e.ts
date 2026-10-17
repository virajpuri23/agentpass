/**
 * npm run demo:run [-- --services | --hosted] [-- --via-http] [-- --trace-out trace.json]
 *
 * Runs the 9-step judge demo (docs/06-DEVELOPER-B.md B5) with real HTTP
 * services, real MCP calls and two real agent processes. Prints a compact
 * timestamped trace and an assertion summary; exits 1 if any step fails.
 * Everything printed comes from actual calls; nothing is scripted output.
 */
import { writeFileSync } from 'node:fs';
import { launchAgents } from '../apps/agent-kit/src/launcher.js';
import type { TraceEvent } from '../apps/agent-kit/src/transport.js';
import { hostedStack, isolatedStack, servicesStack, viaHttpMcp, type DemoStack } from './demo-stack.js';

export type Check = { step: number; title: string; pass: boolean; detail: string };

/** Structured stream for live views (apps/activity). Same facts as the printed trace. */
export type DemoEvent =
  | { type: 'meta'; mode: DemoStack['mode']; mcp: string; root: string; decider: 'deterministic' | 'llm' }
  | { type: 'process'; at: string; agent: string; pid: number; kind: 'started' | 'exited' }
  | { type: 'trace'; event: TraceEvent }
  | { type: 'runner'; at: string; text: string }
  | { type: 'check'; check: Check }
  | { type: 'done'; passed: boolean };

const args = process.argv.slice(2);
const useServices = args.includes('--services');
const useHosted = args.includes('--hosted');
const viaHttp = args.includes('--via-http');
const traceOut = args.includes('--trace-out') ? args[args.indexOf('--trace-out') + 1] : undefined;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const usd = (cents: unknown) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '?');

export async function runDemo(opts: { stack: DemoStack; print?: (line: string) => void; onEvent?: (e: DemoEvent) => void }) {
  const print = opts.print ?? (() => {});
  const emit = opts.onEvent ?? (() => {});
  const runner = (text: string) => { emit({ type: 'runner', at: new Date().toISOString(), text }); print(c(90, `${clock()}  ${'runner'.padEnd(15)} ${text}`)); };
  emit({ type: 'meta', mode: opts.stack.mode, mcp: 'mcpUrl' in opts.stack.connection ? opts.stack.connection.mcpUrl : 'stdio', root: opts.stack.rootGrantId, decider: 'deterministic' });
  const trace: TraceEvent[] = [];
  const checks: Check[] = [];
  const check = (step: number, title: string, pass: boolean, detail: string) => {
    const x = { step, title, pass, detail };
    checks.push(x);
    emit({ type: 'check', check: x });
  };

  const agents = await launchAgents({
    connection: opts.stack.connection,
    keys: { 'buyer-agent': opts.stack.keys.buyer, 'sourcing-agent': opts.stack.keys.sourcing },
    rootGrantId: opts.stack.rootGrantId,
    onTrace: (e) => { trace.push(e); emit({ type: 'trace', event: e }); print(formatEvent(e)); },
    onProcess: (p) => {
      emit({ type: 'process', at: new Date().toISOString(), agent: p.agent, pid: p.pid, kind: p.kind });
      print(c(90, `${clock()}  ${'platform'.padEnd(15)} ${p.kind === 'started' ? 'started' : 'exited'} ${p.agent} (pid ${p.pid})`));
    },
  });

  try {
    // Steps 1–6: the agents run the task on their own.
    const result = await agents.run({ supplier_id: 'supplier-co', sku_id: 'PACK-500', quantity: 500, requested_budget_cents: 120000 });
    const s = result.summary as Record<string, any>;
    const calls = trace.filter((e): e is Extract<TraceEvent, { kind: 'call' }> => e.kind === 'call');
    const find = (agent: string, tool: string, pred: (c: (typeof calls)[number]) => boolean = () => true) =>
      calls.find((c) => c.agent === agent && c.tool === tool && pred(c));

    // Step 1 probe: the child cannot see the root grant.
    runner("asks sourcing-agent to list its own grants");
    const childGrants = await agents.probe('my_grants');
    const buyerGrants = find('buyer-agent', 'get_my_grants', (x) => x.status === 'OK');
    const root = opts.stack.rootGrantId;
    const buyerSeesRoot = JSON.stringify(buyerGrants?.data ?? '').includes(root);
    const childIds = ((childGrants.data as any)?.grants ?? []).map((g: any) => g.id) as string[];
    check(1, 'Root grant visible only to buyer', buyerSeesRoot && childGrants.status === 'OK' && !childIds.includes(root),
      `buyer holds ${root}; child holds ${childIds.length} grant(s), none of them the root`);

    const delegate = find('buyer-agent', 'delegate_authority', (x) => x.status === 'OK');
    const delegated = delegate?.data as any;
    check(2, 'Buyer delegates quote-only grant to sourcing child', !!delegated
      && JSON.stringify(delegated.scope?.actions) === '["supplier.quote.request"]' && delegated.scope?.total_budget_cents === 0
      && delegated.subject_principal_id === 'sourcing-agent', `grant ${short(delegated?.id)}: quote.request, $0 budget`);

    check(3, 'Supplier returns trusted $850 quote for 500 units', s.quote?.total_cents === 85000 && s.quote?.quantity === 500,
      `quote ${short(s.quote?.quote_id)}: ${s.quote?.quantity} x ${usd(s.quote?.unit_price_cents)} = ${usd(s.quote?.total_cents)}`);

    const required = find('sourcing-agent', 'execute_action', (x) => x.status === 'AUTHORITY_REQUIRED');
    const req = required?.data as any;
    check(4, 'Purchase on quote-only grant -> AUTHORITY_REQUIRED + recovery hint', req?.next_action === 'request_authority' && !!req?.required_scope,
      `${req?.code} -> next_action=${req?.next_action}`);

    const asked = find('sourcing-agent', 'request_authority', (x) => x.status === 'OK');
    const responded = find('buyer-agent', 'respond_authority_request', (x) => x.status === 'OK');
    const accepted = find('sourcing-agent', 'accept_authority_offer', (x) => x.status === 'OK');
    const askCents = (asked?.args.requested_scope as any)?.total_budget_cents;
    const offerCents = (responded?.args.offered_scope as any)?.total_budget_cents;
    check(5, 'Child asks $1,200; parent counteroffers $900; child accepts', askCents === 120000 && offerCents === 90000
      && (accepted?.data as any)?.subject_principal_id === 'sourcing-agent' && (accepted?.data as any)?.scope?.total_budget_cents === 90000,
    `asked ${usd(askCents)} -> offered ${usd(offerCents)} -> grant ${short((accepted?.data as any)?.id)}`);

    check(6, 'Purchase completes via AgentPass gateway + supplier', result.ok && s.receipt?.amount_cents === 85000
      && s.receipt?.outcome === 'COMPLETED' && s.receipt?.simulated === true,
    `receipt ${short(s.receipt?.receipt_id)}, order ${short(s.receipt?.order_id)}, ${usd(s.receipt?.amount_cents)} (simulated)`);

    // Step 7: margin read.
    runner("asks sourcing-agent to try reading supplier margins");
    const margin = await agents.probe('margin_read', { grant_id: s.purchase_grant_id, quote_id: s.quote?.quote_id });
    const leak = /internal_unit_cost|margin_cents|"cost/i.test(JSON.stringify(trace)) || /"internal|cost_cents/.test(JSON.stringify(margin));
    check(7, 'Margin read denied; no private cost data anywhere', margin.code === 'SELLER_POLICY_DENIED' && !leak, `${margin.status} ${margin.code ?? ''}; trace scanned for private fields: ${leak ? 'LEAK' : 'clean'}`);

    // Step 8: overspend / widening / self-approval / forged identity.
    runner("asks sourcing-agent to overspend, widen scope, self-approve, forge identity");
    const overspend = await agents.probe('overspend', { quote_grant_id: s.quote_only_grant_id, purchase_grant_id: s.purchase_grant_id });
    const widen = await agents.probe('widen_scope', { grant_id: s.purchase_grant_id });
    const selfApprove = await agents.probe('self_approve', { request_id: s.request_id });
    const forged = await agents.probe('forged_identity', { grant_id: s.quote_only_grant_id });
    // Each must fail for the right reason, not just fail.
    const denied = overspend.code === 'BUDGET_EXCEEDED' && widen.code === 'OUTSIDE_PARENT_SCOPE'
      && selfApprove.code === 'INVALID_CALLER' && forged.code === 'INVALID_REQUEST';
    check(8, 'Overspend, wider grant, self-approval, forged identity all denied', denied,
      `overspend ${overspend.code}; widen ${widen.code}; self-approve ${selfApprove.code}; forged ${forged.code}`);

    // Step 9: revoke, then retry.
    runner("owner instructs buyer-agent to revoke the child's purchase grant");
    const revoked = await agents.revoke(s.purchase_grant_id, 'Demo: owner revokes delegated authority');
    const after = await agents.probe('purchase_again', { grant_id: s.purchase_grant_id, quote_id: s.quote?.quote_id });
    check(9, 'After revocation the child is blocked', revoked.ok && after.code === 'GRANT_REVOKED', `revoke ${revoked.ok ? 'OK' : revoked.code}; retry -> ${after.status} ${after.code}`);
  } catch (error) {
    check(0, 'Demo run completed', false, (error as Error).message + '\n' + agents.stderr().slice(-5).join('\n'));
  } finally {
    await agents.stop();
  }
  const passed = checks.length >= 9 && checks.every((x) => x.pass);
  emit({ type: 'done', passed });
  return { trace, checks, passed };
}

function clock(at?: string) { return (at ?? new Date().toISOString()).slice(11, 23); }
function short(id: unknown) { return typeof id === 'string' ? (id.length > 14 ? `${id.slice(0, 13)}…` : id) : '?'; }

function formatEvent(e: TraceEvent): string {
  const who = e.agent.padEnd(15);
  if (e.kind === 'note') return `${clock(e.at)}  ${who} ${c(36, '» ' + e.text)}${e.decider ? c(90, ` [${e.decider}]`) : ''}`;
  const a = e.args as any;
  let what = e.tool;
  if (e.tool === 'execute_action') what += `(${String(a.action).replace('supplier.', '')}${a.quantity ? ` x${a.quantity}` : ''})`;
  if (e.tool === 'request_authority') what += `(${usd(a.requested_scope?.total_budget_cents)})`;
  if (e.tool === 'respond_authority_request') what += `(${a.decision} ${usd(a.offered_scope?.total_budget_cents)})`;
  if (e.tool === 'delegate_authority') what += `(${a.scope?.actions?.join(',')} -> ${a.recipient_principal_id})`;
  const d = e.data as any;
  const extra = e.status === 'OK'
    ? (d?.total_cents ? ` ${usd(d.total_cents)}` : d?.amount_cents ? ` receipt ${usd(d.amount_cents)}` : '')
    : ` ${e.code ?? ''}${d?.next_action ? ` next=${d.next_action}` : ''}`;
  const status = e.status === 'OK' ? c(32, 'OK') : e.status === 'AUTHORITY_REQUIRED' ? c(33, e.status) : c(31, e.status);
  return `${clock(e.at)}  ${who} ${what} -> ${status}${extra} ${c(90, `${e.ms}ms`)}`;
}

async function main() {
  let stack = useHosted ? hostedStack() : useServices ? await servicesStack() : await isolatedStack();
  if (viaHttp && !useHosted) stack = await viaHttpMcp(stack);
  const out = (s: string) => console.log(s);
  out(c(1, '\nAgentPass demo: cross-company agent authority'));
  const backends = { isolated: 'fresh local services (temp DBs)', services: 'running services from .env', hosted: 'hosted deployment' }[stack.mode];
  const mcp = 'mcpUrl' in stack.connection ? `HTTP ${stack.connection.mcpUrl}` : 'stdio';
  out(c(90, `backends: ${backends} | authority ${stack.authorityUrl} | supplier ${stack.supplierUrl} | root ${stack.rootGrantId}`));
  out(c(90, `agents: separate OS processes, own keys, real MCP (${mcp}) | decisions: deterministic (no LLM) | purchases: simulated\n`));

  const { trace, checks, passed } = await runDemo({ stack, print: out });
  await stack.stop();

  out(c(1, '\nResults'));
  for (const x of checks.sort((a, b) => a.step - b.step)) {
    out(`  ${x.pass ? c(32, 'PASS') : c(31, 'FAIL')}  ${String(x.step).padStart(1)}. ${x.title.padEnd(68)} ${c(90, x.detail)}`);
  }
  out(passed ? c(32, `\n${checks.length}/${checks.length} checks passed\n`) : c(31, `\n${checks.filter((x) => !x.pass).length} check(s) failed\n`));
  if (traceOut) writeFileSync(traceOut, JSON.stringify({ trace, checks, passed }, null, 2));
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
