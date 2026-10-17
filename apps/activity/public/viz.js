// Animated view of the real DemoEvent stream. Real tool calls are turned
// into "beats" (caption + animated message between boxes) and played at a
// readable pace, or one at a time in step-through mode. Text is set with
// textContent / SVG text nodes only.
const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const usd = (c) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = [
  'The owner gives the buyer agent a $1,000 budget',
  'The buyer starts a helper agent with quote-only access',
  'The helper gets a price quote from the supplier',
  'Buying is blocked: the helper only has quote access',
  'The helper asks for $1,200; the buyer offers $900',
  'The helper buys within its $900 limit',
  'Peeking at the supplier’s margins is blocked',
  'Overspending and other tricks are blocked',
  'The buyer revokes access; the helper is locked out',
];

// Anchor points in the SVG's coordinate space.
const P = {
  ownerOut: [200, 132], buyerIn: [200, 176],
  buyer: [296, 219], gate: [500, 235], helper: [296, 354], supplier: [704, 235],
  helperUp: [244, 306], buyerDown: [244, 262], buyerDown2: [156, 262], helperUp2: [156, 306],
};

let st, queue, playing, waitNext, runDone, checks;

function reset() {
  st = { root: null, rootBudget: null, ask: null, offer: null, step: 0, quoted: false, accepted: false, bought: false };
  queue = []; checks = []; runDone = false;
  $('#flows').replaceChildren();
  $('#n-helper').classList.add('dim');
  $('#helper-sub').textContent = 'not started yet';
  setBadge('b-buyer', ''); setBadge('b-helper', '');
  $('#b-helper').classList.remove('revoked');
  $('#lock').setAttribute('opacity', '0');
  $('#vault').classList.remove('hit');
  caption('Ready', 'Press “Run demo” to watch two real agents negotiate.', '');
  $('#dots').replaceChildren(...STEPS.map((_, i) => li('', String(i + 1))));
  $('#story').replaceChildren(...STEPS.map((t) => { const x = li(''); x.append(span('m', '·'), span('', t)); return x; }));
  $('#result').textContent = ''; $('#result').className = 'result';
  $('#log').textContent = '';
  renderBudget();
}

function li(cls, text) { const e = document.createElement('li'); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
function span(cls, text) { const e = document.createElement('span'); if (cls) e.className = cls; e.textContent = text; return e; }

function caption(no, title, detail) {
  $('#step-no').textContent = no;
  $('#step-title').textContent = title;
  $('#step-detail').textContent = detail || '';
}

function setStep(n, detail) {
  if (n > st.step) {
    st.step = n;
    caption(`Step ${n} of ${STEPS.length}`, STEPS[n - 1], detail);
    [...$('#dots').children].forEach((d, i) => d.classList.toggle('now', i === n - 1));
    for (let i = 0; i < n; i++) $('#story').children[i].classList.add('seen');
  } else if (detail) {
    $('#step-detail').textContent = detail;
  }
}

function setBadge(id, text) {
  const g = document.getElementById(id);
  const t = g.querySelector('text');
  t.textContent = text;
  g.querySelector('rect').setAttribute('width', text ? String(t.getComputedTextLength() + 16) : '0');
}

function pulse(id) {
  const n = document.getElementById(id);
  n.classList.add('pulse');
  setTimeout(() => n.classList.remove('pulse'), 600);
}

/** Animates a labeled message along a polyline. kind: good | warn | bad. */
async function send(points, kind, label, opts = {}) {
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
  const duration = Math.max(650, Math.min(1300, total * 2.4));
  const start = performance.now();
  await new Promise((resolve) => {
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      let d = e * total, x = points[0][0], y = points[0][1];
      for (const s of segs) {
        if (d <= s.len) { x = s.x1 + (s.x2 - s.x1) * (d / s.len); y = s.y1 + (s.y2 - s.y1) * (d / s.len); break; }
        d -= s.len; x = s.x2; y = s.y2;
      }
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y));
      pill.setAttribute('transform', `translate(${x + 12} ${y - 30})`);
      if (t < 1) requestAnimationFrame(frame); else resolve();
    }
    requestAnimationFrame(frame);
  });
  if (opts.burstAt) {
    const b = document.createElementNS(SVG, 'text');
    b.setAttribute('class', 'burst'); b.setAttribute('x', String(opts.burstAt[0] - 9)); b.setAttribute('y', String(opts.burstAt[1] + 9));
    b.textContent = '✕';
    $('#flows').append(b);
    setTimeout(() => b.remove(), 900);
  }
  await sleep(opts.hold ?? 450);
  g.style.transition = 'opacity .35s'; g.style.opacity = '0';
  setTimeout(() => g.remove(), 400);
}

