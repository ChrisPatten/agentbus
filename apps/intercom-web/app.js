// Intercom web app: wires the socket, state and dial screens together.
import { render } from './screens.js';
import { IntercomSocket, store, apiUrl } from './socket.js';
import { parsePairInput, replyIsFresh, glanceOf } from './logic.js';
import { runDemo, STEPS } from './demo.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demoMode = params.has('demo');
const TZ_FALLBACK = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const REPLY_TIMEOUT_MS = 60000;
const DONE_MS = 2200;
const DONE_WORDS = ['Noted, and filed.', 'Very good.', 'Consider it handled.', 'All done.'];

const S = {
  pair: loadPair(), conn: 'offline', offlineSince: Date.now(), activity: { state: 'idle', status_text: null },
  reply: null, expanded: false, doneUntil: 0, doneWord: DONE_WORDS[0], calendar: null, sentAt: 0, pairError: '', lastReplyId: null,
};
let sock = null;
let lastHtml = '';
let replyTimer = null;
let wakeLock = null;

function loadPair() {
  try { const p = JSON.parse(store.get('intercom.pair') || 'null'); return p && p.token ? p : null; } catch { return null; }
}

/* ---------- sizing ---------- */
function applySize() {
  const large = store.get('intercom.large') === '1';
  const wrap = document.querySelector('.stagewrap');
  let dial = 268;
  if (large) {
    const w = (wrap.clientWidth || document.documentElement.clientWidth - 32);
    const h = wrap.clientHeight || w;
    dial = Math.floor(Math.min(w, h) * 466 / 506);
  }
  document.documentElement.style.setProperty('--dial', `${dial}px`);
  document.documentElement.style.setProperty('--s', String(dial / 466));
  $('size').textContent = large ? 'True size' : 'Large';
}

/* ---------- rendering ---------- */
function show(name, props) {
  const html = render(name, props);
  if (html === lastHtml) return;
  lastHtml = html;
  const face = $('face');
  face.innerHTML = html;
  face.classList.remove('fade');
  void face.offsetWidth;
  face.classList.add('fade');
}

function computeView(now = new Date()) {
  if (!S.pair) return ['pairing', { error: S.pairError }];
  if (S.conn !== 'online' && !S.reply && Date.now() - S.offlineSince > 1500) return ['offline', { connecting: S.conn === 'connecting' }];
  if (S.reply) return ['reply', { reply: S.reply, expanded: S.expanded }];
  const a = S.activity;
  if (a.state === 'running' || a.state === 'queued') return ['working', { status: a.status_text }];
  if (S.sentAt && Date.now() - S.sentAt < 6000) return ['working', { status: 'Sent' }];
  if (Date.now() < S.doneUntil) return ['done', { word: S.doneWord }];
  const cal = S.calendar;
  return ['idle', { events: cal ? cal.events : [], now, tz: (cal && cal.tz) || TZ_FALLBACK, calendarKnown: !!cal }];
}

function update() {
  if (demoMode) return;
  const [name, props] = computeView();
  show(name, props);
  const labels = { online: 'Connected', connecting: 'Connecting', offline: 'Offline' };
  const dot = S.pair ? S.conn : 'idle';
  $('dot').className = `dot ${dot}`;
  $('dotlabel').textContent = S.pair ? labels[S.conn] : 'Not paired';
  const n = sock ? sock.outbox.size : 0;
  if (!$('note').dataset.sticky) $('note').textContent = n && S.conn !== 'online' ? `${n} waiting to send` : '';
  const pairing = !S.pair;
  $('input').placeholder = pairing ? 'Paste pairing code' : 'Message Peggy';
  $('go').textContent = pairing ? 'Pair' : 'Send';
}
const later = (ms) => setTimeout(update, ms);

function note(text, ms = 4000) {
  const n = $('note');
  n.textContent = text; n.dataset.sticky = '1';
  setTimeout(() => { delete n.dataset.sticky; update(); }, ms);
}

/* ---------- reply lifecycle ---------- */
function armReplyTimer() {
  clearTimeout(replyTimer);
  replyTimer = setTimeout(dismissReply, REPLY_TIMEOUT_MS);
}
function dismissReply() {
  clearTimeout(replyTimer);
  S.reply = null; S.expanded = false;
  update();
}

/* ---------- socket events ---------- */
function onEvent(name, d) {
  switch (name) {
    case 'activity':
      S.activity = { state: d.state, status_text: d.status_text || null };
      if (d.state === 'running' || d.state === 'queued') S.sentAt = 0;
      break;
    case 'interaction':
      if (d.state === 'closed') {
        S.doneWord = DONE_WORDS[Math.floor(Math.random() * DONE_WORDS.length)];
        if (!S.reply) { S.doneUntil = Date.now() + DONE_MS; later(DONE_MS + 50); }
      }
      break;
    case 'reply':
      if (d.message_id && d.message_id === S.lastReplyId) break;
      S.lastReplyId = d.message_id;
      if (!replyIsFresh(d, Date.now())) break;
      S.reply = d; S.expanded = false; S.sentAt = 0; armReplyTimer();
      break;
    case 'calendar': S.calendar = d; break;
    default: break;
  }
  update();
}

function startSocket() {
  if (!S.pair) return;
  sock = new IntercomSocket({
    token: S.pair.token,
    handlers: {
      onState(st) { if (S.conn === 'online' && st !== 'online') S.offlineSince = Date.now(); S.conn = st; update(); if (st !== 'online') later(1600); },
      onEvent,
      onReset() { S.reply = null; S.calendar = null; S.activity = { state: 'idle', status_text: null }; },
      onAck(f) { if (f.status === 'rejected') { S.sentAt = 0; note(`Not sent: ${f.reason || 'rejected'}`); } },
      onUnauthorized() { unpair('Pairing was rejected. Open a new pairing link.'); },
      onError(f) { if (f.code === 'unauthorized') unpair('Pairing was rejected. Open a new pairing link.'); },
    },
  });
  sock.start();
  fetchToday();
}

