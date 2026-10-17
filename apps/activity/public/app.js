// Renders the real DemoEvent stream from /api/events. All text goes through
// textContent; nothing from the stream is interpreted as HTML.
const $ = (sel) => document.querySelector(sel);
const usd = (c) => (typeof c === 'number' ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—');
const clock = (iso) => (iso ? iso.slice(11, 23) : '');

let state;
function reset(label) {
  state = { root: null, rootBudget: null, rootSpent: 0, childGrant: null, childBudget: null, childSpent: 0, revoked: new Set(), count: 0, recorded: false };
  $('#events').replaceChildren(el('li', 'empty', label ? `Starting: ${label}…` : 'Start a run or replay a recording.'));
  $('#checks').replaceChildren();
  $('#result').textContent = '';
  $('#result').className = 'result';
  $('#count').textContent = '';
  $('#private').className = 'private';
  $('#private-note').textContent = 'Waiting for a margin read attempt…';
  for (const n of document.querySelectorAll('.node .pid')) n.textContent = 'not running';
  $('#grant-buyer').textContent = '';
  $('#grant-child').textContent = '';
  $('#grant-child').classList.remove('revoked');
  renderBudgets();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pulse(agent) {
  for (const id of [agent, 'agentpass']) {
    const node = document.querySelector(`.node[data-agent="${id}"]`);
    if (!node) continue;
    node.classList.add('active');
    clearTimeout(node._t);
    node._t = setTimeout(() => node.classList.remove('active'), 900);
  }
}

function pillFor(status) {
  if (status === 'OK') return el('span', 'pill ok', 'OK');
  if (status === 'AUTHORITY_REQUIRED') return el('span', 'pill req', 'AUTHORITY_REQUIRED');
  return el('span', 'pill bad', status);
}

function describe(e) {
  const a = e.args || {};
  const d = e.data || {};
  let what = e.tool;
  if (e.tool === 'execute_action') what = `${String(a.action).replace('supplier.', '')}${a.quantity ? ` ×${a.quantity}` : ''}`;
  if (e.tool === 'request_authority') what = `request authority ${usd(a.requested_scope?.total_budget_cents)}`;
  if (e.tool === 'respond_authority_request') what = `${String(a.decision).toLowerCase()} ${usd(a.offered_scope?.total_budget_cents)}`;
  if (e.tool === 'delegate_authority') what = `delegate ${(a.scope?.actions || []).map((x) => x.replace('supplier.', '')).join(', ')} → ${a.recipient_principal_id}`;
  if (e.tool === 'accept_authority_offer') what = 'accept counteroffer';
  if (e.tool === 'revoke_authority') what = 'revoke grant';
  let detail = '';
  if (e.status === 'OK') {
    if (d.total_cents) detail = `quote ${usd(d.total_cents)}`;
    else if (d.amount_cents) detail = `receipt ${usd(d.amount_cents)}`;
  } else {
    detail = [e.code, d.next_action ? `next: ${d.next_action}` : ''].filter(Boolean).join(' · ');
  }
  return { what, detail };
}

function track(e) {
  const a = e.args || {};
  const d = e.data || {};
  if (e.status !== 'OK') {
    if (e.code === 'SELLER_POLICY_DENIED' && a.action === 'supplier.margin.read') {
      $('#private').className = 'private blocked';
      $('#private-note').textContent = 'Margin read attempted → supplier policy DENIED. No cost or margin value was returned.';
    }
    return;
  }
  if (e.tool === 'get_my_grants' && e.agent === 'buyer-agent' && Array.isArray(d.grants)) {
    const root = d.grants.find((g) => !g.parent_grant_id && (!state.root || g.id === state.root)) || d.grants.find((g) => !g.parent_grant_id);
    if (root && state.rootBudget === null) { state.root = root.id; state.rootBudget = root.scope.total_budget_cents; }
  }
  if (e.tool === 'delegate_authority' && e.agent === 'buyer-agent') {
    state.root = state.root || a.parent_grant_id;
    $('#grant-child').textContent = `quote-only · ${usd(0)}`;
    $('#grant-buyer').textContent = `${state.root} · ${usd(state.rootBudget)}`;
  }
  if (e.tool === 'accept_authority_offer') {
    state.childGrant = d.id; state.childBudget = d.scope?.total_budget_cents ?? null;
    $('#grant-child').textContent = `purchase · ${usd(state.childBudget)}`;
  }
  if (e.tool === 'execute_action' && a.action === 'supplier.purchase.execute' && d.amount_cents) {
    state.rootSpent += d.amount_cents;
    if (a.grant_id === state.childGrant) state.childSpent += d.amount_cents;
  }
  if (e.tool === 'revoke_authority') {
    state.revoked.add(a.grant_id);
    if (a.grant_id === state.childGrant) { $('#grant-child').textContent = `purchase · ${usd(state.childBudget)} · revoked`; $('#grant-child').classList.add('revoked'); }
  }
  renderBudgets();
}

function renderBudget(id, title, budget, spent, revoked, extra) {
  const box = $(id);
  box.classList.toggle('revoked', !!revoked);
  box.querySelector('.label span').textContent = title;
  box.querySelector('.amt').textContent = budget === null ? '—' : `${usd(spent)} of ${usd(budget)}`;
  box.querySelector('.bar i').style.width = budget ? `${Math.min(100, (spent / budget) * 100)}%` : '0';
  box.querySelector('.note').textContent = budget === null ? '' : `${revoked ? 'revoked · ' : ''}${usd(budget - spent)} left${extra ? ` · ${extra}` : ''}`;
}

function renderBudgets() {
  if (!state) return;
  renderBudget('#budget-root', `Root grant${state.root ? ` (${state.root})` : ''}`, state.rootBudget, state.rootSpent, false, 'counts every descendant purchase');
  renderBudget('#budget-child', 'Child purchase grant', state.childBudget, state.childSpent, state.revoked.has(state.childGrant), 'counteroffered by the buyer');
}

function addRow(cls, time, who, whatNode, ms) {
  const list = $('#events');
  list.querySelector('.empty')?.remove();
  const li = el('li', cls);
  li.append(el('span', 't', clock(time)), el('span', 'who', who), whatNode, el('span', 'ms', ms ?? ''));
  list.append(li);
  li.scrollIntoView({ block: 'nearest' });
  state.count += 1;
  $('#count').textContent = `· ${state.count} events`;
}

function onEvent(env) {
  const ev = env.event;
  if (env.recorded) state.recorded = true;
  if (ev.type === 'meta') {
    const src = $('#source');
    src.className = `source ${env.recorded ? 'recorded' : 'live'}`;
    src.textContent = env.recorded ? `Recorded · ${ev.mcp.replace('recorded: ', '')}` : `Live · ${ev.mode}${ev.mode === 'hosted' ? ' (Manufact)' : ''} · decisions: ${ev.decider}`;
    $('#mcp-label').textContent = ev.mcp.startsWith('recorded') ? 'MCP authority gateway' : `MCP · ${ev.mcp}`;
    if (ev.root) state.root = ev.root;
    return;
  }
  if (ev.type === 'process') {
    const node = document.querySelector(`.node[data-agent="${ev.agent}"] .pid`);
    if (node) node.textContent = ev.kind === 'started' ? `own process · pid ${ev.pid}` : 'exited';
    addRow('process', ev.at, 'platform', el('span', 'what', `${ev.kind} ${ev.agent} (pid ${ev.pid})`));
    return;
  }
  if (ev.type === 'runner') { addRow('runner', ev.at, 'runner', el('span', 'what', ev.text)); return; }
  if (ev.type === 'check') {
    const li = el('li', ev.check.pass ? 'pass' : 'fail');
    const body = el('div');
    body.append(el('span', '', `${ev.check.step}. ${ev.check.title}`), el('small', '', ev.check.detail));
    li.append(el('span', 'mark', ev.check.pass ? '✓' : '✗'), body);
    $('#checks').append(li);
    return;
  }
  if (ev.type === 'done') {
    const n = $('#checks').children.length;
    const passed = $('#checks').querySelectorAll('.pass').length;
    $('#result').className = `result ${ev.passed ? 'pass' : 'fail'}`;
    $('#result').textContent = `${passed}/${n} checks passed${state.recorded ? ' (recorded run)' : ''}`;
    refreshStatus();
    return;
  }
  if (ev.type === 'trace') {
    const e = ev.event;
    pulse(e.agent);
    if (e.kind === 'note') {
      const what = el('span', 'what', `» ${e.text}`);
      if (e.decider) what.append(el('span', 'tag', e.decider));
      addRow('note', e.at, e.agent, what);
      return;
    }
    if (e.tool === 'execute_action' && e.status === 'OK') pulse('supplier');
    const { what, detail } = describe(e);
    const node = el('span', 'what');
    node.append(el('code', '', what), pillFor(e.status));
    if (detail) node.append(el('span', 'tag', detail));
    addRow('call', e.at, e.agent, node, `${e.ms}ms`);
    track(e);
  }
}

async function refreshStatus() {
  const s = await fetch('/api/status').then((r) => r.json());
  for (const b of document.querySelectorAll('button')) b.disabled = s.running;
  $('#run-hosted').disabled = s.running || !s.hostedConfigured;
  $('#run-hosted').title = s.hostedConfigured ? `Agents call the deployed Manufact MCP server (root ${s.hostedRoot}). Makes a real simulated $850 purchase.` : 'Set HOSTED_* in .env to enable';
  const sel = $('#recording');
  const current = sel.value;
  sel.replaceChildren(...s.recordings.map((f) => { const o = el('option', '', f.replace('.json', '')); o.value = f; return o; }));
  if (current) sel.value = current;
  $('#replay').disabled = s.running || !s.recordings.length;
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) alert((await r.json()).reason);
  refreshStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  reset();
  for (const b of document.querySelectorAll('button[data-run]')) {
    b.addEventListener('click', () => {
      if (b.dataset.run === 'hosted' && !confirm('Run on the hosted Manufact deployment? This makes a real simulated $850 purchase against the configured root grant.')) return;
      post('/api/run', { mode: b.dataset.run });
    });
  }
  $('#replay').addEventListener('click', () => post('/api/replay', { file: $('#recording').value }));
  const source = new EventSource('/api/events');
  source.addEventListener('reset', (m) => { const d = JSON.parse(m.data); reset(d.label === 'current' ? '' : d.label); });
  source.onmessage = (m) => onEvent(JSON.parse(m.data));
  refreshStatus();
});
