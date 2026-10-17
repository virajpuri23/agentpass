// Barebones story view of the real DemoEvent stream. Steps light up from
// actual tool calls; ✓/✗ come from the runner's checks. textContent only.
const $ = (s) => document.querySelector(s);
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const STEPS = [
  'Only the buyer can see the $1,000 budget',
  'Buyer gives the helper agent quote-only access',
  'Supplier quotes 500 units',
  'Buying is blocked; the helper learns exactly what it needs',
  'Helper asks for more; buyer makes a smaller offer; helper accepts',
  'Purchase goes through',
  'Peeking at the supplier’s margins is blocked',
  'Overspending and other tricks are blocked',
  'Buyer revokes access; the helper is locked out',
];

let st;
function reset() {
  st = { budget: null, spent: 0, root: null, max: 0 };
  $('#steps').replaceChildren(...STEPS.map((title) => {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot';
    const text = document.createElement('div');
    text.append(title, document.createElement('small'));
    li.append(dot, text);
    return li;
  }));
  $('#log').textContent = '';
  $('#budget').hidden = true;
}

const stepEl = (n) => $('#steps').children[n - 1];
function activate(n, detail) {
  const li = stepEl(n);
  // The story only moves forward; later probes reuse earlier tools (e.g. a second quote).
  if (!li || n < st.max) return;
  st.max = n;
  for (const other of $('#steps').children) other.classList.remove('active');
  li.classList.add('active');
  if (detail) li.querySelector('small').textContent = detail;
}
function finish(n, pass) {
  const li = stepEl(n);
  if (!li) return;
  li.classList.remove('active');
  li.classList.add(pass ? 'pass' : 'fail');
  li.querySelector('.dot').textContent = pass ? '✓' : '✗';
}

function log(line) {
  $('#log').textContent += line + '\n';
}

function onCall(e) {
  const a = e.args || {}, d = e.data || {};
  if (e.tool === 'get_my_grants' && e.agent === 'buyer-agent' && e.status === 'OK') {
    const root = (d.grants || []).find((g) => g.id === st.root) || (d.grants || []).find((g) => !g.parent_grant_id);
    if (root && st.budget === null) { st.budget = root.scope.total_budget_cents; showBudget(); }
    activate(1);
  }
  if (e.tool === 'delegate_authority' && e.agent === 'buyer-agent' && e.status === 'OK') activate(2, 'can ask for prices, can’t spend');
  if (e.tool === 'execute_action' && a.action === 'supplier.quote.request' && e.status === 'OK') activate(3, `${usd(d.total_cents)} for 500 units`);
  if (e.status === 'AUTHORITY_REQUIRED') activate(4, `missing: ${(d.required_scope?.actions || []).join(', ').replace('supplier.', '')}`);
  if (e.tool === 'request_authority' && e.status === 'OK') st.ask = a.requested_scope?.total_budget_cents;
  if (e.tool === 'respond_authority_request' && e.status === 'OK') st.offer = a.offered_scope?.total_budget_cents;
  if (e.tool === 'accept_authority_offer' && e.status === 'OK') activate(5, `asked ${usd(st.ask ?? 0)} → offered ${usd(st.offer ?? 0)} → accepted`);
  if (e.tool === 'execute_action' && a.action === 'supplier.purchase.execute' && e.status === 'OK' && d.amount_cents) {
    st.spent += d.amount_cents; showBudget();
    activate(6, `${usd(d.amount_cents)}, receipt issued`);
  }
  if (e.tool === 'execute_action' && a.action === 'supplier.purchase.execute' && e.status !== 'OK' && e.status !== 'AUTHORITY_REQUIRED' && st.max === 5) {
    activate(6, `refused: ${e.code}`);
  }
  if (a.action === 'supplier.margin.read') activate(7, e.status === 'OK' ? 'not blocked!' : 'supplier said no; nothing private returned');
  if (e.agent === 'sourcing-agent' && ['delegate_authority', 'respond_authority_request'].includes(e.tool)) activate(8, 'overspend, self-approval, wider access: all refused');
  if (e.code === 'GRANT_REVOKED') activate(9, 'every further attempt is refused');
}

function showBudget() {
  if (st.budget === null) return;
  $('#budget').hidden = false;
  $('#budget-amt').textContent = `${usd(st.spent)} of ${usd(st.budget)}`;
  $('#budget-bar').style.width = `${Math.min(100, (st.spent / st.budget) * 100)}%`;
}

function onEvent(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    st.root = ev.root || null;
    $('#status').textContent = env.recorded ? 'Replaying a recorded run' : `Running ${ev.mode === 'hosted' ? 'live on Manufact' : 'on this laptop'}…`;
  } else if (ev.type === 'trace') {
    const e = ev.event;
    if (e.kind === 'call') { onCall(e); log(`${e.at.slice(11, 19)}  ${e.agent.padEnd(15)} ${e.tool}${e.args?.action ? ` (${e.args.action})` : ''} → ${e.status}${e.code ? ` ${e.code}` : ''}`); }
    else log(`${e.at.slice(11, 19)}  ${e.agent.padEnd(15)} » ${e.text}`);
  } else if (ev.type === 'runner') {
    log(`${ev.at.slice(11, 19)}  runner          ${ev.text}`);
  } else if (ev.type === 'check') {
    finish(ev.check.step, ev.check.pass);
  } else if (ev.type === 'done') {
    const passed = $('#steps').querySelectorAll('.pass').length;
    $('#status').textContent = ev.passed ? `Done: all ${passed} steps behaved as expected.` : `Done: ${passed} of ${STEPS.length} steps passed. See the technical log.`;
    refresh();
  }
}

async function refresh() {
  const s = await fetch('/api/status').then((r) => r.json());
  $('#run').disabled = s.running;
  const hosted = $('#where-hosted');
  hosted.disabled = !s.hostedConfigured;
  if (hosted.disabled && hosted.checked) document.querySelector('input[value="local"]').checked = true;
}

document.addEventListener('DOMContentLoaded', () => {
  reset();
  $('#run').addEventListener('click', async () => {
    const mode = document.querySelector('input[name="where"]:checked').value;
    if (mode === 'hosted' && !confirm('Run live on Manufact? This makes a real simulated $850 purchase.')) return;
    $('#run').disabled = true;
    const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    if (!r.ok) { $('#status').textContent = (await r.json()).reason; refresh(); }
  });
  const source = new EventSource('/api/events');
  source.addEventListener('reset', () => reset());
  source.onmessage = (m) => onEvent(JSON.parse(m.data));
  refresh();
});
