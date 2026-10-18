// Animated, plain-English view of the real workforce stream from /api/events.
// Every packet on the diagram is a real call made by a separate agent
// session; the caption says in one short sentence what just happened.
// Agent trace lines go to the technical log; only refusals and one
// "does its work" move per helper animate, so the stage stays readable.
// Pacing (Speed) is client-side: nothing is dropped or reordered, Instant
// shows the raw stream. textContent / SVG text nodes only.
const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const clock = (iso) => (iso ? iso.slice(11, 23) : '');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const CHECKS = [
  'Design edited the page', 'Design blocked from the secrets file', 'Security reviewer did a real review',
  'Reviewer blocked from editing', 'Publishing tried the live site', 'AgentPass blocked the live site',
  'Publishing asked for a smaller pass', 'Test copy published', 'Numbers computed real totals',
  'Numbers blocked from people’s records', 'All passes taken back at the end', 'Old passes no longer work',
];
const PHASES = ['The master pass', 'Design', 'Outside security reviewer', 'Publishing', 'Numbers', 'Passes taken back'];
const CHECK_PHASE = [2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6];
const WHO = { 'lead-agent': 'the manager', 'design-agent': 'Design', 'security-agent': 'the security reviewer', 'hosting-agent': 'Publishing', 'analytics-agent': 'Numbers' };
const NODE = { 'lead-agent': 'lead', 'design-agent': 'design', 'security-agent': 'security', 'hosting-agent': 'hosting', 'analytics-agent': 'analytics' };
const PHASE_OF_AGENT = { 'design-agent': 2, 'security-agent': 3, 'hosting-agent': 4, 'analytics-agent': 5 };
const who = (a) => WHO[a] || a;

// Anchor points in the SVG's coordinate space.
const P = {
  owner: [200, 118], leadTop: [200, 150], leadBottom: [200, 236], lead: [296, 193], gate: [564, 235],
  design: [101, 355], hosting: [241, 355], analytics: [381, 355], security: [830, 417],
  designTop: [101, 300], hostingTop: [241, 300], analyticsTop: [381, 300],
  repo: [690, 78], env: [690, 126], preview: [690, 174], prod: [690, 222], agg: [690, 270], raw: [690, 318],
};

