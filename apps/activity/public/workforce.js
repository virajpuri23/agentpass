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
  '$1,000 wallet; helper wallets are slices of it', 'Helpers bought what they needed, with receipts', 'Overspending was blocked',
  'Publishing asked for more; the manager gave less; it bought', 'Numbers’ request for people’s records was refused', 'Spend within $1,000, matches AgentPass; wallets died with the passes',
];
const PHASES = ['The master pass and the wallet', 'Design', 'Outside security reviewer', 'Publishing', 'Numbers', 'Passes and wallets taken back'];
const CHECK_PHASE = [2, 2, 3, 3, 4, 4, 4, 4, 5, 5, 6, 6, 2, 5, 4, 4, 5, 6];
const SKU = { 'stock-photo': ['stock photo', 'stock photos'], 'audit-hour': ['security review hour', 'security review hours'], 'hosting-slot': ['hosting slot', 'hosting slots'], 'data-query': ['data query', 'data queries'], 'raw-dataset': ['a raw export of people’s records', 'a raw export of people’s records'] };
const sku = (id, n = 2) => (SKU[id] ? SKU[id][Number(n) === 1 ? 0 : 1] : id);
const money = (text, re) => { const m = text.match(re); return m ? m[1] : ''; };
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
  vendor: [564, 352],
};
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

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
    case 'authority_delegated': { const m = e.text.match(/^Delegated to ([a-z-]+)/); return m && m[1] === 'security-agent' ? 'An outside security reviewer joins, with a look-only pass.' : `The manager gives ${m ? who(m[1]) : 'a helper'} a smaller pass.`; }
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
    case 'authority_revoked': return 'Job done. The manager takes every pass and wallet back.';
    case 'wallet_delegated': { const m = e.text.match(/^Gave ([a-z]+)-agent a (\$[\d,.]+) wallet/); return m ? `The manager gives ${who(`${m[1]}-agent`)} a small pass and a ${m[2]} wallet.` : 'The manager hands out a wallet.'; }
    case 'purchase_made': { const m = e.text.match(/^Bought (\d+) × ([a-z-]+) for (\$[\d,.]+)/); if (!m) return `${cap(w)} buys something.`; return e.agent === 'lead-agent' ? `The manager pays the outside firm’s invoice: ${m[3]}.` : `${cap(w)} buys ${m[1]} ${sku(m[2], m[1])} for ${m[3]}.`; }
    case 'budget_exceeded': { const m = e.text.match(/refused (\$[\d,.]+) for (\d+) × ([a-z-]+)/); return m ? `${cap(w)} tries to spend ${m[1]} on ${m[2]} ${sku(m[3], m[2])}. Blocked.` : `${cap(w)} tries to overspend. Blocked.`; }
    case 'budget_requested': { const m = e.text.match(/for (\$[\d,.]+) more/); return `${cap(w)} asks the manager for ${m ? m[1] : 'more money'}.`; }
    case 'budget_countered': { const m = e.text.match(/^Counteroffered (\$[\d,.]+) to ([a-z]+)-agent \(asked (\$[\d,.]+)\)/); return m ? `The manager says: ${m[1]}, not ${m[3]}.` : 'The manager offers less.'; }
    case 'budget_rejected': { const m = e.text.match(/^Rejected ([a-z]+)-agent's request for (\$[\d,.]+)/); return m ? `The manager says no to ${who(`${m[1]}-agent`)}’s ${m[2]} request.` : 'The manager says no.'; }
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
      return m[1] === 'security-agent' ? 'From another company. It may read, never edit; it gets no wallet, so the manager pays its invoice.' : `It may ${shortScope(m[2].split(', ')).replace(' + ', ' and ')}, in ${where(m[3].split(', '))}. Nothing else.`;
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
    case 'authority_revoked': return 'The old passes and wallets stop working; the helpers’ keys are disabled.';
    case 'wallet_delegated': { m = e.text.match(/wallet for ([a-z-]+) \(of the (\$[\d,.]+) root wallet\)/); return m ? `Only its own files; only ${sku(m[1])}. Both are slices of the manager’s own.` : ''; }
    case 'purchase_made': return e.agent === 'lead-agent' ? 'Outside companies never get a wallet from inside; the manager pays from its own.' : 'AgentPass checked the wallet first, then the vendor was paid from it.';
    case 'budget_exceeded': return 'More than the wallet holds. AgentPass refuses; nothing is spent.';
    case 'budget_requested': { m = e.text.match(/"(.+)"$/); return m ? `Its reason: “${m[1]}”` : ''; }
    case 'budget_countered': { m = e.text.match(/\): (.+)$/); return m ? `${cap(m[1])}.` : ''; }
    case 'budget_rejected': { m = e.text.match(/: (.+)$/); return m ? `${cap(m[1])}.` : ''; }
    default: return '';
  }
}
function caption(no, title, detail) {
  if (no !== undefined) $('#step-no').textContent = no;
  if (title !== undefined) $('#story').textContent = title;
  $('#story-detail').textContent = detail || '';
}

