// Animated view of the real workforce stream from /api/events (workflow
// events, agent trace lines, grants, outputs, checks). Every packet on the
// diagram is a real call made by a separate agent session. textContent /
// SVG text nodes only.
//
// Presenter pacing: every SSE envelope goes through a FIFO playback queue so
// a ~15 s run can be narrated. "Instant" drains the queue synchronously on
// arrival (no animation), which is the pre-queue behaviour. Nothing is
// dropped or reordered; checks and the final result are last in the stream,
// so they render only once everything before them has.
const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const clock = (iso) => (iso ? iso.slice(11, 23) : '');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const CHECKS = [
  'Design agent changes actual UI files', 'Design agent cannot read .env', 'Security agent completes a real audit',
  'Security agent cannot modify source files', 'Hosting agent requests production deployment', 'AgentPass denies production authorization',
  'Hosting agent requests narrower preview authority', 'Hosting agent deploys the preview successfully', 'Analytics agent computes real aggregate metrics',
  'Analytics agent cannot retrieve raw user records', 'Temporary grants are revoked after task completion', 'Attempts to reuse revoked grants fail',
];
const PHASES = [
  'The lead receives the task and the only root grant',
  'Design: its own identity, UI files only, .env refused',
  'External security audit, read-only; the lead applies the fix',
  'Hosting: production refused, preview negotiated, live URL',
  'Analytics: aggregates only, raw user rows refused',
  'Task done: grants revoked, old credentials dead',
];
const CHECK_PHASE = [2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6];
const KIND = {
  subagent_created: ['info', 'spawned'], authority_delegated: ['ok', 'delegated'], external_contacted: ['info', 'external'],
  permission_denied: ['bad', 'denied'], narrower_requested: ['req', 'requested'], permission_granted: ['ok', 'granted'],
  deployment_completed: ['ok', 'deployed'], analytics_analyzed: ['ok', 'analyzed'], fix_applied: ['ok', 'fixed'],
  authority_revoked: ['rev', 'revoked'], note: ['info', 'note'],
};
const WHO = {
  'lead-agent': 'the lead', 'design-agent': 'the Design agent', 'security-agent': 'the external Security agent',
  'hosting-agent': 'the Hosting agent', 'analytics-agent': 'the Analytics agent',
};
const NODE = { 'lead-agent': 'lead', 'design-agent': 'design', 'security-agent': 'security', 'hosting-agent': 'hosting', 'analytics-agent': 'analytics' };
const PHASE_OF_AGENT = { 'design-agent': 2, 'security-agent': 3, 'hosting-agent': 4, 'analytics-agent': 5 };

// Anchor points in the SVG's coordinate space.
const P = {
  owner: [200, 118], leadTop: [200, 150], leadBottom: [200, 236], lead: [296, 193], gate: [564, 235],
  design: [101, 355], hosting: [241, 355], analytics: [381, 355], security: [830, 417],
  designTop: [101, 300], hostingTop: [241, 300], analyticsTop: [381, 300],
  repo: [690, 78], env: [690, 126], preview: [690, 174], prod: [690, 222], agg: [690, 270], raw: [690, 318],
};

// ---- Story caption: one plain-English headline per workflow event kind. Derived from kind, agent and code only. ----
function headline(e) {
  const who = WHO[e.agent] || e.agent;
  switch (e.kind) {
    case 'note': return 'The lead receives the task. It holds the only root grant.';
    case 'subagent_created': return `${cap(who)} gets its own identity and credential; only a hash reaches AgentPass.`;
    case 'authority_delegated': { const m = e.text.match(/^Delegated to ([a-z-]+)/); return `The lead delegates a narrow slice of its own authority${m && WHO[m[1]] ? ` to ${WHO[m[1]]}` : ''}.`; }
    case 'external_contacted': return 'A separate company’s Security agent joins, authenticating with its own credential.';
    case 'permission_denied': return `AgentPass refused that call from ${who}${e.code ? ` (${e.code})` : ''}. Here’s why…`;
    case 'narrower_requested': return `${cap(who)} asks for less, with a reason.`;
    case 'permission_granted': return 'The lead counteroffers a narrower, shorter grant.';
    case 'deployment_completed': return 'The preview is live on the negotiated grant: a local build, not production.';
    case 'analytics_analyzed': return 'Analytics gets aggregates only. Raw user rows stay off-limits.';
    case 'fix_applied': return 'The lead applies the auditor’s fix itself. The auditor never had write access.';
    case 'authority_revoked': return 'Task done. The lead revokes the temporary grants; the old credentials stop working.';
    default: return `${cap(who)}: ${e.kind}`;
  }
}
function caption(no, title, detail) {
  if (no !== undefined) $('#step-no').textContent = no;
  if (title !== undefined) $('#story').textContent = title;
  $('#story-detail').textContent = detail || '';
}