async function fetchToday() {
  if (!S.pair) return;
  try {
    const r = await fetch(apiUrl('api/v1/intercom/today'), { headers: { Authorization: `Bearer ${S.pair.token}` } });
    if (r.ok) { const c = await r.json(); if (!S.calendar || (c.generated_at || '') >= (S.calendar.generated_at || '')) S.calendar = c; update(); }
  } catch { /* offline: fine */ }
}

/* ---------- pairing ---------- */
async function pair(code) {
  if (!code) { S.pairError = 'Enter the pairing code'; update(); return; }
  S.pairError = 'Pairing…'; update();
  try {
    const r = await fetch(apiUrl('api/v1/intercom/pair'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (r.ok) {
      const j = await r.json();
      S.pair = { surface_id: j.surface_id, token: j.token };
      store.set('intercom.pair', JSON.stringify(S.pair));
      store.set('intercom.cursor', '0');
      S.pairError = ''; S.conn = 'connecting'; S.offlineSince = Date.now();
      update(); startSocket();
      return;
    }
    S.pairError = { 400: 'That does not look like a code', 404: 'Code not recognised', 410: 'Code expired or already used', 429: 'Too many tries, wait a minute' }[r.status] || `Pairing failed (${r.status})`;
  } catch { S.pairError = 'Could not reach the server'; }
  update();
}

function unpair(msg = '') {
  sock?.stop(); sock = null;
  ['intercom.pair', 'intercom.cursor', 'intercom.outbox'].forEach(store.del);
  Object.assign(S, { pair: null, conn: 'offline', reply: null, calendar: null, activity: { state: 'idle', status_text: null }, pairError: msg, sentAt: 0, doneUntil: 0 });
  update();
}

/* ---------- UI wiring ---------- */
function wireUi() {
  $('size').addEventListener('click', () => {
    store.set('intercom.large', store.get('intercom.large') === '1' ? '0' : '1');
    applySize(); lastHtml = ''; update();
  });
  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => setTimeout(applySize, 200));

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input').value.trim();
    if (!v) return;
    if (!S.pair) { pair(parsePairInput(v)); $('input').value = ''; return; }
    if (v.length > 4000) { note('Too long (4,000 characters at most)'); return; }
    sock.send(v);
    $('input').value = ''; $('input').blur();
    S.sentAt = Date.now(); S.doneUntil = 0; later(6100);
    if (S.reply) dismissReply();
    update();
  });

  // Long-press the connection dot to unpair.
  let lp = null;
  const dotbtn = $('dotbtn');
  dotbtn.addEventListener('pointerdown', () => { lp = setTimeout(() => { lp = null; $('confirm').classList.add('show'); }, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => dotbtn.addEventListener(ev, () => { clearTimeout(lp); }));
  dotbtn.addEventListener('contextmenu', (e) => e.preventDefault());
  $('cancel').addEventListener('click', () => $('confirm').classList.remove('show'));
  $('unpair').addEventListener('click', () => { $('confirm').classList.remove('show'); unpair(); });

  // Dial taps: reply expands on tap, double-tap dismisses.
  let lastTap = 0;
  $('dial').addEventListener('click', () => {
    if (demoMode) return;
    const t = Date.now();
    const dbl = t - lastTap < 350; lastTap = t;
    if (S.reply) {
      if (dbl) { dismissReply(); return; }
      if (!S.expanded) { S.expanded = true; armReplyTimer(); update(); }
    } else if (Date.now() < S.doneUntil) { S.doneUntil = 0; update(); }
  });
  $('dial').addEventListener('scroll', () => { if (S.reply) armReplyTimer(); }, true);
}

/* ---------- wake lock ---------- */
async function acquireWake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}

/* ---------- boot ---------- */
/** Read #pair=CODE and remove the fragment so the code never lingers in the URL/history. */
function takePairCode() {
  const m = location.hash.match(/pair=([^&]+)/);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}

function boot() {
  applySize();
  wireUi();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { acquireWake(); sock?.nudge(); fetchToday(); update(); }
  });
  window.addEventListener('online', () => sock?.nudge());
  acquireWake();

  if (demoMode) {
    $('form').hidden = true;
    $('dot').className = 'dot connecting';
    $('dotlabel').textContent = 'Demo';
    const cap = $('caption'); cap.hidden = false;
    const start = Math.max(1, Math.min(STEPS.length, parseInt(params.get('demo'), 10) || 1)) - 1;
    runDemo({
      show, dialEl: $('dial'), start, hold: params.has('hold'),
      setCaption(n, t, d) { cap.innerHTML = `<div class="n"></div><div class="t"></div><div class="d"></div>`; cap.children[0].textContent = n; cap.children[1].textContent = t; cap.children[2].textContent = d; },
    });
    return;
  }

  const code = takePairCode();
  if (S.pair && !code) { S.conn = 'connecting'; startSocket(); }
  if (code) { unpair(); }
  update();
  if (code) pair(code);
  window.addEventListener('hashchange', () => {
    const c = takePairCode();
    if (c) { unpair(); pair(c); }
  });
  setInterval(update, 30000);
  setInterval(() => { if (S.pair) fetchToday(); }, 300000);
}

boot();