const path = (...names) => names.map((n) => P[n]);

// ---- turning real calls into beats -------------------------------------

function beat(step, detail, run) { queue.push({ step, detail, run }); play(); }

function onCall(e) {
  const a = e.args || {}, d = e.data || {}, ok = e.status === 'OK';
  const helper = e.agent === 'sourcing-agent', buyer = e.agent === 'buyer-agent';

  if (buyer && e.tool === 'get_my_grants' && ok && st.rootBudget === null) {
    const root = (d.grants || []).find((g) => g.id === st.root) || (d.grants || []).find((g) => !g.parent_grant_id);
    if (!root) return;
    st.rootBudget = root.scope.total_budget_cents;
    const budget = st.rootBudget;
    beat(1, `Root grant ${root.id}`, async () => {
      pulse('n-owner');
      await send(path('ownerOut', 'buyerIn'), 'good', `${usd(budget)} budget`);
      setBadge('b-buyer', `${usd(budget)} budget`);
      st.shownRoot = budget; renderBudget();
    });
  } else if (buyer && e.tool === 'delegate_authority' && ok) {
    beat(2, 'Delegated through AgentPass: can ask for prices, can’t spend', async () => {
      await send(path('buyer', 'gate', 'helper'), 'good', 'quote-only pass');
      setBadge('b-helper', 'quote-only · $0');
    });
  } else if (helper && e.tool === 'execute_action' && a.action === 'supplier.quote.request' && ok && !st.quoted) {
    st.quoted = true;
    const total = d.total_cents;
    beat(3, `${usd(total)} for 500 units. The supplier sets the price, not the agent.`, async () => {
      await send(path('helper', 'gate', 'supplier'), 'good', 'price for 500?');
      pulse('n-supplier');
      await send(path('supplier', 'gate', 'helper'), 'good', `quote ${usd(total)}`);
    });
  } else if (helper && e.status === 'AUTHORITY_REQUIRED') {
    beat(4, 'AgentPass says exactly what’s missing: “purchase” rights. Next step: request authority.', async () => {
      await send(path('helper', 'gate'), 'warn', `buy for ${usd(85000)}`, { hold: 250 });
      pulse('n-gate');
      await send(path('gate', 'helper'), 'warn', 'needs purchase rights');
    });
  } else if (helper && e.tool === 'request_authority' && ok) {
    st.ask = a.requested_scope?.total_budget_cents;
    const ask = st.ask;
    beat(5, `Asked for ${usd(ask)}…`, async () => {
      await send(path('helperUp', 'buyerDown'), 'warn', `may I spend ${usd(ask)}?`);
    });
  } else if (buyer && e.tool === 'respond_authority_request' && ok) {
    st.offer = a.offered_scope?.total_budget_cents;
    const offer = st.offer, ask = st.ask;
    beat(5, `Asked ${usd(ask ?? 0)} → buyer offered ${usd(offer)} (its own limit for helpers)`, async () => {
      await send(path('buyerDown2', 'helperUp2'), 'good', `you can have ${usd(offer)}`);
      st.shownDelegated = offer; renderBudget();
    });
  } else if (helper && e.tool === 'accept_authority_offer' && ok) {
    st.accepted = true;
    const cap = d.scope?.total_budget_cents;
    beat(5, `Accepted: a new ${usd(cap)} purchase pass, nothing more`, async () => {
      setBadge('b-helper', `purchase · ${usd(cap)}`); pulse('n-helper'); await sleep(500);
    });
  } else if (helper && e.tool === 'execute_action' && a.action === 'supplier.purchase.execute' && ok && d.amount_cents) {
    st.bought = true;
    const amt = d.amount_cents;
    beat(6, `Paid ${usd(amt)} (simulated). AgentPass charged both the helper’s pass and the owner’s budget.`, async () => {
      await send(path('helper', 'gate', 'supplier'), 'good', `buy · ${usd(amt)}`);
      pulse('n-supplier');
      await send(path('supplier', 'gate', 'helper'), 'good', 'receipt');
      st.shownSpent = (st.shownSpent || 0) + amt; renderBudget();
    });
  } else if (helper && a.action === 'supplier.purchase.execute' && !ok && e.code === 'BUDGET_EXCEEDED' && st.accepted && !st.bought) {
    st.bought = true; // the attempt is the story's step 6 either way
    beat(6, 'Refused: the owner’s budget doesn’t have enough left', async () => {
      await send(path('helper', 'gate'), 'bad', 'buy', { burstAt: P.gate });
    });
  } else if (helper && a.action === 'supplier.margin.read') {
    beat(7, ok ? 'Not blocked!' : 'The supplier’s own rules refused. No cost or margin number left the supplier.', async () => {
      await send(path('helper', 'gate', 'supplier'), 'bad', 'show me your margins', { hold: 200 });
      const v = $('#vault'); v.classList.remove('hit'); void v.getBBox(); v.classList.add('hit');
      await send(path('supplier', 'gate', 'helper'), 'bad', 'private');
    });
  } else if (helper && !ok && (e.code === 'BUDGET_EXCEEDED' || e.code === 'OUTSIDE_PARENT_SCOPE' || e.code === 'INVALID_CALLER' || (e.code === 'INVALID_REQUEST' && a.agent_id))) {
    const label = { BUDGET_EXCEEDED: 'buy again', OUTSIDE_PARENT_SCOPE: 'give myself $1,200', INVALID_CALLER: 'approve my own request', INVALID_REQUEST: 'pretend to be the buyer' }[e.code];
    const why = { BUDGET_EXCEEDED: 'over budget', OUTSIDE_PARENT_SCOPE: 'can’t exceed its pass', INVALID_CALLER: 'only the buyer approves', INVALID_REQUEST: 'identity comes from its key' }[e.code];
    beat(8, `“${label}” → refused (${why})`, async () => {
      await send(path('helper', 'gate'), 'bad', label, { burstAt: P.gate, hold: 200 });
    });
  } else if (buyer && e.tool === 'revoke_authority' && ok) {
    beat(9, 'The buyer pulls the helper’s pass…', async () => {
      await send(path('buyer', 'gate'), 'warn', 'revoke helper');
      $('#b-helper').classList.add('revoked'); setBadge('b-helper', 'revoked');
      $('#lock').setAttribute('opacity', '1');
    });
  } else if (helper && e.code === 'GRANT_REVOKED') {
    beat(9, 'Even with its old pass, every new request is refused.', async () => {
      await send(path('helper', 'gate'), 'bad', 'buy', { burstAt: P.gate });
    });
  }
}