// ---- Playback queue ----
const SPEED = { slow: 2.5, normal: 1, instant: 0 };
// catchUp: the buffer the server replays on (re)connect is a finished or in-flight run; it renders instantly, only live events are paced.
const play = { speed: 'normal', step: false, queue: [], pumping: false, paused: false, timer: null, startedAt: 0, catchUp: false };
const pace = () => (play.catchUp ? 0 : SPEED[play.speed]);
function delayFor(env) {
  const f = pace();
  if (!f) return 0;
  const t = env.event.type;
  const base = t === 'event' ? 900 : t === 'trace' ? 300 : t === 'outputs' ? 700 : t === 'check' ? 150 : t === 'meta' ? 400 : 0;
  return base * f;
}
function playState() {
  const n = play.queue.length;
  const s = $('#story-state');
  if (play.paused) { s.textContent = `paused before the next step · Next, → or Space · ${n} queued`; s.className = 'step-state paused'; }
  else if (n > 0) { s.textContent = `playing · ${n} queued`; s.className = 'step-state'; }
  else { s.textContent = ''; s.className = 'step-state'; }
  $('#next').disabled = !play.paused;
}
function enqueue(env) {
  if (!play.startedAt) play.startedAt = performance.now();
  play.queue.push(env);
  if (!play.pumping) { play.pumping = true; tick(); } else playState();
}
function tick() {
  play.timer = null;
  while (play.queue.length) {
    const env = play.queue[0];
    if (play.step && pace() && env.event.type === 'event') { play.paused = true; playState(); return; }
    play.queue.shift();
    onEvent(env);
    const d = delayFor(env);
    if (d > 0) { play.timer = setTimeout(tick, d); playState(); return; }
  }
  play.pumping = false;
  playState();
}
function next() {
  if (!play.paused) return;
  play.paused = false;
  const env = play.queue.shift();
  onEvent(env);
  const d = delayFor(env);
  if (d > 0) { play.timer = setTimeout(tick, d); playState(); } else tick();
}
function setSpeed(speed) {
  play.speed = speed;
  if (speed === 'instant') { clearTimeout(play.timer); play.timer = null; play.paused = false; if (play.pumping) tick(); }
}
function setStep(on) {
  play.step = on;
  $('#next').hidden = !on;
  if (!on && play.paused) next();
}
function clearPlayback() {
  clearTimeout(play.timer);
  Object.assign(play, { queue: [], pumping: false, paused: false, timer: null, startedAt: 0, catchUp: false });
  playState();
}

