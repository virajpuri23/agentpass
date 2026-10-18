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

// Plain-language wording for a viewer with some, not deep, tech background. The
// raw event text still appears in the small "technical" line and in the log.
const CHECKS = [
  'The Design helper really edited the page files', 'The Design helper was blocked from the secrets file', 'The outside security reviewer did a real review',
  'The security reviewer was blocked from editing anything', 'The Publishing helper tried to publish to the live site', 'AgentPass blocked the live-site publish',
  'The Publishing helper asked for a smaller pass instead (test copy only)', 'The test copy went live with that smaller pass', 'The Numbers helper worked out real visitor totals',
  'The Numbers helper was blocked from individual visitors’ records', 'Every temporary pass was taken back when the job was done', 'The old passes no longer open anything',
];
const PHASES = [
  'The manager gets the job and one master pass',
  'Design gets a small pass, edits the page, is blocked from the secrets',
  'An outside security reviewer looks but can’t touch; the manager fixes the bug',
  'Publishing is blocked from the live site, asks for less, ships a test copy',
  'Numbers gets totals only, never individual records',
  'Job done: every pass taken back, old passes dead',
];
const ACTION = {
  'repo.read': 'read page files', 'repo.write': 'edit page files', 'repo.list': 'list page files', 'security.audit.run': 'run a security review',
  'deploy.preview': 'publish a test copy', 'deploy.production': 'publish to the live site',
  'analytics.aggregate': 'see visitor totals', 'analytics.aggregate.read': 'see visitor totals', 'analytics.raw': 'see individual visitors', 'analytics.raw.read': 'see individual visitors',
};
const RESOURCE = {
  'src/**': 'all page files', 'src/': 'all page files', 'src/components/**': 'page layout files', 'src/components/': 'page layout files', 'src/app/**': 'page files', 'src/app/': 'page files',
  'package.json': 'project settings', 'preview': 'the test site', 'production': 'the live site', 'landing-page': 'visitor data', '.env': 'the secrets file',
};
const CODE = {
  INSUFFICIENT_SCOPE: 'that pass doesn’t cover this', AUTHORITY_REQUIRED: 'a different pass is needed; the desk said which one could be asked for', SECRET_FILE: 'the secrets file is never allowed',
  OUTSIDE_PARENT_SCOPE: 'nobody can hand out more than they hold', GRANT_REVOKED: 'that pass was taken back', INVALID_CALLER: 'that helper’s pass no longer exists',
  GRANT_EXPIRED: 'that pass has expired', NOT_FOUND: 'no such pass', FORBIDDEN: 'not allowed',
};
const RULE = {
  'dangerouslySetInnerHTML fed by an unescaped value': 'Serious: text typed by a visitor is put straight onto the page without being made safe (an attacker could inject their own code)',
  'hardcoded secret-looking literal in source': 'Serious: something that looks like a password or key is written directly in the code',
  'dependency pinned to a non-exact version': 'Minor: a library version is not pinned exactly',
};
const plainAction = (a) => ACTION[a] || a;
const plainActions = (list) => list.map(plainAction).join(', ');
const DIR = { components: 'page layout files', styles: 'page style files', app: 'page files', lib: 'page logic files' };
const plainResource = (r) => {
  if (RESOURCE[r]) return RESOURCE[r];
  const d = r.match(/^src\/([^/]+)\/(?:\*\*)?$/);
  if (d) return DIR[d[1]] || `${d[1]} files`;
  return /^src\//.test(r) ? `page file ${r.split('/').pop()}` : r;
};
const plainResources = (list) => list.map(plainResource).join(', ');
const plainCode = (c) => (c ? CODE[c] || c : '');
const fileName = (p) => (p || '').split('/').pop();
/** One plain sentence for an agent's own trace line (what it is doing right now). */
function plainTrace(agent, text) {
  const who = cap(WHO[agent] || agent);
  let m;
  if ((m = text.match(/^negative check: repo\.read \.env/))) return `${who} tries to open the secrets file (it should be blocked)`;
  if ((m = text.match(/^negative check: repo\.write (\S+)/))) return `${who} tries to edit ${fileName(m[1])}, which its pass does not cover (it should be blocked)`;
  if ((m = text.match(/^negative check: analytics\.raw/))) return `${who} asks for individual visitors’ records, emails included (it should be blocked)`;
  if ((m = text.match(/^repo\.list (\S+)/))) return `${who} looks at which files are in ${plainResource(m[1] + '/')}`;
  if ((m = text.match(/^repo\.read (\S+)/))) return `${who} reads ${fileName(m[1])}`;
  if ((m = text.match(/^repo\.write (\S+)/))) return `${who} edits ${fileName(m[1])}`;
  if ((m = text.match(/^read (\d+) files/))) return `${who} has read ${m[1]} files, all through the desk`;
  if ((m = text.match(/^rewrote (.+?);/))) return `${who} rewrote ${m[1].split(', ').map(fileName).join(', ')}`;
  if (/^done:/.test(text)) return `${who} is finished`;
  if (/^scan:/.test(text)) return `${who} finished the review: ${text.replace(/^scan: /, '')}`;
  if (/^Task: deploy/.test(text)) return `${who} tries the obvious thing first: publish straight to the live site`;
  if (/^deploy\.production: refused/.test(text)) return `${who} was blocked from the live site`;
  if (/^Refusal says/.test(text)) return `${who} reads the refusal: it names a smaller pass it may ask for, so it asks for exactly that`;
  if (/^accept offer/.test(text)) return `${who} accepts the smaller pass the manager offered`;
  if (/^deploy\.preview: live/.test(text)) return `${who} publishes the test copy with the smaller pass`;
  if (/^Preview deployed/.test(text)) return `${who}: the test copy is up`;
  if (/^analytics\.aggregate/.test(text)) return `${who} asks for visitor totals`;
  if ((m = text.match(/^aggregate received: (\d+) views, (\d+) signups over (\d+) days/))) return `${who} got totals only: ${Number(m[1]).toLocaleString()} visits, ${m[2]} signups in ${m[3]} days`;
  if (/^insights computed/.test(text)) return `${who} works out the conversion rate and a few suggestions, in code`;
  if (/suggestions,.*refusal/.test(text)) return `${who} is finished`;
  return `${who}: ${text}`;
}
/** Plain explanation of a refusal from its code and what was attempted. */
function plainDenial(text, code) {
  const why = plainCode(code);
  if (/\.env/.test(text)) return `Blocked: the secrets file is off-limits to every pass${why ? ` (${why})` : ''}.`;
  if (/deploy\.production/.test(text)) return `Blocked: the live site needs a pass nobody in this job holds. The desk also said what may be asked for instead: a pass for the test copy.`;
  if (/analytics\.raw/.test(text)) return `Blocked: individual visitors’ records stay private${why ? ` (${why})` : ''}.`;
  if (/repo\.write/.test(text)) return `Blocked: this pass does not allow editing that file${why ? ` (${why})` : ''}.`;
  return `Blocked${why ? `: ${why}` : ''}.`;
}
const CHECK_PHASE = [2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6];
const KIND = {
  subagent_created: ['info', 'spawned'], authority_delegated: ['ok', 'delegated'], external_contacted: ['info', 'external'],
  permission_denied: ['bad', 'denied'], narrower_requested: ['req', 'requested'], permission_granted: ['ok', 'granted'],
  deployment_completed: ['ok', 'deployed'], analytics_analyzed: ['ok', 'analyzed'], fix_applied: ['ok', 'fixed'],
  authority_revoked: ['rev', 'revoked'], note: ['info', 'note'],
};
const WHO = {
  'lead-agent': 'the manager', 'design-agent': 'the Design helper', 'security-agent': 'the outside security reviewer',
  'hosting-agent': 'the Publishing helper', 'analytics-agent': 'the Numbers helper',
};
const NODE = { 'lead-agent': 'lead', 'design-agent': 'design', 'security-agent': 'security', 'hosting-agent': 'hosting', 'analytics-agent': 'analytics' };
const SHORT = { 'lead-agent': 'Manager', 'design-agent': 'Design', 'security-agent': 'Security', 'hosting-agent': 'Publishing', 'analytics-agent': 'Numbers' };
const NAME = { lead: 'Manager', design: 'Design', security: 'Security reviewer', hosting: 'Publishing', analytics: 'Numbers', 'lead-agent': 'Manager', 'design-agent': 'Design', 'security-agent': 'Security reviewer', 'hosting-agent': 'Publishing', 'analytics-agent': 'Numbers' };
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
    case 'note': return 'The manager gets the job. It holds the one master pass.';
    case 'subagent_created': return `${cap(who)} is created with its own identity and its own secret key.`;
    case 'authority_delegated': { const m = e.text.match(/^Delegated to ([a-z-]+)/); return `The manager hands ${m && WHO[m[1]] ? WHO[m[1]] : 'a helper'} a smaller pass: a slice of its own, never more.`; }
    case 'external_contacted': return 'A security reviewer from a different company joins, signing in with its own key.';
    case 'permission_denied': return `AgentPass says no to ${who}.`;
    case 'narrower_requested': return `${cap(who)} asks the manager for a smaller pass, and says why.`;
    case 'permission_granted': return 'The manager agrees, but gives an even tighter pass: test copy only, 15 minutes.';
    case 'deployment_completed': return 'The test copy is live, using that small pass. The live site was never touched.';
    case 'analytics_analyzed': return 'The Numbers helper gets totals only. Individual visitors stay private.';
    case 'fix_applied': return 'The manager fixes the bug the reviewer found. The reviewer never had editing rights.';
    case 'authority_revoked': return 'Job done. The manager takes the passes back; the old ones stop working.';
    default: return `${cap(who)}: ${e.kind}`;
  }
}
/** Plain explanation under the headline for each workflow event (the raw text goes to the technical line). */
function detailFor(e) {
  const who = WHO[e.agent] || e.agent;
  let m;
  switch (e.kind) {
    case 'note': return 'The job: make the landing page look better, get it security-reviewed, publish a test copy and report visitor numbers.';
    case 'subagent_created': return 'AgentPass only ever receives a fingerprint of the key, never the key itself, so nobody can copy it later.';
    case 'authority_delegated': {
      m = e.text.match(/^Delegated to ([a-z-]+): (.+?) on (.+)$/);
      return m ? `${cap(WHO[m[1]] || m[1])} may now: ${plainActions(m[2].split(', '))}. Where: ${plainResources(m[3].split(', '))}. Nothing else.` : e.text;
    }
    case 'external_contacted': return 'It runs as a separate program, in another company, and gets a look-only pass. It cannot change a single file.';
    case 'permission_denied': return plainDenial(e.text, e.code);
    case 'narrower_requested': { m = e.text.match(/"(.+)"$/); return m ? `Its reason: “${m[1]}”` : e.text; }
    case 'permission_granted': return 'Asking for less is how helpers get things done without anyone handing over the keys to the whole project.';
    case 'deployment_completed': { m = e.text.match(/at (\S+)/); return m ? `The test copy runs on this computer at ${m[1]}.` : e.text; }
    case 'analytics_analyzed': return 'Visits, signups and a conversion rate were computed from the data, without ever handing over a single person’s record.';
    case 'fix_applied': return 'The reviewer found text being put on the page without being made safe; the manager, which does hold an editing pass, applied the fix.';
    case 'authority_revoked': { m = e.text.match(/Revoked ([a-z-]+)'s/); return m ? `${cap(WHO[`${m[1]}-agent`] || (m[1] === 'hosting-preview' ? 'the Publishing helper’s test-copy pass' : m[1]))}: pass taken back.` : e.text; }
    default: return `${cap(who)}: ${e.text}`;
  }
}
function caption(no, title, detail, tech) {
  if (no !== undefined) $('#step-no').textContent = no;
  if (title !== undefined) $('#story').textContent = title;
  $('#story-detail').textContent = detail || '';
  $('#story-tech').textContent = tech ? `technical: ${tech}` : '';
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
  if (play.paused) { s.textContent = `paused before the next step · press Next, → or Space · ${n} to go`; s.className = 'step-state paused'; }
  else if (n > 0) { s.textContent = `playing · ${n} to go`; s.className = 'step-state'; }
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
/** Short pass label for a node badge / packet: "read + edit", "look only", "see totals". */
const shortScope = (actions) => {
  const set = new Set(actions.map((a) => a.replace(/^(analytics\.\w+)\.read$/, '$1')));
  const parts = [];
  if (set.has('repo.read') || set.has('repo.list')) parts.push('read');
  if (set.has('repo.write')) parts.push('edit');
  if (set.has('security.audit.run')) parts.push('review');
  if (set.has('deploy.preview')) parts.push('test copy');
  if (set.has('deploy.production')) parts.push('live site');
  if (set.has('analytics.aggregate')) parts.push('see totals');
  if (set.has('analytics.raw')) parts.push('see people');
  return parts.join(' + ') || actions.join(', ');
};
const short = (p) => (p || '').split('/').pop();
const denialTarget = (text) => (/\.env/.test(text) ? 'r-env' : /analytics\.raw/.test(text) ? 'r-raw' : /deploy\.production/.test(text) ? 'r-prod' : /repo\.write/.test(text) ? 'r-repo' : null);
const denialLabel = (text) => {
  if (/\.env/.test(text)) return 'open the secrets file';
  if (/deploy\.production/.test(text)) return 'publish to the live site';
  if (/analytics\.raw/.test(text)) return 'see visitors’ records';
  const m = text.match(/repo\.write (\S+)/);
  if (m) return `edit ${short(m[1])}`;
  return 'request';
};

/** Turns a real event into movement on the diagram. State changes (dim, badges, locks) also apply at Instant; packets do not. */
function animate(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    pulse('n-owner');
    send([P.owner, P.leadTop], 'good', 'master pass');
    setBadge('b-lead', 'master pass');
    node('lead', '', 'has the job · holds the master pass');
  } else if (ev.type === 'event') {
    const e = ev.event, n = NODE[e.agent];
    switch (e.kind) {
      case 'note': pulse('n-lead'); break;
      case 'subagent_created': node(n, '', 'has its own key'); pulse(`n-${n}`); break;
      case 'external_contacted': node('security', '', 'another company · own key'); pulse('n-security'); break;
      case 'authority_delegated': {
        const m = e.text.match(/^Delegated to ([a-z]+)-agent: (.+?) on (.+)$/);
        if (!m) break;
        const who = m[1], actions = m[2].split(', ');
        if (who === 'security') send([P.lead, P.gate, P.security], 'good', 'look-only pass'); else send([P.leadBottom, P[`${who}Top`]], 'good', `pass: ${shortScope(actions)}`);
        setBadge(`b-${who}`, who === 'security' ? 'look only' : shortScope(actions));
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
        const who = m[1].replace('-preview', '');
        send([P.lead, P.gate], 'warn', `take back ${NAME[who] || who}${m[1].endsWith('-preview') ? '’s test-copy pass' : '’s pass'}`, { hold: 150 });
        setBadge(`b-${who}`, 'taken back', true);
        node(who, 'revoked', who === 'security' ? 'pass taken back' : 'key disabled');
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
      if ((m = t.match(/^repo\.list (\S+)/))) send([P[n], P.gate, P.repo], 'good', `list ${short(m[1])}/`, { hold: 100 });
      else if ((m = t.match(/^repo\.read (\S+)/))) send([P[n], P.gate, P.repo], 'good', `read ${short(m[1])}`, { hold: 100 });
      else if ((m = t.match(/^repo\.write (\S+)/))) send([P[n], P.gate, P.repo], 'good', `edit ${short(m[1])}`, { hold: 100 });
      else if (/^analytics\.aggregate/.test(t)) send([P.analytics, P.gate, P.agg], 'good', 'get visitor totals');
      else if (/^deploy\.preview: live/.test(t)) send([P.hosting, P.gate, P.preview], 'good', 'publish test copy');
      else if (/^accept offer/.test(t)) pulse('n-hosting');
    } else if (ev.kind === 'denied') {
      send([P[n], P.gate], 'bad', denialLabel(t), { burstAt: P.gate });
      const target = denialTarget(t);
      if (target) setTimeout(() => hit(target), 450 * (pace() || 1));
    } else if (ev.kind === 'result') { node(n, 'done'); pulse(`n-${n}`); }
    else if (ev.kind === 'note' && /Attempting production/.test(t)) node('hosting', '', 'tries the live site');
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
const phaseLabel = (n) => (n ? `Step ${n} of ${PHASES.length} · ${PHASES[n - 1]}` : 'Ready');

let st;
function reset() {
  st = { count: 0, allowed: 0, denied: 0, negotiated: 0, revoked: 0, grants: new Map(), phase: 0 };
  $('#timeline').replaceChildren(el('li', 'empty', 'Starting…'));
  $('#grants tbody').replaceChildren((() => { const tr = el('tr', 'empty'); const td = el('td', '', 'No passes handed out yet.'); td.colSpan = 4; tr.append(td); return tr; })());
  for (const id of ['allowed', 'denied', 'negotiated', 'revoked']) $(`#n-${id}`).textContent = '0';
  $('#count').textContent = '';
  $('#hero-before').textContent = '—'; $('#hero-after').textContent = '—';
  $('#findings').replaceChildren(el('li', 'muted', '—')); $('#fix').textContent = ''; $('#fix').className = 'muted';
  $('#preview').replaceChildren('—'); $('#metrics').textContent = '—'; $('#metrics').className = 'muted'; $('#suggestions').replaceChildren();
  $('#checks').replaceChildren(...CHECKS.map((t) => { const li = el('li'); li.append(el('span', 'm', '·'), el('span', '', t)); return li; }));
  $('#dots').replaceChildren(...PHASES.map((t, i) => { const li = el('li', '', String(i + 1)); li.title = t; return li; }));
  $('#result').textContent = ''; $('#result').className = 'result';
  caption('Ready', 'Press “Run demo” to watch the manager and four helpers build a page, with AgentPass checking every move.', '', '');
  // diagram
  $('#flows').replaceChildren();
  for (const n of ['design', 'hosting', 'analytics', 'security']) {
    const g = document.getElementById(`n-${n}`); g.className.baseVal = `node dim${n === 'security' ? ' external' : ''}`;
    document.getElementById(`s-${n}`).textContent = n === 'security' ? 'not called in yet · may look, never edit' : 'not started yet';
    setBadge(`b-${n}`, '');
    const lock = document.getElementById(`l-${n}`); if (lock) lock.setAttribute('opacity', '0');
  }
  document.getElementById('n-lead').className.baseVal = 'node'; $('#s-lead').textContent = 'hires and directs the helpers'; setBadge('b-lead', '');
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
    el('td', '', (SHORT[g.holder] || (g.holder || '').replace('-agent', '')) + (id === 'hosting-preview' ? ' (test copy)' : '')),
    el('td', '', shortScope(g.actions || [])),
    el('td', '', plainResources(g.resources || [])),
    el('td', '', g.revoked ? 'taken back' : g.status || 'active'),
  );
}

function onWorkflowEvent(e) {
  const [cls, label] = KIND[e.kind] || ['info', e.kind];
  caption(undefined, headline(e), detailFor(e), `${e.agent} · ${e.kind}${e.code ? ` ${e.code}` : ''} · ${e.text}`);
  // Denials are already shown by the agent's own trace line (with the error code); only count them here.
  if (e.kind !== 'permission_denied') row('event', e.at, e.agent, [el('span', `tag ${cls}`, label), document.createTextNode(e.text)]);
  if (e.kind === 'authority_delegated') {
    const m = e.text.match(/Delegated to ([a-z-]+): (.+?) on (.+)$/);
    if (m) { upsertGrant(`${m[1]}`, { holder: m[1], actions: m[2].split(', '), resources: m[3].split(', '), status: 'active' }); st.allowed += 1; }
  }
  if (e.kind === 'permission_denied') st.denied += 1;
  if (e.kind === 'narrower_requested') st.negotiated += 1;
  if (e.kind === 'permission_granted') upsertGrant('hosting-preview', { holder: 'hosting-agent', actions: ['deploy.preview'], resources: ['preview'], status: 'active for 15 min' });
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
  if (e.kind === 'call' || e.kind === 'note') caption(undefined, undefined, plainTrace(e.agent, e.text), `${e.agent} · ${e.text}`);
}

function onOutputs(o) {
  $('#hero-before').textContent = o.before.hero;
  $('#hero-after').textContent = o.after.hero;
  const sec = o.security;
  if (sec && sec.findings) {
    $('#findings').replaceChildren(...sec.findings.map((f) => { const li = el('li'); li.append(el('span', `sev ${f.severity}`, f.severity), document.createTextNode(`${RULE[f.rule] || f.rule} — in ${fileName(f.file)}, line ${f.line}`)); return li; }));
    $('#fix').textContent = o.fix_applied ? 'The manager fixed the serious one: visitor-typed text is now made safe before it goes on the page (newsletter.ts).' : 'Fix not applied';
    $('#fix').className = o.fix_applied ? 'ok-text' : 'muted';
  }
  const h = o.hosting;
  if (h && h.deployment) {
    const a = el('a', '', h.deployment.url); a.href = h.deployment.url; a.target = '_blank'; a.rel = 'noopener';
    $('#preview').replaceChildren(a, el('div', 'prov', `Built and served on this computer; not a public website. The live site was blocked (${plainCode(h.production_attempt.code)}).`));
  } else if (h) { $('#preview').textContent = `Nothing published: ${h.failure?.reason || h.negotiation?.status || 'unknown'}`; }
  const an = o.analytics;
  if (an && an.summary) {
    $('#metrics').textContent = `${an.summary.page_views.toLocaleString()} visits · ${an.summary.signups} signups · ${(an.summary.conversion_rate * 100).toFixed(2)}% of visitors signed up · last ${an.summary.period.days} days`;
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
    const realRun = ev.authority !== 'MOCK';
    b.textContent = realRun ? 'running on: real AgentPass' : `running on: practice mock${ev.missing?.length ? ` · missing: ${ev.missing.join(', ')}` : ''}`;
    b.className = `badge ${realRun ? 'real' : 'mock'}`;
    b.title = realRun ? 'Every decision comes from the real AgentPass authority service' : 'A labeled stand-in for AgentPass; decisions are not the real service’s';
    upsertGrant('grant-root-lead', { holder: 'lead-agent', actions: ['repo.read', 'repo.write', 'deploy.preview', 'analytics.aggregate'], resources: ['src/**', 'package.json', 'preview', 'landing-page'], status: 'master pass from the owner' });
    caption(undefined, `A clean start${realRun ? ' on the real AgentPass' : ' on the practice mock'}: a fresh copy of the project, brand-new keys, and one master pass from the owner to the manager.`, 'Even the manager’s master pass has limits: it cannot publish to the live site or see individual visitors.', `authority ${ev.authority} · root grant: repo.read, repo.write, deploy.preview, analytics.aggregate on src/**, package.json`);
  } else if (ev.type === 'event') onWorkflowEvent(ev.event);
  else if (ev.type === 'trace') onTrace(ev);
  else if (ev.type === 'outputs') { onOutputs(ev.outputs); caption('Results', 'What the helpers actually made: the new headline, the security review, the test copy and the visitor numbers.', 'See “What the helpers produced” on the right.', ''); }
  else if (ev.type === 'check') {
    const li = $('#checks').children[ev.check.n - 1];
    if (li) { li.className = ev.check.pass ? 'seen pass' : 'seen fail'; li.querySelector('.m').textContent = ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
    caption('Checking', `Double-checking against the real files and events: ${ev.check.n} of ${CHECKS.length}.`, `${ev.check.pass ? '✓' : '✕'} ${CHECKS[ev.check.n - 1]}`, `${ev.check.pass ? 'PASS' : 'FAIL'} ${ev.check.title}: ${ev.check.detail}`);
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
    caption('Done', ev.passed ? `Every rule held: ${n} of ${CHECKS.length} checks passed.` : `Some checks failed: ${n} of ${CHECKS.length} passed.`, 'The helpers did real work, every “no” was real, and nothing in the project was reachable without a pass. Scroll the right-hand side for what they produced.', '');
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
    if (!r.ok) { caption('Could not start', (await r.json()).reason, '', ''); refresh(); }
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