function onProcess(ev) {
  if (ev.agent !== 'sourcing-agent' || ev.kind !== 'started') return;
  const pid = ev.pid;
  beat(2, 'The helper runs as its own program with its own identity, not the buyer’s keys', async () => {
    $('#n-helper').classList.remove('dim');
    $('#helper-sub').textContent = `own process · pid ${pid}`;
    pulse('n-helper'); await sleep(500);
  });
}

// ---- player ----------------------------------------------------------------

async function play() {
  if (playing) return;
  playing = true;
  while (queue.length) {
    const b = queue.shift();
    if ($('#stepmode').checked) {
      $('#next').disabled = false;
      await new Promise((r) => { waitNext = r; });
      $('#next').disabled = true;
    }
    setStep(b.step, b.detail);
    await b.run();
    await sleep($('#stepmode').checked ? 0 : 350);
  }
  playing = false;
  if (runDone) finishRun();
}

function finishRun() {
  const dots = [...$('#dots').children], story = [...$('#story').children];
  dots.forEach((d) => d.classList.remove('now'));
  for (const c of checks) {
    const i = c.step - 1;
    if (!dots[i]) continue;
    dots[i].className = c.pass ? 'pass' : 'fail'; dots[i].textContent = c.pass ? '✓' : '✕';
    story[i].classList.add('seen', c.pass ? 'pass' : 'fail');
    story[i].querySelector('.m').textContent = c.pass ? '✓' : '✕';
  }
  const passed = checks.filter((c) => c.pass).length;
  $('#result').className = `result ${passed === STEPS.length ? 'pass' : 'fail'}`;
  $('#result').textContent = `${passed} of ${STEPS.length} checks passed`;
  caption('Done', passed === STEPS.length ? 'Every rule held.' : 'Some checks failed: see the technical log.', `${passed} of ${STEPS.length} checks passed against real agents.`);
  refresh();
}