// ---- Diagram helpers ----
function setBadge(id, text, revoked) {
  const g = document.getElementById(id);
  const t = g.querySelector('text');
  t.textContent = text;
  g.querySelector('rect').setAttribute('width', text ? String(t.getComputedTextLength() + 16) : '0');
  g.classList.toggle('revoked', Boolean(revoked));
}
function node(name, cls, sub) {
  const n = document.getElementById(`n-${name}`);
  if (!n) return;
  if (cls !== undefined) { n.classList.remove('dim'); if (cls) n.classList.add(cls); }
  const s = document.getElementById(`s-${name}`);
  if (sub !== undefined && s) s.textContent = sub;
}
function pulse(id) {
  const n = document.getElementById(id);
  if (!n) return;
  n.classList.add('pulse');
  setTimeout(() => n.classList.remove('pulse'), 600 * (pace() || 1));
}
function hit(id) {
  const v = document.getElementById(id);
  if (!v) return;
  v.classList.remove('hit'); void v.getBBox(); v.classList.add('hit');
  setTimeout(() => v.classList.remove('hit'), 1200 * (pace() || 1));
}
/** Animates a labeled message along a polyline. kind: good | warn | bad. Fire-and-forget; skipped at Instant. */
function send(points, kind, label, opts = {}) {
  const f = pace();
  if (!f) return;
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute('class', `packet ${kind}`);
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('r', '9');
  const pill = document.createElementNS(SVG, 'g');
  pill.setAttribute('class', 'pill');
  const rect = document.createElementNS(SVG, 'rect');
  rect.setAttribute('rx', '11'); rect.setAttribute('height', '22');
  const text = document.createElementNS(SVG, 'text');
  text.setAttribute('x', '10'); text.setAttribute('y', '15');
  text.textContent = `${kind === 'good' ? '✓' : kind === 'bad' ? '✕' : '!'} ${label}`;
  pill.append(rect, text);
  g.append(dot, pill);
  $('#flows').append(g);
  rect.setAttribute('width', String(text.getComputedTextLength() + 20));
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segs.push({ x1, y1, x2, y2, len }); total += len;
  }
  const duration = Math.max(500, Math.min(1000, total * 1.6)) * f;
  const start = performance.now();
  const done = () => {
    if (opts.burstAt) {
      const b = document.createElementNS(SVG, 'text');
      b.setAttribute('class', 'burst'); b.setAttribute('x', String(opts.burstAt[0] - 9)); b.setAttribute('y', String(opts.burstAt[1] + 9));
      b.textContent = '✕';
      $('#flows').append(b);
      setTimeout(() => b.remove(), 900 * f);
    }
    setTimeout(() => { g.style.transition = 'opacity .35s'; g.style.opacity = '0'; setTimeout(() => g.remove(), 400); }, (opts.hold ?? 350) * f);
  };
  function frame(now) {
    if (!g.isConnected) return;
    const t = Math.min(1, (now - start) / duration);
    const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    let d = e * total, x = points[0][0], y = points[0][1];
    for (const s of segs) {
      if (d <= s.len) { x = s.x1 + (s.x2 - s.x1) * (d / s.len); y = s.y1 + (s.y2 - s.y1) * (d / s.len); break; }
      d -= s.len; x = s.x2; y = s.y2;
    }
    dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y));
    pill.setAttribute('transform', `translate(${x + 12} ${y - 30})`);
    if (t < 1) requestAnimationFrame(frame); else done();
  }
  requestAnimationFrame(frame);
}
const shortScope = (actions) => actions.map((a) => a.replace('repo.', '').replace('analytics.', '').replace('deploy.', '')).join(' + ');
const short = (p) => (p || '').split('/').pop();
const denialTarget = (text) => (/\.env/.test(text) ? 'r-env' : /analytics\.raw/.test(text) ? 'r-raw' : /deploy\.production/.test(text) ? 'r-prod' : /repo\.write/.test(text) ? 'r-repo' : null);
const denialLabel = (text) => { const m = text.match(/(repo\.\w+ \S+|deploy\.\w+|analytics\.\w+(?:\([^)]*\))?|request_authority|accept offer|get_request)/); return m ? m[1].replace(/\(.*\)/, '') : 'request'; };

