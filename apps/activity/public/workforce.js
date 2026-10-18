// Plain-English view of the real workforce stream from /api/events. Each
// workflow event becomes one short story line; agent trace lines go to the
// technical log only. Lines are paced (Speed) so a run can be narrated;
// Instant shows the raw stream. textContent only.
const $ = (s) => document.querySelector(s);
const clock = (iso) => (iso ? iso.slice(11, 23) : '');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const CHECKS = [
  'Design edited the page', 'Design blocked from the secrets file', 'Security reviewer did a real review',
  'Reviewer blocked from editing', 'Publishing tried the live site', 'AgentPass blocked the live site',
  'Publishing asked for a smaller pass', 'Test copy published', 'Numbers computed real totals',
  'Numbers blocked from people’s records', 'All passes taken back at the end', 'Old passes no longer work',
];
const NAME = { 'lead-agent': 'The manager', 'design-agent': 'Design', 'security-agent': 'The security reviewer', 'hosting-agent': 'Publishing', 'analytics-agent': 'Numbers' };
const name = (a) => NAME[a] || a;
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const where = (list) => {
  const w = new Set(list.map((r) => (/^src\/components/.test(r) ? 'the page layout files' : /^src\/styles/.test(r) ? 'the page styles' : /^src\//.test(r) ? 'the page files' : r === 'package.json' ? 'project settings' : r === 'preview' ? 'the test copy' : r === 'landing-page' ? 'the visitor data' : r)));
  return [...w].join(', ');
};
const may = (actions) => {
  const a = new Set(actions);
  const parts = [];
  if (a.has('repo.read')) parts.push('read');
  if (a.has('repo.write')) parts.push('edit');
  if (a.has('deploy.preview')) parts.push('publish a test copy');
  if (a.has('analytics.aggregate')) parts.push('see visitor totals');
  return parts.join(' and ') || actions.join(', ');
};

/** One story line per workflow event: [icon class, text, small detail]. */
function line(e) {
  const who = name(e.agent);
  let m;
  switch (e.kind) {
    case 'note': return ['info', 'The manager gets the job and one master pass from the owner.', 'Improve the page, review security, publish a test copy, report the numbers.'];
    case 'subagent_created': return ['info', `${who} joins with its own key.`, 'AgentPass only ever sees a fingerprint of the key.'];
    case 'external_contacted': return ['info', 'A security reviewer from an outside company joins.', 'Look only. It cannot change anything.'];
    case 'authority_delegated': {
      m = e.text.match(/^Delegated to ([a-z-]+): (.+?) on (.+)$/);
      if (!m) return ['good', 'The manager hands out a smaller pass.'];
      if (m[1] === 'security-agent') return ['good', 'The manager gives the security reviewer a look-only pass.', `It may read ${where(m[3].split(', '))}. Nothing else.`];
      return ['good', `The manager gives ${name(m[1])} a smaller pass.`, `It may ${may(m[2].split(', '))}, in ${where(m[3].split(', '))}. Nothing else.`];
    }
    case 'permission_denied': {
      if (e.code === 'GRANT_REVOKED' || e.code === 'INVALID_CALLER') return ['bad', `${who} tries its old pass. Blocked: it no longer works.`];
      if (/\.env/.test(e.text)) return ['bad', `${who} tries to open the secrets file. Blocked.`, 'No pass covers it, not even the manager’s.'];
      if (/deploy\.production/.test(e.text)) return ['bad', `${who} tries to publish to the live site. Blocked.`, 'Nobody in this job may. AgentPass says what it may ask for instead: the test copy.'];
      if (/analytics\.raw/.test(e.text)) return ['bad', `${who} asks for people’s individual records. Blocked.`, 'Those stay private.'];
      if (/repo\.write/.test(e.text)) return ['bad', `${who} tries to edit a file its pass doesn’t cover. Blocked.`];
      return ['bad', `AgentPass says no to ${lower(who)}.`, e.text];
    }
    case 'narrower_requested': return ['warn', `${who} asks for a smaller pass instead: the test copy only.`, 'It asks for exactly what AgentPass said it could ask for, with its reason.'];
    case 'permission_granted': return ['good', 'The manager agrees: test copy only, for 15 minutes.'];
    case 'deployment_completed': return ['good', 'The test copy is live. The real site was never touched.', (m = e.text.match(/at (\S+)/)) ? `On this computer at ${m[1]}.` : ''];
    case 'analytics_analyzed': return ['good', 'Numbers works out the visitor totals.', 'Totals only, never individual records.'];
    case 'fix_applied': return ['good', 'The manager fixes the bug the reviewer found.', 'The reviewer could only look; the manager holds the editing pass.'];
    case 'authority_revoked': return null; // folded into one growing line, see onWorkflowEvent
    default: return ['info', `${who}: ${e.kind}`];
  }
}

// ---- Playback queue (paced so a run can be narrated; Instant drains synchronously) ----
const SPEED = { slow: 2.2, normal: 1, instant: 0 };
const play = { speed: 'normal', queue: [], pumping: false, timer: null, catchUp: false };
const pace = () => (play.catchUp ? 0 : SPEED[play.speed]);
function delayFor(env) {
  const f = pace();
  if (!f) return 0;
  const t = env.event.type;
  const base = t === 'event' ? (env.event.event.kind === 'authority_revoked' ? 500 : 1800) : t === 'meta' ? 1200 : t === 'outputs' ? 800 : t === 'check' ? 120 : 0;
  return base * f;
}
function enqueue(env) {
  play.queue.push(env);
  if (!play.pumping) { play.pumping = true; tick(); }
}
function tick() {
  play.timer = null;
  while (play.queue.length) {
    const env = play.queue.shift();
    onEvent(env);
    const d = delayFor(env);
    if (d > 0) { play.timer = setTimeout(tick, d); return; }
  }
  play.pumping = false;
}
function setSpeed(speed) {
  play.speed = speed;
  if (speed === 'instant') { clearTimeout(play.timer); play.timer = null; if (play.pumping) tick(); }
}
function clearPlayback() {
  clearTimeout(play.timer);
  Object.assign(play, { queue: [], pumping: false, timer: null, catchUp: false });
}

// ---- Rendering ----
let st;
function reset() {
  st = { count: 0, revokedLine: null, revoked: [] };
  $('#story').replaceChildren(el('li', 'empty', 'Press “Run demo”.'));
  $('#timeline').replaceChildren(el('li', 'empty', 'Starting…'));
  $('#count').textContent = '';
  for (const li of document.querySelectorAll('#team li')) { li.className = li.dataset.agent === 'security-agent' ? 'external' : ''; li.querySelector('.state').textContent = li.dataset.agent === 'lead-agent' ? 'idle' : 'not started'; }
  for (const id of ['hero', 'security', 'preview', 'metrics']) $(`#${id}`).textContent = '—';
  $('#checks').replaceChildren(...CHECKS.map((t) => { const li = el('li'); li.append(el('span', 'm', '·'), el('span', '', t)); return li; }));
  $('#result').textContent = ''; $('#result').className = 'result';
}
function setState(agent, text, cls) {
  const li = document.querySelector(`#team li[data-agent="${agent}"]`);
  if (!li) return;
  li.className = `${agent === 'security-agent' ? 'external ' : ''}${cls}`;
  li.querySelector('.state').textContent = text;
}
function story(cls, text, detail) {
  const list = $('#story');
  list.querySelector('.empty')?.remove();
  for (const prev of list.querySelectorAll('li.now')) prev.classList.remove('now');
  const li = el('li', 'now');
  const t = el('span', 't', text);
  if (detail) t.append(el('small', '', detail));
  li.append(el('span', `i ${cls}`, cls === 'good' ? '✓' : cls === 'bad' ? '✕' : cls === 'warn' ? '!' : cls === 'rev' ? '↩' : '·'), t);
  list.append(li);
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return li;
}
function row(cls, at, who, whatNodes) {
  const list = $('#timeline');
  list.querySelector('.empty')?.remove();
  const li = el('li', cls);
  const what = el('span', 'what');
  what.append(...whatNodes);
  li.append(el('span', 't', clock(at)), el('span', 'who', who), what);
  list.append(li);
  st.count += 1; $('#count').textContent = `· ${st.count} lines`;
}

function onWorkflowEvent(e) {
  row('event', e.at, e.agent, [el('span', `tag ${e.kind === 'permission_denied' ? 'bad' : 'ok'}`, e.kind + (e.code ? ` ${e.code}` : '')), document.createTextNode(e.text)]);
  if (e.kind === 'authority_revoked') {
    const m = e.text.match(/Revoked ([a-z-]+)'s grant/);
    const who = m ? (m[1] === 'hosting-preview' ? 'Publishing’s test-copy pass' : `${name(`${m[1]}-agent`)}’s pass`) : 'a pass';
    st.revoked.push(who);
    if (!st.revokedLine) st.revokedLine = story('rev', 'Job done. The manager takes every pass back.', 'Taking back…');
    st.revokedLine.querySelector('small').textContent = `Taken back: ${st.revoked.join(', ')}.`;
    if (m && m[1] !== 'hosting-preview') setState(`${m[1]}-agent`, 'pass taken back', 'revoked');
    return;
  }
  const l = line(e);
  if (l) story(l[0], l[1], l[2]);
  if (e.kind === 'subagent_created' || e.kind === 'external_contacted') setState(e.agent, 'has a pass', 'active');
  if (e.kind === 'note') setState('lead-agent', 'holds the master pass', 'active');
  if (e.kind === 'deployment_completed' || e.kind === 'analytics_analyzed') setState(e.agent, 'done', 'done');
}
function onTrace(e) {
  if (e.kind === 'denied') row('trace', e.at, e.agent, [el('span', 'tag bad', e.code || 'denied'), document.createTextNode(e.text)]);
  else row('trace', e.at, e.agent, [document.createTextNode(e.text)]);
  if (e.kind === 'result' && (e.agent === 'design-agent' || e.agent === 'security-agent')) setState(e.agent, 'done', 'done');
}
function onOutputs(o) {
  // The outputs carry the whole Hero component before and after; show just the headline text.
  const h1 = (src) => { const m = String(src || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/); return (m ? m[1] : String(src || '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '—'; };
  const hero = $('#hero');
  hero.replaceChildren(el('span', 'before', h1(o.before.hero)), document.createTextNode(' → '), el('span', '', h1(o.after.hero)));
  const sec = o.security;
  if (sec && sec.findings) {
    const high = sec.findings.filter((f) => f.severity === 'high').length;
    $('#security').textContent = `${sec.findings.length} findings (${high} serious)${o.fix_applied ? ' · the manager fixed the serious one' : ''}`;
  }
  const h = o.hosting;
  if (h && h.deployment) {
    const a = el('a', '', h.deployment.url); a.href = h.deployment.url; a.target = '_blank'; a.rel = 'noopener';
    $('#preview').replaceChildren(a, document.createTextNode(' · on this computer, not a public site'));
  } else if (h) { $('#preview').textContent = 'Nothing published'; }
  const an = o.analytics;
  if (an && an.summary) $('#metrics').textContent = `${an.summary.page_views.toLocaleString()} visits · ${an.summary.signups} signups · ${(an.summary.conversion_rate * 100).toFixed(1)}% signed up`;
}

function onEvent(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    const realRun = ev.authority !== 'MOCK';
    const b = $('#authority');
    b.textContent = realRun ? 'real AgentPass' : 'practice mock';
    b.className = `badge ${realRun ? 'real' : 'mock'}`;
    b.title = realRun ? 'Every decision comes from the real AgentPass service' : 'A labeled stand-in, not the real service';
    story('info', `A clean start${realRun ? '' : ' on the practice mock'}: fresh project, new keys, no passes yet.`);
  } else if (ev.type === 'event') onWorkflowEvent(ev.event);
  else if (ev.type === 'trace') onTrace(ev);
  else if (ev.type === 'outputs') onOutputs(ev.outputs);
  else if (ev.type === 'check') {
    const li = $('#checks').children[ev.check.n - 1];
    if (li) { li.className = ev.check.pass ? 'pass' : 'fail'; li.querySelector('.m').textContent = ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
  } else if (ev.type === 'done') {
    const n = $('#checks').querySelectorAll('.pass').length;
    $('#result').className = `result ${ev.passed ? 'pass' : 'fail'}`;
    $('#result').textContent = ev.passed ? `Every rule held: ${n} of ${CHECKS.length} checks passed.` : `${n} of ${CHECKS.length} checks passed.`;
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
    if (!r.ok) { story('bad', 'Could not start.', (await r.json()).reason); refresh(); }
  });
  $('#speed').addEventListener('change', (e) => setSpeed(e.target.value));
  const source = new EventSource('/api/events');
  // The buffer replayed on (re)connect is a finished or in-flight run: render it instantly, pace only live events.
  source.addEventListener('reset', (m) => { clearPlayback(); reset(); play.catchUp = JSON.parse(m.data).label === 'current'; });
  source.onmessage = (m) => enqueue(JSON.parse(m.data));
  refresh();
});
