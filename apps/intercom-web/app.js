// Intercom web app: wires the socket, state and dial screens together.
import { render } from './screens.js';
import { IntercomSocket, store, apiUrl } from './socket.js';
import { parsePairInput, replyIsFresh, applyNotification, activeItems, needsList, infoList, attentionLevel, cycleId, isQuietHours, waitingCount, pickScreen } from './logic.js';
import { runDemo, STEPS } from './demo.js';
import { createWakeKeeper } from './wake.js';

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
  notes: new Map(), hidden: new Map(), attention: null, nSel: null, nOpen: null, noteOpen: false, ownIids: new Set(), swipedAt: 0,
};
const forceQuiet = params.has('quiet') ? params.get('quiet') !== '0' : null; // dev: ?quiet previews the Quiet screen, ?quiet=0 shows the day screens at any hour
let sock = null;
let lastHtml = '';
let lastName = '';
let replyTimer = null;
const wake = createWakeKeeper({ tz: TZ_FALLBACK, forceQuiet });

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
  lastName = name;
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
  const cal = S.calendar;
  const tz = (cal && cal.tz) || TZ_FALLBACK;
  const quiet = forceQuiet === null ? isQuietHours(now) : forceQuiet;
  const items = activeItems(S.notes, now.getTime(), S.hidden);
  const attn = needsList(items);
  const list = attn.length ? attn : S.noteOpen ? infoList(items) : [];
  if (!attn.length && !list.length) S.noteOpen = false;
  if (list.length && !list.some((n) => n.id === S.nSel)) S.nSel = list[0].id;
  const a = S.activity;
  const running = a.state === 'running' || a.state === 'queued';
  const own = running && !!a.interaction_id && S.ownIids.has(a.interaction_id);
  const sent = !!S.sentAt && Date.now() - S.sentAt < 6000;
  const name = pickScreen({
    paired: !!S.pair,
    offline: S.conn !== 'online' && !S.reply && Date.now() - S.offlineSince > 1500,
    reply: !!S.reply, ownWorking: own || (sent && !running), done: Date.now() < S.doneUntil,
    needs: list.length > 0, quiet, otherWorking: running,
  });
  switch (name) {
    case 'pairing': return [name, { error: S.pairError }];
    case 'offline': return [name, { connecting: S.conn === 'connecting' }];
    case 'reply': return [name, { reply: S.reply, expanded: S.expanded }];
    case 'working': return [name, { status: running ? a.status_text : 'Sent' }];
    case 'done': return [name, { word: S.doneWord }];
    case 'needs': return [name, { item: list.find((n) => n.id === S.nSel), index: list.findIndex((n) => n.id === S.nSel), total: list.length, expanded: S.nOpen === S.nSel }];
    case 'quiet': return [name, { now, tz, waiting: !S.attention ? items.length : waitingCount(S.attention, items, S.hidden) }];
    default: return [name, { events: cal ? cal.events : [], now, tz, calendarKnown: !!cal, notes: infoList(items).length, halo: attentionLevel(attn) !== 'none' }];
  }
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
    case 'notification':
      if (applyNotification(S.notes, d)) {
        const h = S.hidden.get(d.id);
        if (h !== undefined && (d.state !== 'active' || (d.updated_at || '') > h)) S.hidden.delete(d.id);
        if (!S.notes.has(d.id)) S.hidden.delete(d.id);
      }
      break;
    case 'attention': S.attention = { level: d.level, count: d.count }; break;
    case 'interaction':
      if (d.interaction_id && d.state !== 'closed') S.ownIids.add(d.interaction_id);
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
      onWelcome() { for (const id of S.hidden.keys()) sock.ackNotification(id); },
      onReset() { S.notes.clear(); S.hidden.clear(); S.attention = null; S.reply = null; S.calendar = null; S.activity = { state: 'idle', status_text: null }; },
      onAck(f) { if (f.interaction_id && f.status === 'queued') S.ownIids.add(f.interaction_id); if (f.status === 'rejected') { S.sentAt = 0; note(`Not sent: ${f.reason || 'rejected'}`); } },
      onUnauthorized() { unpair('Pairing was rejected. Open a new pairing link.'); },
      onError(f) { if (f.code === 'notification_not_found') update(); if (f.code === 'unauthorized') unpair('Pairing was rejected. Open a new pairing link.'); },
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
  Object.assign(S, { pair: null, conn: 'offline', reply: null, calendar: null, activity: { state: 'idle', status_text: null }, pairError: msg, sentAt: 0, doneUntil: 0, notes: new Map(), hidden: new Map(), attention: null, noteOpen: false });
  update();
}

/* ---------- notification taps ---------- */
function currentList() {
  const items = activeItems(S.notes, Date.now(), S.hidden);
  const attn = needsList(items);
  return attn.length ? attn : infoList(items);
}
function cycle(delta) {
  S.nOpen = null;
  S.nSel = cycleId(currentList(), S.nSel, delta);
  update();
}
function hide(item) { S.hidden.set(item.id, item.updated_at || ''); }
function onAct({ act, i }) {
  if (act === 'note') { const info = infoList(activeItems(S.notes, Date.now(), S.hidden)); if (info.length) { S.noteOpen = true; S.nSel = info[0].id; update(); } return; }
  if (act === 'cycle') { cycle(1); return; }
  if (act === 'expand') { S.nOpen = S.nSel; update(); return; }
  if (act === 'collapse') { S.nOpen = null; update(); return; }
  const item = S.notes.get(S.nSel);
  if (!item || !sock) return;
  S.nOpen = null;
  if (act === 'ack') { hide(item); sock.ackNotification(item.id); }
  else if (act === 'action') {
    hide(item); sock.sendAction(item.id, Number(i));
    S.sentAt = Date.now(); S.doneUntil = 0; later(6100);
  }
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

  // Dial taps: reply expands on tap, double-tap dismisses; notification buttons, note dot and counter use data-act.
  let lastTap = 0;
  $('dial').addEventListener('click', (ev) => {
    if (demoMode) return;
    if (Date.now() - S.swipedAt < 400) return;
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (act && !S.reply) { onAct(act.dataset); return; }
    const t = Date.now();
    const dbl = t - lastTap < 350; lastTap = t;
    if (S.reply) {
      if (dbl) { dismissReply(); return; }
      if (!S.expanded) { S.expanded = true; armReplyTimer(); update(); }
    } else if (Date.now() < S.doneUntil) { S.doneUntil = 0; update(); }
  });
  // Swipe left or right through several notifications.
  let sx = null;
  $('dial').addEventListener('pointerdown', (ev) => { sx = ev.clientX; });
  $('dial').addEventListener('pointerup', (ev) => {
    if (sx === null) return;
    const dx = ev.clientX - sx; sx = null;
    if (Math.abs(dx) > 40 && lastName === 'needs') { S.swipedAt = Date.now(); cycle(dx < 0 ? 1 : -1); }
  });
  $('dial').addEventListener('scroll', () => { if (S.reply) armReplyTimer(); }, true);
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
    if (document.visibilityState === 'visible') { wake.evaluate(); sock?.nudge(); fetchToday(); update(); }
  });
  window.addEventListener('online', () => sock?.nudge());
  wake.evaluate();
  for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, () => wake.gesture(), { once: true, passive: true });
  setInterval(() => wake.evaluate(), 60000);

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