/** Short pass label: "read + edit", "test copy", "see totals". */
const shortScope = (actions) => {
  const a = new Set(actions);
  const parts = [];
  if (a.has('repo.read')) parts.push('read');
  if (a.has('repo.write')) parts.push('edit');
  if (a.has('deploy.preview')) parts.push('test copy');
  if (a.has('analytics.aggregate')) parts.push('see totals');
  return parts.join(' + ') || actions.join(', ');
};
const where = (list) => {
  const w = new Set(list.map((r) => (/^src\/components/.test(r) ? 'the page layout files' : /^src\/styles/.test(r) ? 'the page styles' : /^src\//.test(r) ? 'the page files' : r === 'package.json' ? 'project settings' : r === 'preview' ? 'the test copy' : r === 'landing-page' ? 'the visitor data' : r)));
  return [...w].join(', ');
};

// ---- Caption: one short headline and one short detail per workflow event ----
function headline(e) {
  const w = who(e.agent);
  switch (e.kind) {
    case 'note': return 'The manager gets the job and one master pass.';
    case 'subagent_created': return `${cap(w)} joins with its own key.`;
    case 'authority_delegated': { const m = e.text.match(/^Delegated to ([a-z-]+)/); return `The manager gives ${m ? who(m[1]) : 'a helper'} a smaller pass.`; }
    case 'external_contacted': return 'An outside security reviewer joins, with its own key.';
    case 'permission_denied': {
      if (e.code === 'GRANT_REVOKED' || e.code === 'INVALID_CALLER') return `${cap(w)} tries its old pass. Blocked.`;
      if (/\.env/.test(e.text)) return `${cap(w)} tries to open the secrets file. Blocked.`;
      if (/deploy\.production/.test(e.text)) return `${cap(w)} tries to publish to the live site. Blocked.`;
      if (/analytics\.raw/.test(e.text)) return `${cap(w)} asks for people’s records. Blocked.`;
      if (/repo\.write/.test(e.text)) return `${cap(w)} tries to edit a file its pass doesn’t cover. Blocked.`;
      return `AgentPass says no to ${w}.`;
    }
    case 'narrower_requested': return `${cap(w)} asks for a smaller pass instead: the test copy only.`;
    case 'permission_granted': return 'The manager agrees: test copy only, for 15 minutes.';
    case 'deployment_completed': return 'The test copy is live. The real site was never touched.';
    case 'analytics_analyzed': return 'Numbers works out the visitor totals.';
    case 'fix_applied': return 'The manager fixes the bug the reviewer found.';
    case 'authority_revoked': return 'Job done. The manager takes every pass back.';
    default: return `${cap(w)}: ${e.kind}`;
  }
}
function detailFor(e) {
  let m;
  switch (e.kind) {
    case 'note': return 'Improve the page, review security, publish a test copy, report the numbers.';
    case 'subagent_created': return 'AgentPass only ever sees a fingerprint of the key.';
    case 'authority_delegated': {
      m = e.text.match(/^Delegated to ([a-z-]+): (.+?) on (.+)$/);
      if (!m) return '';
      return m[1] === 'security-agent' ? `Look only, in ${where(m[3].split(', '))}.` : `It may ${shortScope(m[2].split(', ')).replace(' + ', ' and ')}, in ${where(m[3].split(', '))}. Nothing else.`;
    }
    case 'external_contacted': return 'Look only. It cannot change anything.';
    case 'permission_denied': {
      if (e.code === 'GRANT_REVOKED' || e.code === 'INVALID_CALLER') return 'The pass no longer works.';
      if (/\.env/.test(e.text)) return 'No pass covers it, not even the manager’s.';
      if (/deploy\.production/.test(e.text)) return 'Nobody in this job may. AgentPass says what it may ask for instead: the test copy.';
      if (/analytics\.raw/.test(e.text)) return 'Those stay private.';
      return '';
    }
    case 'narrower_requested': return 'Exactly what AgentPass said it could ask for, with its reason.';
    case 'permission_granted': return 'Less than it asked for, and only for a short time.';
    case 'deployment_completed': return (m = e.text.match(/at (\S+)/)) ? `On this computer at ${m[1]}.` : '';
    case 'analytics_analyzed': return 'Totals only, never individual records.';
    case 'fix_applied': return 'The reviewer could only look; the manager holds the editing pass.';
    case 'authority_revoked': return (m = e.text.match(/Revoked ([a-z-]+)'s/)) ? `${m[1] === 'hosting-preview' ? 'Publishing’s test-copy pass' : `${cap(who(`${m[1]}-agent`))}’s pass`}: taken back.` : '';
    default: return '';
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
const play = { speed: 'normal', queue: [], pumping: false, timer: null, startedAt: 0, catchUp: false };
const pace = () => (play.catchUp ? 0 : SPEED[play.speed]);
/** Whether a trace line produces anything visible on the stage (see animate). */
const traceShows = (ev) => ev.kind === 'denied' || ev.kind === 'result' || (ev.kind === 'call' && /^(analytics\.aggregate|deploy\.preview: live|accept offer)/.test(ev.text)) || (ev.kind === 'note' && (/^(rewrote |read \d+ files)/.test(ev.text) || /Attempting production/.test(ev.text)));
function delayFor(env) {
  const f = pace();
  if (!f) return 0;
  const t = env.event.type;
  const base = t === 'event' ? 1300 : t === 'trace' ? (traceShows(env.event) ? 600 : 40) : t === 'outputs' ? 700 : t === 'check' ? 150 : t === 'meta' ? 900 : 0;
  return base * f;
}
function playState() {
  const n = play.queue.length;
  $('#story-state').textContent = n > 0 ? `playing · ${n} to go` : '';
}
function enqueue(env) {
  if (!play.startedAt) play.startedAt = performance.now();
  play.queue.push(env);
  if (!play.pumping) { play.pumping = true; tick(); } else playState();
}
function tick() {
  play.timer = null;
  while (play.queue.length) {
    const env = play.queue.shift();
    onEvent(env);
    const d = delayFor(env);
    if (d > 0) { play.timer = setTimeout(tick, d); playState(); return; }
  }
  play.pumping = false;
  playState();
}
function setSpeed(speed) {
  play.speed = speed;
  if (speed === 'instant') { clearTimeout(play.timer); play.timer = null; if (play.pumping) tick(); }
}
function clearPlayback() {
  clearTimeout(play.timer);
  Object.assign(play, { queue: [], pumping: false, timer: null, startedAt: 0, catchUp: false });
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
const denialTarget = (text) => (/\.env/.test(text) ? 'r-env' : /analytics\.raw/.test(text) ? 'r-raw' : /deploy\.production/.test(text) ? 'r-prod' : /repo\.(write|read)/.test(text) ? 'r-repo' : null);
const denialLabel = (text, code) => {
  if (code === 'GRANT_REVOKED' || code === 'INVALID_CALLER') return 'old pass';
  if (/\.env/.test(text)) return 'open the secrets file';
  if (/deploy\.production/.test(text)) return 'publish to the live site';
  if (/analytics\.raw/.test(text)) return 'see people’s records';
  if (/repo\.write/.test(text)) return 'edit a file';
  return 'request';
};

/** Turns a real event into movement on the diagram. State changes (dim, badges, locks) also apply at Instant; packets do not. */
function animate(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    pulse('n-owner');
    send([P.owner, P.leadTop], 'good', 'master pass');
    setBadge('b-lead', 'master pass');
    node('lead', '', 'holds the master pass');
  } else if (ev.type === 'event') {
    const e = ev.event, n = NODE[e.agent];
    switch (e.kind) {
      case 'note': pulse('n-lead'); break;
      case 'subagent_created': node(n, '', 'has its own key'); pulse(`n-${n}`); break;
      case 'external_contacted': node('security', '', 'another company · own key'); pulse('n-security'); break;
      case 'authority_delegated': {
        const m = e.text.match(/^Delegated to ([a-z]+)-agent: (.+?) on (.+)$/);
        if (!m) break;
        const w = m[1], actions = m[2].split(', ');
        if (w === 'security') send([P.lead, P.gate, P.security], 'good', 'look-only pass'); else send([P.leadBottom, P[`${w}Top`]], 'good', `pass: ${shortScope(actions)}`);
        setBadge(`b-${w}`, w === 'security' ? 'look only' : shortScope(actions));
        break;
      }
      case 'narrower_requested': send([P.hostingTop, P.leadBottom], 'warn', 'may I do the test copy instead?'); node('hosting', '', 'asking for less'); break;
      case 'permission_granted': send([P.leadBottom, P.hostingTop], 'good', 'test copy only · 15 min'); setBadge('b-hosting', 'read + test copy · 15 min'); break;
      case 'deployment_completed': pulse('r-preview'); node('hosting', 'done', 'test copy is live'); break;
      case 'analytics_analyzed': pulse('r-agg'); node('analytics', 'done', 'totals worked out'); break;
      case 'fix_applied': send([P.lead, P.gate, P.repo], 'good', 'fixes the bug'); node('lead', '', 'fixed the security bug'); break;
      case 'authority_revoked': {
        const m = e.text.match(/Revoked ([a-z-]+)'s grant/);
        if (!m) break;
        const w = m[1].replace('-preview', '');
        send([P.lead, P.gate], 'warn', `take back ${cap(who(`${w}-agent`))}’s ${m[1].endsWith('-preview') ? 'test-copy pass' : 'pass'}`, { hold: 150 });
        setBadge(`b-${w}`, 'taken back', true);
        node(w, 'revoked', w === 'security' ? 'pass taken back' : 'key disabled');
        const lock = document.getElementById(`l-${w}`);
        if (lock) lock.setAttribute('opacity', '1');
        break;
      }
    }
  } else if (ev.type === 'trace') {
    const n = NODE[ev.agent];
    if (!n) return;
    const t = ev.text;
    // One packet per helper for its real work (not one per file), plus every refusal.
    if (ev.kind === 'call') {
      if (/^analytics\.aggregate/.test(t)) send([P.analytics, P.gate, P.agg], 'good', 'get totals');
      else if (/^deploy\.preview: live/.test(t)) send([P.hosting, P.gate, P.preview], 'good', 'publish test copy');
      else if (/^accept offer/.test(t)) pulse('n-hosting');
    } else if (ev.kind === 'note') {
      if (/^rewrote /.test(t)) send([P[n], P.gate, P.repo], 'good', 'edits the page');
      else if (/^read \d+ files/.test(t)) send([P[n], P.gate, P.repo], 'good', 'reads the page');
      else if (/Attempting production/.test(t)) node('hosting', '', 'tries the live site');
    } else if (ev.kind === 'denied') {
      send([P[n], P.gate], 'bad', denialLabel(t, ev.code), { burstAt: P.gate });
      const target = denialTarget(t);
      if (target) setTimeout(() => hit(target), 450 * (pace() || 1));
    } else if (ev.kind === 'result') { node(n, 'done'); pulse(`n-${n}`); }
  }
}

// ---- Phases and dots ----
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
const phaseLabel = (n) => (n ? `Step ${n} of ${PHASES.length} · ${PHASES[n - 1]}` : 'Ready');

let st;
function reset() {
  st = { count: 0, phase: 0 };
  $('#timeline').replaceChildren(el('li', 'empty', 'Press “Run demo”.'));
  $('#count').textContent = '';
  for (const id of ['hero', 'security', 'preview', 'metrics']) $(`#${id}`).textContent = '—';
  $('#checks').replaceChildren(...CHECKS.map((t) => { const li = el('li'); li.append(el('span', 'm', '·'), el('span', '', t)); return li; }));
  $('#dots').replaceChildren(...PHASES.map((t, i) => { const li = el('li', '', String(i + 1)); li.title = t; return li; }));
  $('#result').textContent = ''; $('#result').className = 'result';
  caption('Ready', 'Press “Run demo”.', '');
  // diagram
  $('#flows').replaceChildren();
  for (const n of ['design', 'hosting', 'analytics', 'security']) {
    const g = document.getElementById(`n-${n}`); g.className.baseVal = `node dim${n === 'security' ? ' external' : ''}`;
    document.getElementById(`s-${n}`).textContent = n === 'security' ? 'not called in yet · may look, never edit' : 'not started';
    setBadge(`b-${n}`, '');
    const lock = document.getElementById(`l-${n}`); if (lock) lock.setAttribute('opacity', '0');
  }
  document.getElementById('n-lead').className.baseVal = 'node'; $('#s-lead').textContent = 'directs the helpers'; setBadge('b-lead', '');
  for (const v of document.querySelectorAll('.vault-g')) v.classList.remove('hit');
}

function row(cls, at, agent, whatNodes) {
  const list = $('#timeline');
  list.querySelector('.empty')?.remove();
  const li = el('li', cls);
  const what = el('span', 'what');
  what.append(...whatNodes);
  li.append(el('span', 't', clock(at)), el('span', 'who', agent), what);
  list.append(li);
  if (list.closest('details')?.open) li.scrollIntoView({ block: 'nearest' });
  st.count += 1; $('#count').textContent = `· ${st.count} lines`;
}

function onWorkflowEvent(e) {
  caption(undefined, headline(e), detailFor(e));
  row('event', e.at, e.agent, [el('span', `tag ${e.kind === 'permission_denied' ? 'bad' : 'ok'}`, e.kind + (e.code ? ` ${e.code}` : '')), document.createTextNode(e.text)]);
}
function onTrace(e) {
  if (e.kind === 'denied') row('trace', e.at, e.agent, [el('span', 'tag bad', e.code || 'denied'), document.createTextNode(e.text)]);
  else row('trace', e.at, e.agent, [document.createTextNode(e.text)]);
}
function onOutputs(o) {
  // The outputs carry the whole Hero component before and after; show just the headline text.
  const h1 = (src) => { const m = String(src || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/); return (m ? m[1] : String(src || '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '—'; };
  $('#hero').replaceChildren(el('span', 'before', h1(o.before.hero)), document.createTextNode(' → '), el('span', '', h1(o.after.hero)));
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

const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function onEvent(env) {
  const ev = env.event;
  const phase = phaseOf(env);
  if (phase) { setPhase(phase); $('#step-no').textContent = phaseLabel(st.phase); }
  if (ev.type === 'meta') {
    const realRun = ev.authority !== 'MOCK';
    const b = $('#authority');
    b.textContent = realRun ? 'real AgentPass' : 'practice mock';
    b.className = `badge ${realRun ? 'real' : 'mock'}`;
    b.title = realRun ? 'Every decision comes from the real AgentPass service' : 'A labeled stand-in, not the real service';
    caption(undefined, `A clean start${realRun ? '' : ' on the practice mock'}: fresh project, new keys, one master pass.`, 'Even the master pass can’t touch the live site or people’s records.');
  } else if (ev.type === 'event') onWorkflowEvent(ev.event);
  else if (ev.type === 'trace') onTrace(ev);
  else if (ev.type === 'outputs') { onOutputs(ev.outputs); caption('Results', 'What the helpers made.', 'See the right-hand side.'); }
  else if (ev.type === 'check') {
    const li = $('#checks').children[ev.check.n - 1];
    if (li) { li.className = ev.check.pass ? 'seen pass' : 'seen fail'; li.querySelector('.m').textContent = ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
    caption('Checking', `Checking ${ev.check.n} of ${CHECKS.length}`, `${ev.check.pass ? '✓' : '✕'} ${CHECKS[ev.check.n - 1]}`);
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
    caption('Done', ev.passed ? `Every rule held: ${n} of ${CHECKS.length}.` : `Some checks failed: ${n} of ${CHECKS.length} passed.`, 'Every ✓ and ✕ you saw was a real AgentPass decision.');
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
  const source = new EventSource('/api/events');
  source.addEventListener('reset', (m) => { clearPlayback(); reset(); play.catchUp = JSON.parse(m.data).label === 'current'; });
  source.onmessage = (m) => enqueue(JSON.parse(m.data));
  refresh();
});