/** Turns a real event into movement on the diagram. State changes (dim, badges, locks) also apply at Instant; packets do not. */
function animate(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    pulse('n-owner');
    send([P.owner, P.leadTop], 'good', 'root grant');
    setBadge('b-lead', 'root grant');
    node('lead', '', 'task received · holds the root grant');
  } else if (ev.type === 'event') {
    const e = ev.event, n = NODE[e.agent];
    switch (e.kind) {
      case 'note': pulse('n-lead'); break;
      case 'subagent_created': node(n, '', 'own credential'); pulse(`n-${n}`); break;
      case 'external_contacted': node('security', '', 'separate process · own credential'); pulse('n-security'); break;
      case 'authority_delegated': {
        const m = e.text.match(/^Delegated to ([a-z]+)-agent: (.+?) on (.+)$/);
        if (!m) break;
        const who = m[1], actions = m[2].split(', ');
        if (who === 'security') send([P.lead, P.gate, P.security], 'good', 'read-only pass'); else send([P.leadBottom, P[`${who}Top`]], 'good', `${shortScope(actions)} pass`);
        setBadge(`b-${who}`, who === 'security' ? 'read-only' : shortScope(actions));
        break;
      }
      case 'narrower_requested': send([P.hostingTop, P.leadBottom], 'warn', 'may I deploy.preview?'); node('hosting', '', 'negotiating with the lead'); break;
      case 'permission_granted': send([P.leadBottom, P.hostingTop], 'good', 'deploy.preview · 15 min'); setBadge('b-hosting', 'read + preview · 15 min'); break;
      case 'deployment_completed': pulse('r-preview'); node('hosting', 'done', 'preview live'); break;
      case 'analytics_analyzed': pulse('r-agg'); node('analytics', 'done', 'aggregates computed'); break;
      case 'fix_applied': send([P.lead, P.gate, P.repo], 'good', 'repo.write newsletter.ts'); node('lead', '', 'applied the security fix'); break;
      case 'authority_revoked': {
        const m = e.text.match(/Revoked ([a-z-]+)'s grant/);
        if (!m) break;
        send([P.lead, P.gate], 'warn', `revoke ${m[1]}`, { hold: 150 });
        const who = m[1].replace('-preview', '');
        setBadge(`b-${who}`, 'revoked', true);
        node(who, 'revoked', who === 'security' ? 'grant revoked · credential untouched' : 'credential disabled');
        const lock = document.getElementById(`l-${who}`);
        if (lock) lock.setAttribute('opacity', '1');
        break;
      }
    }
  } else if (ev.type === 'trace') {
    const n = NODE[ev.agent];
    if (!n) return;
    const t = ev.text;
    if (ev.kind === 'call') {
      if (/^negative check/.test(t)) return;
      let m;
      if ((m = t.match(/^(repo\.(?:list|read|write)) (\S+)/))) send([P[n], P.gate, P.repo], 'good', `${m[1]} ${short(m[2])}`, { hold: 100 });
      else if (/^analytics\.aggregate/.test(t)) send([P.analytics, P.gate, P.agg], 'good', 'analytics.aggregate');
      else if (/^deploy\.preview: live/.test(t)) send([P.hosting, P.gate, P.preview], 'good', 'deploy.preview');
      else if (/^accept offer/.test(t)) pulse('n-hosting');
    } else if (ev.kind === 'denied') {
      send([P[n], P.gate], 'bad', denialLabel(t), { burstAt: P.gate });
      const target = denialTarget(t);
      if (target) setTimeout(() => hit(target), 450 * (pace() || 1));
    } else if (ev.kind === 'result') { node(n, 'done'); pulse(`n-${n}`); }
    else if (ev.kind === 'note' && /Attempting production/.test(t)) node('hosting', '', 'trying production first');
  }
}

// ---- Phases, dots and the "What happened" list ----
function phaseOf(env) {
  const ev = env.event;
  if (ev.type === 'meta') return 1;
  if (ev.type === 'event') {
    const e = ev.event;
    if (e.kind === 'note') return 1;
    if (e.kind === 'authority_revoked') return 6;
    if (e.kind === 'fix_applied' || e.kind === 'external_contacted') return 3;
    if (e.kind === 'narrower_requested' || e.kind === 'permission_granted' || e.kind === 'deployment_completed') return 4;
    if (e.kind === 'analytics_analyzed') return 5;
    if (e.kind === 'authority_delegated') { const m = e.text.match(/^Delegated to ([a-z-]+)/); return m ? PHASE_OF_AGENT[m[1]] || 0 : 0; }
    return PHASE_OF_AGENT[e.agent] || 0;
  }
  if (ev.type === 'trace') return PHASE_OF_AGENT[ev.agent] || 0;
  return 0;
}
function setPhase(n) {
  if (n <= st.phase) return;
  st.phase = n;
  [...$('#dots').children].forEach((d, i) => d.classList.toggle('now', i === n - 1));
  [...$('#checks').children].forEach((li, i) => { if (CHECK_PHASE[i] < n) li.classList.add('seen'); });
}
const phaseLabel = (n) => (n ? `Phase ${n} of ${PHASES.length} · ${PHASES[n - 1]}` : 'Ready');