// ---- Beats: the run streams ~70 real lines; only these pause the screen. Everything else still updates
// badges and the technical log instantly, so nothing is hidden, but a Normal run fits in ~25 seconds. ----
function isBeat(env) {
  const ev = env.event;
  if (ev.type === 'meta') return true;
  if (ev.type !== 'event') return false;
  const e = ev.event, t = e.text;
  switch (e.kind) {
    case 'note': return true;
    case 'authority_delegated': return /^Delegated to security-agent/.test(t);
    case 'wallet_delegated': case 'budget_requested': case 'budget_countered': case 'budget_rejected': case 'deployment_completed': case 'analytics_analyzed': return true;
    case 'budget_exceeded': return true;
    case 'purchase_made': return e.agent === 'design-agent' || e.agent === 'hosting-agent';
    case 'permission_denied': return (e.agent === 'design-agent' && /\.env/.test(t)) || (e.agent === 'security-agent' && /repo\.write/.test(t)) || /deploy\.production/.test(t);
    case 'authority_revoked': { if (!st.firstRevoke) st.firstRevoke = e; return st.firstRevoke === e; } // the first revocation is the beat; the rest land silently
    default: return false;
  }
}

// ---- Playback queue ----
const SPEED = { slow: 2.2, normal: 1, instant: 0 };
// catchUp: the buffer the server replays on (re)connect is a finished or in-flight run; it renders instantly, only live events are paced.
const play = { speed: 'normal', queue: [], pumping: false, timer: null, startedAt: 0, catchUp: false };
const pace = () => (play.catchUp ? 0 : SPEED[play.speed]);
function delayFor(env) {
  const f = pace();
  if (!f) return 0;
  const t = env.event.type;
  const base = t === 'event' ? (isBeat(env) ? 1250 : 0) : t === 'outputs' ? 400 : t === 'check' ? 50 : t === 'meta' ? 800 : 0;
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
  text.textContent = `${kind === 'good' ? '✓' : kind === 'bad' ? '✕' : kind === 'money' ? '$' : '!'} ${label}`;
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
  const beat = isBeat(env);
  const go = beat ? send : () => {};
  if (ev.type === 'meta') {
    pulse('n-owner');
    go([P.owner, P.leadTop], 'good', 'master pass');
    setBadge('b-lead', 'master pass');
    node('lead', '', 'holds the master pass');
  } else if (ev.type === 'event') {
    const e = ev.event, n = NODE[e.agent];
    switch (e.kind) {
      case 'note': { pulse('n-lead'); const m = e.text.match(/Budget: \$([\d,.]+) root wallet/); if (m) { st.root = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100); go([P.owner, P.leadTop], 'money', `wallet $${m[1]}`); setBadge('w-lead', `$${m[1]} wallet`); } break; }
      case 'subagent_created': node(n, '', 'has its own key'); pulse(`n-${n}`); break;
      case 'external_contacted': node('security', '', 'another company · own key'); pulse('n-security'); break;
      case 'authority_delegated': {
        const m = e.text.match(/^Delegated to ([a-z]+)-agent: (.+?) on (.+)$/);
        if (!m) break;
        const w = m[1], actions = m[2].split(', ');
        if (w === 'security') go([P.lead, P.gate, P.security], 'good', 'look-only pass');
        setBadge(`b-${w}`, w === 'security' ? 'look only' : shortScope(actions));
        node(w, '');
        break;
      }
      case 'narrower_requested': go([P.hostingTop, P.leadBottom], 'warn', 'may I do the test copy instead?'); node('hosting', '', 'asking for less'); break;
      case 'permission_granted': go([P.leadBottom, P.hostingTop], 'good', 'test copy only · 15 min'); setBadge('b-hosting', 'read + test copy · 15 min'); break;
      case 'deployment_completed': pulse('r-preview'); node('hosting', 'done', 'test copy is live'); break;
      case 'analytics_analyzed': pulse('r-agg'); node('analytics', 'done', 'totals worked out'); break;
      case 'fix_applied': go([P.lead, P.gate, P.repo], 'good', 'fixes the bug'); node('lead', '', 'fixed the security bug'); break;
      case 'authority_revoked': {
        const m = e.text.match(/Revoked ([a-z-]+)'s (grant|wallet)/);
        if (!m) break;
        const w = m[1].replace(/-(preview|topup)$/, '');
        if (m[2] === 'wallet') {
          go([P.lead, P.gate], 'warn', `take back ${cap(who(`${w}-agent`))}’s ${m[1].endsWith('-topup') ? 'top-up' : 'wallet'}`, { hold: 150 });
          setBadge(`w-${w}`, 'wallet taken back', true);
          break;
        }
        go([P.lead, P.gate], 'warn', `take back ${cap(who(`${w}-agent`))}’s ${m[1].endsWith('-preview') ? 'test-copy pass' : 'pass'}`, { hold: 150 });
        setBadge(`b-${w}`, 'taken back', true);
        node(w, 'revoked', w === 'security' ? 'pass taken back' : 'key disabled');
        const lock = document.getElementById(`l-${w}`);
        if (lock) lock.setAttribute('opacity', '1');
        break;
      }
      case 'wallet_delegated': {
        const m = e.text.match(/^Gave ([a-z]+)-agent a (\$[\d,.]+) wallet/);
        if (!m) break;
        st.wallet[m[1]] = { total: m[2], spent: 0 };
        go([P.leadBottom, P[`${m[1]}Top`]], 'money', `pass + ${m[2]} wallet`);
        setBadge(`w-${m[1]}`, `${m[2]} wallet`);
        break;
      }
      case 'purchase_made': {
        const m = e.text.match(/^Bought (\d+) × ([a-z-]+) for \$([\d,.]+)/);
        if (!m) break;
        const cents = Math.round(parseFloat(m[3].replace(/,/g, '')) * 100);
        st.spent += cents;
        go([n === 'lead' ? P.lead : P[n], P.gate, P.vendor], 'money', n === 'lead' ? `pays invoice $${m[3]}` : `buys ${m[1]} ${sku(m[2], m[1])} · $${m[3]}`);
        pulse('n-vendor');
        if (n !== 'lead' && st.wallet[n]) { st.wallet[n].spent += cents; setBadge(`w-${n}`, `${st.wallet[n].total} · spent ${usd(st.wallet[n].spent)}`); }
        if (st.root) setBadge('w-lead', `${usd(st.root)} · ${usd(st.root - st.spent)} left`);
        break;
      }
      case 'budget_exceeded': {
        const m = e.text.match(/refused (\$[\d,.]+)/);
        go([P[n], P.gate], 'bad', `spend ${m ? m[1] : 'more'}`, { burstAt: P.gate });
        setTimeout(() => pulse(`n-${n}`), 450 * (pace() || 1));
        break;
      }
      case 'budget_requested': { const m = e.text.match(/for (\$[\d,.]+) more/); go([P[`${n}Top`], P.leadBottom], 'warn', `may I have ${m ? m[1] : 'more'}?`); node(n, '', 'asking for money'); break; }
      case 'budget_countered': {
        const m = e.text.match(/^Counteroffered (\$[\d,.]+) to ([a-z]+)-agent/);
        if (!m) break;
        go([P.leadBottom, P[`${m[2]}Top`]], 'money', `${m[1]}, no more`);
        if (st.wallet[m[2]]) { const add = Math.round(parseFloat(m[1].replace(/[$,]/g, '')) * 100); st.wallet[m[2]].total = usd(Math.round(parseFloat(st.wallet[m[2]].total.replace(/[$,]/g, '')) * 100) + add); setBadge(`w-${m[2]}`, `${st.wallet[m[2]].total} · spent ${usd(st.wallet[m[2]].spent)}`); }
        break;
      }
      case 'budget_rejected': { const m = e.text.match(/^Rejected ([a-z]+)-agent/); if (m) { go([P.leadBottom, P[`${m[1]}Top`]], 'bad', 'no'); node(m[1], '', 'request refused'); } break; }
    }
  } else if (ev.type === 'trace') {
    const n = NODE[ev.agent];
    if (n && ev.kind === 'result') node(n, 'done');
    else if (n && ev.kind === 'note' && /Attempting production/.test(ev.text)) node('hosting', '', 'tries the live site');
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
    if (e.kind === 'wallet_delegated' || e.kind === 'budget_countered' || e.kind === 'budget_rejected') { const m = e.text.match(/([a-z]+)-agent/); return m ? PHASE_OF_AGENT[`${m[1]}-agent`] || 0 : 0; }
    if (e.kind === 'purchase_made' && e.agent === 'lead-agent') return 3;
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
  st = { count: 0, phase: 0, root: 0, spent: 0, wallet: {}, firstRevoke: null };
  $('#timeline').replaceChildren(el('li', 'empty', 'Press “Run demo”.'));
  $('#count').textContent = '';
  for (const id of ['hero', 'security', 'preview', 'metrics']) $(`#${id}`).textContent = '—';
  $('#money').replaceChildren('—', el('ul', 'ledger')); $('#money ul').id = 'ledger';
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
    if (n !== 'security') setBadge(`w-${n}`, '');
    const lock = document.getElementById(`l-${n}`); if (lock) lock.setAttribute('opacity', '0');
  }
  document.getElementById('n-lead').className.baseVal = 'node'; $('#s-lead').textContent = 'directs the helpers'; setBadge('b-lead', ''); setBadge('w-lead', '');
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
  if (isBeat({ event: { type: 'event', event: e } })) caption(undefined, headline(e), detailFor(e));
  row('event', e.at, e.agent, [el('span', `tag ${/denied|exceeded|rejected/.test(e.kind) ? 'bad' : 'ok'}`, e.kind + (e.code ? ` ${e.code}` : '')), document.createTextNode(e.text)]);
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
  const b = o.budget;
  if (b) {
    const list = el('ul', 'ledger');
    list.id = 'ledger';
    for (const l of b.ledger) list.append(el('li', '', `${l.agent === 'lead-agent' ? 'Manager' : cap(who(l.agent))}: ${l.quantity} ${sku(l.sku_id, l.quantity)}, ${usd(l.amount_cents)}`));
    for (const t of b.topups) list.append(el('li', '', `${cap(who(t.agent))} asked for ${usd(t.requested_cents)} more: ${t.decision === 'COUNTEROFFER' ? `got ${usd(t.offered_cents)}` : 'refused'}`));
    $('#money').replaceChildren(`${usd(b.root_cents)} wallet · ${usd(b.spent_cents)} spent · ${b.remaining_cents === null ? '?' : usd(b.remaining_cents)} left (AgentPass’s own ledger)`, list);
  }
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
    if (li) { li.className = ev.check.skipped ? 'seen skip' : ev.check.pass ? 'seen pass' : 'seen fail'; li.querySelector('.m').textContent = ev.check.skipped ? '–' : ev.check.pass ? '✓' : '✕'; li.title = ev.check.detail; }
    caption('Checking', `Checking ${ev.check.n} of ${CHECKS.length}`, `${ev.check.skipped ? '– not run on the practice mock:' : ev.check.pass ? '✓' : '✕'} ${CHECKS[ev.check.n - 1]}`);
  } else if (ev.type === 'done') {
    const n = $('#checks').querySelectorAll('.pass').length, skipped = $('#checks').querySelectorAll('.skip').length;
    const total = CHECKS.length - skipped;
    const shown = play.startedAt ? ` · ${mmss(performance.now() - play.startedAt)} on screen` : '';
    $('#result').className = `result ${ev.passed ? 'pass' : 'fail'}`;
    $('#result').textContent = `${n} of ${total} checks passed${skipped ? ` (${skipped} not run on the mock)` : ''}${shown}`;
    const dots = [...$('#dots').children];
    dots.forEach((d, i) => {
      d.classList.remove('now');
      const mine = [...$('#checks').children].filter((_, j) => CHECK_PHASE[j] === i + 1);
      const ok = i === 0 ? ev.passed : mine.length > 0 && mine.every((li) => li.classList.contains('pass') || li.classList.contains('skip'));
      d.className = ok ? 'pass' : 'fail'; d.textContent = ok ? '✓' : '✕';
    });
    caption('Done', ev.passed ? `Every rule held: ${n} of ${total}.` : `Some checks failed: ${n} of ${total} passed.`, 'Every ✓, ✕ and $ you saw was a real AgentPass decision.');
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