function renderBudget() {
  const root = st?.shownRoot ?? null, del = st?.shownDelegated ?? 0, spent = st?.shownSpent ?? 0;
  const pct = (v) => (root ? `${Math.min(100, (v / root) * 100)}%` : '0');
  $('#bar-delegated').style.width = pct(del);
  // spent sits inside the delegated band; width is relative to that band
  $('#bar-spent').style.width = del ? `${Math.min(100, (spent / del) * 100)}%` : '0';
  const set = (id, v) => { $(`#v-${id}`).textContent = v; const t = $(`#t-${id}`); if (t) t.textContent = v; };
  set('root', root ? usd(root) : '—');
  set('delegated', del ? usd(del) : '—');
  set('spent', spent ? usd(spent) : '—');
  $('#v-left').textContent = root ? usd(root - spent) : '—';
}

function log(line) { $('#log').textContent += line + '\n'; }

function onEvent(env) {
  const ev = env.event;
  if (ev.type === 'meta') {
    st.root = ev.root || null;
  } else if (ev.type === 'process') {
    onProcess(ev);
  } else if (ev.type === 'trace') {
    const e = ev.event;
    if (e.kind === 'call') { onCall(e); log(`${e.at.slice(11, 19)}  ${e.agent.padEnd(15)} ${e.tool}${e.args?.action ? ` (${e.args.action})` : ''} → ${e.status}${e.code ? ` ${e.code}` : ''}`); }
    else log(`${e.at.slice(11, 19)}  ${e.agent.padEnd(15)} » ${e.text}`);
  } else if (ev.type === 'runner') {
    log(`${ev.at.slice(11, 19)}  runner          ${ev.text}`);
  } else if (ev.type === 'check') {
    checks.push(ev.check);
  } else if (ev.type === 'done') {
    runDone = true;
    if (!playing && !queue.length) finishRun();
  }
}

async function refresh() {
  const s = await fetch('/api/status').then((r) => r.json());
  $('#run').disabled = s.running || playing;
  const hosted = $('#where-hosted');
  hosted.disabled = !s.hostedConfigured;
  if (hosted.disabled && hosted.checked) document.querySelector('input[value="local"]').checked = true;
}

function budgetTip(ev) {
  const tip = $('#tip'), track = $('#budget .track');
  const root = st.shownRoot;
  if (!root) { tip.hidden = true; return; }
  const r = track.getBoundingClientRect();
  const v = ((ev.clientX - r.left) / r.width) * root;
  const del = st.shownDelegated || 0, spent = st.shownSpent || 0;
  tip.textContent = v <= spent ? `Spent: ${usd(spent)}` : v <= del ? `Given to helper, unspent: ${usd(del - spent)}` : `Owner’s budget, not delegated: ${usd(root - del)}`;
  tip.style.left = `${Math.min(Math.max(0, ev.clientX - r.left - 40), r.width - 160)}px`;
  tip.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  reset();
  $('#stepmode').addEventListener('change', () => { $('#next').hidden = !$('#stepmode').checked; if (!$('#stepmode').checked && waitNext) waitNext(); });
  $('#next').addEventListener('click', () => waitNext?.());
  document.addEventListener('keydown', (k) => { if ($('#stepmode').checked && (k.key === 'ArrowRight' || k.key === ' ') && waitNext) { k.preventDefault(); waitNext(); } });
  $('#budget .track').addEventListener('mousemove', budgetTip);
  $('#budget .track').addEventListener('mouseleave', () => { $('#tip').hidden = true; });
  $('#run').addEventListener('click', async () => {
    const mode = document.querySelector('input[name="where"]:checked').value;
    if (mode === 'hosted' && !confirm('Run live on Manufact? This makes a real simulated $850 purchase.')) return;
    $('#run').disabled = true;
    const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    if (!r.ok) { caption('Could not start', (await r.json()).reason, ''); refresh(); }
  });
  const source = new EventSource('/api/events');
  source.addEventListener('reset', () => reset());
  source.onmessage = (m) => onEvent(JSON.parse(m.data));
  refresh();
});