let st;
function reset() {
  st = { count: 0, allowed: 0, denied: 0, negotiated: 0, revoked: 0, grants: new Map(), phase: 0 };
  $('#timeline').replaceChildren(el('li', 'empty', 'Starting…'));
  $('#grants tbody').replaceChildren((() => { const tr = el('tr', 'empty'); const td = el('td', '', 'No grants yet.'); td.colSpan = 4; tr.append(td); return tr; })());
  for (const id of ['allowed', 'denied', 'negotiated', 'revoked']) $(`#n-${id}`).textContent = '0';
  $('#count').textContent = '';
  $('#hero-before').textContent = '—'; $('#hero-after').textContent = '—';
  $('#findings').replaceChildren(el('li', 'muted', '—')); $('#fix').textContent = ''; $('#fix').className = 'muted';
  $('#preview').replaceChildren('—'); $('#metrics').textContent = '—'; $('#metrics').className = 'muted'; $('#suggestions').replaceChildren();
  $('#checks').replaceChildren(...CHECKS.map((t) => { const li = el('li'); li.append(el('span', 'm', '·'), el('span', '', t)); return li; }));
  $('#dots').replaceChildren(...PHASES.map((t, i) => { const li = el('li', '', String(i + 1)); li.title = t; return li; }));
  $('#result').textContent = ''; $('#result').className = 'result';
  caption('Ready', 'Press “Run demo” to watch one lead and four real agents build a page under AgentPass.', '');
  // diagram
  $('#flows').replaceChildren();
  for (const n of ['design', 'hosting', 'analytics', 'security']) {
    const g = document.getElementById(`n-${n}`); g.className.baseVal = `node dim${n === 'security' ? ' external' : ''}`;
    document.getElementById(`s-${n}`).textContent = n === 'security' ? 'not contacted yet · read-only when it is' : 'not started yet';
    setBadge(`b-${n}`, '');
    const lock = document.getElementById(`l-${n}`); if (lock) lock.setAttribute('opacity', '0');
  }
  document.getElementById('n-lead').className.baseVal = 'node'; $('#s-lead').textContent = 'coordinates the specialists'; setBadge('b-lead', '');
  for (const v of document.querySelectorAll('.vault-g')) v.classList.remove('hit');
}

function row(cls, at, who, whatNodes) {
  const list = $('#timeline');
  list.querySelector('.empty')?.remove();
  const li = el('li', cls);
  const what = el('span', 'what');
  what.append(...whatNodes);
  li.append(el('span', 't', clock(at)), el('span', 'who', who), what);
  list.append(li);
  if (list.closest('details')?.open) li.scrollIntoView({ block: 'nearest' });
  st.count += 1; $('#count').textContent = `· ${st.count} lines`;
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
    el('td', '', (g.holder || '').replace('-agent', '')),
    el('td', '', (g.actions || []).join(', ')),
    el('td', '', (g.resources || []).join(', ')),
    el('td', '', g.revoked ? 'revoked' : g.status || 'active'),
  );
}

