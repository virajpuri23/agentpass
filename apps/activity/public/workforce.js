// Renders the real workforce stream from /api/events: workflow events,
// agent trace lines, grants, outputs and checks. textContent only.
const $ = (s) => document.querySelector(s);
const clock = (iso) => (iso ? iso.slice(11, 23) : '');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const CHECKS = [
  'Design agent changes actual UI files', 'Design agent cannot read .env', 'Security agent completes a real audit',
  'Security agent cannot modify source files', 'Hosting agent requests production deployment', 'AgentPass denies production authorization',
  'Hosting agent requests narrower preview authority', 'Hosting agent deploys the preview successfully', 'Analytics agent computes real aggregate metrics',
  'Analytics agent cannot retrieve raw user records', 'Temporary grants are revoked after task completion', 'Attempts to reuse revoked grants fail',
];
const KIND = {
  subagent_created: ['info', 'spawned'], authority_delegated: ['ok', 'delegated'], external_contacted: ['info', 'external'],
  permission_denied: ['bad', 'denied'], narrower_requested: ['req', 'requested'], permission_granted: ['ok', 'granted'],
  deployment_completed: ['ok', 'deployed'], analytics_analyzed: ['ok', 'analyzed'], fix_applied: ['ok', 'fixed'],
  authority_revoked: ['rev', 'revoked'], note: ['info', 'note'],
};

let st;
function reset() {
  st = { count: 0, allowed: 0, denied: 0, negotiated: 0, revoked: 0, grants: new Map() };
  $('#timeline').replaceChildren(el('li', 'empty', 'Starting…'));
  $('#grants tbody').replaceChildren((() => { const tr = el('tr', 'empty'); const td = el('td', '', 'No grants yet.'); td.colSpan = 5; tr.append(td); return tr; })());
  for (const id of ['allowed', 'denied', 'negotiated', 'revoked']) $(`#n-${id}`).textContent = '0';
  for (const li of document.querySelectorAll('#team li')) { li.className = li.dataset.agent === 'security-agent' ? 'external' : ''; li.querySelector('.state').textContent = li.dataset.agent === 'lead-agent' ? 'idle' : 'not started'; }
  $('#hero-before').textContent = '—'; $('#hero-after').textContent = '—';
  $('#findings').replaceChildren(el('li', 'muted', '—')); $('#fix').textContent = '';
  $('#preview').replaceChildren('—'); $('#metrics').textContent = '—'; $('#suggestions').replaceChildren();
  $('#checks').replaceChildren(...CHECKS.map((t, i) => { const li = el('li'); li.append(el('span', 'm', '·'), el('span', '', `${i + 1}. ${t}`)); return li; }));
  $('#result').textContent = ''; $('#result').className = 'result';
}

function row(cls, at, who, whatNodes) {
  const list = $('#timeline');
  list.querySelector('.empty')?.remove();
  const li = el('li', cls);
  const what = el('span', 'what');
  what.append(...whatNodes);
  li.append(el('span', 't', clock(at)), el('span', 'who', who), what);
  list.append(li);
  li.scrollIntoView({ block: 'nearest' });
  st.count += 1; $('#count').textContent = `· ${st.count}`;
}

function setState(agent, text, cls) {
  const li = document.querySelector(`#team li[data-agent="${agent}"]`);
  if (!li) return;
  li.querySelector('.state').textContent = text;
  for (const a of document.querySelectorAll('#team li')) a.classList.remove('active');
  if (cls) li.classList.add(cls); else li.classList.add('active');
}

function upsertGrant(id, data) {
  st.grants.set(id, { ...(st.grants.get(id) || {}), ...data });
  const tbody = $('#grants tbody');
  tbody.querySelector('.empty')?.remove();
  let tr = tbody.querySelector(`tr[data-id="${id}"]`);
  if (!tr) { tr = el('tr'); tr.dataset.id = id; tbody.append(tr); }
  const g = st.grants.get(id);
  tr.className = g.revoked ? 'revoked' : '';
  tr.replaceChildren(
    (() => { const td = el('td'); td.append(el('code', '', id.slice(0, 14))); return td; })(),
    el('td', '', g.holder || ''),
    el('td', '', (g.actions || []).join(', ')),
    el('td', '', (g.resources || []).join(', ')),
    el('td', '', g.revoked ? 'revoked' : g.status || 'active'),
  );
}