function onWorkflowEvent(e) {
  const [cls, label] = KIND[e.kind] || ['info', e.kind];
  caption(undefined, headline(e), e.text);
  // Denials are already shown by the agent's own trace line (with the error code); only count them here.
  if (e.kind !== 'permission_denied') row('event', e.at, e.agent, [el('span', `tag ${cls}`, label), document.createTextNode(e.text)]);
  if (e.kind === 'authority_delegated') {
    const m = e.text.match(/Delegated to ([a-z-]+): (.+?) on (.+)$/);
    if (m) { upsertGrant(`${m[1]}`, { holder: m[1], actions: m[2].split(', '), resources: m[3].split(', '), status: 'active' }); st.allowed += 1; }
  }
  if (e.kind === 'permission_denied') st.denied += 1;
  if (e.kind === 'narrower_requested') st.negotiated += 1;
  if (e.kind === 'permission_granted') upsertGrant('hosting-preview', { holder: 'hosting-agent', actions: ['deploy.preview'], resources: ['preview'], status: 'active (15 min)' });
  if (e.kind === 'authority_revoked') {
    st.revoked += 1;
    const m = e.text.match(/Revoked ([a-z-]+)'s grant/);
    if (m) upsertGrant(m[1] === 'hosting-preview' ? 'hosting-preview' : `${m[1]}-agent`, { revoked: true });
  }
  $('#n-allowed').textContent = st.allowed; $('#n-denied').textContent = st.denied; $('#n-negotiated').textContent = st.negotiated; $('#n-revoked').textContent = st.revoked;
}

function onTrace(e) {
  if (e.kind === 'note') row('trace note', e.at, e.agent, [document.createTextNode(`» ${e.text}`)]);
  else if (e.kind === 'denied') row('trace', e.at, e.agent, [el('span', 'tag bad', e.code || 'denied'), document.createTextNode(e.text)]);
  else if (e.kind === 'result') row('trace', e.at, e.agent, [el('span', 'tag ok', 'result'), document.createTextNode(e.text)]);
  else row('trace', e.at, e.agent, [document.createTextNode(e.text)]);
  if (e.kind === 'call' || e.kind === 'note') caption(undefined, undefined, `${e.agent}: ${e.text}`);
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

const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function onEvent(env) {
  const ev = env.event;
  const phase = phaseOf(env);
  if (phase) { setPhase(phase); $('#step-no').textContent = phaseLabel(st.phase); }
  if (ev.type === 'meta') {
    const b = $('#authority');
    b.textContent = `authority: ${ev.authority}${ev.missing?.length ? ` · missing: ${ev.missing.join(', ')}` : ''}`;
    b.className = `badge ${ev.authority === 'MOCK' ? 'mock' : 'real'}`;
    b.title = ev.authority === 'MOCK' ? 'Labeled mock until Developer A\'s generic-action contract is wired in' : 'Real AgentPass authority';
    upsertGrant('grant-root-lead', { holder: 'lead-agent', actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'], resources: ['src/**', 'package.json', 'preview', 'landing-page'], status: 'root (owner-issued)' });
    caption(undefined, `Clean seeded start on ${ev.authority === 'MOCK' ? 'the labeled mock authority' : 'the real AgentPass authority'}: fresh project copy, fresh credentials, one owner-issued root grant.`, '');
  } else if (ev.type === 'event') onWorkflowEvent(ev.event);
  else if (ev.type === 'trace') onTrace(ev);
  else if (ev.type === 'outputs') { onOutputs(ev.outputs); caption('Outputs', 'What the agents actually produced: the page diff, the audit, the preview URL and the metrics.', ''); }
  else if (ev.type === 'check') {
    const li = $('#checks').children[ev.check.n - 1];
    if (li) { li.className = ev.check.pass ? 'seen pass' : 'seen fail'; li.querySelector('.m').textContent = ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
    caption('Verifying', `Checking the run against real events and files: ${ev.check.n} of ${CHECKS.length}.`, `${ev.check.pass ? 'PASS' : 'FAIL'} ${ev.check.title}: ${ev.check.detail}`);
  } else if (ev.type === 'done') {
    const n = $('#checks').querySelectorAll('.pass').length;
    const shown = play.startedAt ? ` · ${mmss(performance.now() - play.startedAt)} on screen` : '';
    $('#result').className = `result ${ev.passed ? 'pass' : 'fail'}`;
    $('#result').textContent = `${n} of ${CHECKS.length} checks passed${shown}`;
    const dots = [...$('#dots').children];
    dots.forEach((d, i) => {
      d.classList.remove('now');
      const mine = [...$('#checks').children].filter((_, j) => CHECK_PHASE[j] === i + 1);
      const ok = i === 0 ? ev.passed : mine.length > 0 && mine.every((li) => li.classList.contains('pass'));
      d.className = ok ? 'pass' : 'fail'; d.textContent = ok ? '✓' : '✕';
    });
    caption('Done', ev.passed ? `Every rule held: ${n} of ${CHECKS.length} checks passed.` : `Some checks failed: ${n} of ${CHECKS.length} passed.`, 'Every refusal, grant and revocation above was a real AgentPass decision on a real agent session.');
    refresh();
  }
  animate(env);
}

async function refresh() {
  const s = await fetch('/api/status').then((r) => r.json());
  $('#run').disabled = s.running;
}

document.addEventListener('DOMContentLoaded', () => {
  reset();
  playState();
  $('#run').addEventListener('click', async () => {
    $('#run').disabled = true;
    const r = await fetch('/api/workforce/run', { method: 'POST' });
    if (!r.ok) { caption('Could not start', (await r.json()).reason, ''); refresh(); }
  });
  $('#speed').addEventListener('change', (e) => setSpeed(e.target.value));
  $('#step').addEventListener('change', (e) => { setStep(e.target.checked); e.target.blur(); });
  $('#next').addEventListener('click', next);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== ' ') return;
    const t = e.target;
    if (t && /^(SELECT|TEXTAREA)$/.test(t.tagName)) return; // menus keep their own keys
    if (e.key === ' ' && t && (t.tagName === 'BUTTON' || t.tagName === 'A' || (t.tagName === 'INPUT' && t.type === 'checkbox'))) return; // Space already clicks these
    if (!play.paused) return;
    e.preventDefault();
    next();
  });
  const source = new EventSource('/api/events');
  source.addEventListener('reset', (m) => { clearPlayback(); reset(); play.catchUp = JSON.parse(m.data).label === 'current'; });
  source.onmessage = (m) => enqueue(JSON.parse(m.data));
  refresh();
});