function onWorkflowEvent(e) {
  const [cls, label] = KIND[e.kind] || ['info', e.kind];
  // Denials are already shown by the agent's own trace line (with the error code); only count them here.
  if (e.kind !== 'permission_denied') row('event', e.at, e.agent, [el('span', `tag ${cls}`, label), document.createTextNode(e.text)]);
  if (e.kind === 'subagent_created' || e.kind === 'external_contacted') setState(e.agent, 'own session · active');
  if (e.kind === 'authority_delegated') {
    const m = e.text.match(/Delegated to ([a-z-]+): (.+?) on (.+)$/);
    if (m) { upsertGrant(`${m[1]}`, { holder: m[1], actions: m[2].split(', '), resources: m[3].split(', '), status: 'active' }); st.allowed += 1; }
  }
  if (e.kind === 'permission_denied') st.denied += 1;
  if (e.kind === 'narrower_requested') { st.negotiated += 1; setState('hosting-agent', 'negotiating…'); }
  if (e.kind === 'permission_granted') { upsertGrant('hosting-preview', { holder: 'hosting-agent', actions: ['deploy.preview'], resources: ['preview'], status: 'active (15 min)' }); }
  if (e.kind === 'deployment_completed') setState('hosting-agent', 'preview live', 'done');
  if (e.kind === 'analytics_analyzed') setState('analytics-agent', 'done', 'done');
  if (e.kind === 'fix_applied') setState('lead-agent', 'applied security fix');
  if (e.kind === 'authority_revoked') {
    st.revoked += 1;
    const m = e.text.match(/Revoked ([a-z-]+)'s grant/);
    if (m) { upsertGrant(m[1] === 'hosting-preview' ? 'hosting-preview' : `${m[1]}-agent`, { revoked: true }); if (m[1] !== 'hosting-preview') setState(`${m[1]}-agent`, 'revoked', 'revoked'); }
  }
  $('#n-allowed').textContent = st.allowed; $('#n-denied').textContent = st.denied; $('#n-negotiated').textContent = st.negotiated; $('#n-revoked').textContent = st.revoked;
}

function onTrace(e) {
  if (e.kind === 'note') row('trace note', e.at, e.agent, [document.createTextNode(`» ${e.text}`)]);
  else if (e.kind === 'denied') row('trace', e.at, e.agent, [el('span', 'tag bad', e.code || 'denied'), document.createTextNode(e.text)]);
  else if (e.kind === 'result') { row('trace', e.at, e.agent, [el('span', 'tag ok', 'result'), document.createTextNode(e.text)]); setState(e.agent, 'done', 'done'); }
  else row('trace', e.at, e.agent, [document.createTextNode(e.text)]);
  if (e.kind !== 'denied' && e.kind !== 'result') setState(e.agent, 'working…');
}

function onOutputs(o) {
  $('#hero-before').textContent = o.before.hero;
  $('#hero-after').textContent = o.after.hero;
  const sec = o.security;
  if (sec && sec.findings) {
    $('#findings').replaceChildren(...sec.findings.map((f) => { const li = el('li'); li.append(el('span', `sev ${f.severity}`, f.severity), document.createTextNode(`${f.rule} — ${f.file}:${f.line}`)); return li; }));
    $('#fix').textContent = o.fix_applied ? 'Lead applied the fix: escapeHtml(name) in src/lib/newsletter.ts' : 'Fix not applied';
    $('#fix').className = o.fix_applied ? 'ok-text' : 'muted';
  }
  const h = o.hosting;
  if (h && h.deployment) {
    const a = el('a', '', h.deployment.url); a.href = h.deployment.url; a.target = '_blank'; a.rel = 'noopener';
    $('#preview').replaceChildren(a, el('div', 'prov', `${h.deployment.provider}: a real local build, not production. Production was refused (${h.production_attempt.code}).`));
  } else if (h) { $('#preview').textContent = `No deployment: ${h.failure?.reason || h.negotiation?.status || 'unknown'}`; }
  const an = o.analytics;
  if (an && an.summary) {
    $('#metrics').textContent = `${an.summary.page_views.toLocaleString()} page views · ${an.summary.signups} signups · ${(an.summary.conversion_rate * 100).toFixed(2)}% conversion · ${an.summary.period.days} days`;
    $('#metrics').className = '';
    $('#suggestions').replaceChildren(...(an.suggestions || []).map((s) => el('li', '', s)));
  }
}

function onEvent(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    const b = $('#authority');
    b.textContent = `authority: ${ev.authority}${ev.missing?.length ? ` · missing: ${ev.missing.join(', ')}` : ''}`;
    b.className = `badge ${ev.authority === 'MOCK' ? 'mock' : 'real'}`;
    b.title = ev.authority === 'MOCK' ? 'Labeled mock until Developer A\'s generic-action contract is wired in' : 'Real AgentPass authority';
    upsertGrant('grant-root-lead', { holder: 'lead-agent', actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'], resources: ['src/**', 'package.json', 'preview', 'landing-page'], status: 'root (owner-issued)' });
    setState('lead-agent', 'task received');
  } else if (ev.type === 'event') onWorkflowEvent(ev.event);
  else if (ev.type === 'trace') onTrace(ev);
  else if (ev.type === 'outputs') onOutputs(ev.outputs);
  else if (ev.type === 'check') {
    const li = $('#checks').children[ev.check.n - 1];
    if (li) { li.className = ev.check.pass ? 'pass' : 'fail'; li.querySelector('.m').textContent = ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
  } else if (ev.type === 'done') {
    const n = $('#checks').querySelectorAll('.pass').length;
    $('#result').className = `result ${ev.passed ? 'pass' : 'fail'}`;
    $('#result').textContent = `${n} of ${CHECKS.length} checks passed`;
    for (const a of document.querySelectorAll('#team li')) a.classList.remove('active');
    refresh();
  }
}

async function refresh() {
  const s = await fetch('/api/status').then((r) => r.json());
  $('#run').disabled = s.running;
}

document.addEventListener('DOMContentLoaded', () => {
  reset();
  $('#run').addEventListener('click', async () => {
    $('#run').disabled = true;
    const r = await fetch('/api/workforce/run', { method: 'POST' });
    if (!r.ok) { alert((await r.json()).reason); refresh(); }
  });
  const source = new EventSource('/api/events');
  source.addEventListener('reset', () => reset());
  source.onmessage = (m) => onEvent(JSON.parse(m.data));
  refresh();
});
