// Intercom web app: wires the socket, state and dial screens together.
import { render } from './screens.js';
import { IntercomSocket, store, apiUrl } from './socket.js';
import { quietEscapeActive, parsePairInput, replyIsFresh, applyNotification, activeItems, needsList, infoList, attentionLevel, cycleId, isQuietHours, pickScreen, deskCounts, departureView, chooseDeskFace, quietTone, matchNotice, LANDSCAPE_QUERY, physicalDialSize, clampPpi, DIAL_INCHES, DEFAULT_PPI, LEVEL_RANK, tzParts } from './logic.js';
import { createStore, applyDelta, applyState, revsOf, itemsOf, activeSlot, faceOrder, stepFace, faceLayout, approvalItems } from './surface.js';
import { ringModel, carouselOrder, nearestRingEvent, inRingBand, ballHit, pointToHours, scrubStart, scrubMove, scrubRelease, scrubActive, scrubRemaining, SNAP_MS, pickDeparture, travelDeparture } from './dayv2.js';
import { ButtonStates, submitAction, needsConfirm, btnKey } from './actions.js';
import { sessionsFromDesk, sessionsFromStore, mergeOlder, appendMessage } from './statusv2.js';
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
  notes: new Map(), hidden: new Map(), attention: null, nSel: null, nOpen: null, noteOpen: false, ownIids: new Set(), swipedAt: 0, quietEscape: 0,
  desk: null, face: loadFace(), statusList: false,
  // Surface v2
  store: createStore(), v2: false, surfaceHttp: true, btns: new ButtonStates(), images: new Map(),
  view: null, viewStack: [], convo: null, draftCtx: null, scrub: null, scrubbedAt: 0, sentView: null,
};
const forceQuiet = params.has('quiet') ? params.get('quiet') !== '0' : null; // dev: ?quiet previews the Quiet screen, ?quiet=0 shows the day screens at any hour
let sock = null;
let lastHtml = '';
let lastName = '';
let replyTimer = null;

// Desk faces (E94): the user swipes to a face and it stays. ?face=status|day sets it too (dev, and for the mock server).
function loadFace() {
  try {
    const q = new URLSearchParams(location.search).get('face');
    if (q === 'status' || q === 'day') { localStorage.setItem('intercom.face', q); return q; }
    return localStorage.getItem('intercom.face') === 'status' ? 'status' : 'day';
  } catch { return 'day'; }
}
function moveFace(step) {
  const order = S.v2 ? faceOrder(S.store) : ['day', 'status'];
  setFace(stepFace(order, S.face, step));
}
/** A pointer position in the 466 design square. */
function designPoint(ev) {
  const r = $('dial').getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * 466, y: ((ev.clientY - r.top) / r.height) * 466 };
}
/** Leave the quiet face for the main face (Day Dial); normal face navigation works from there until quiet hours end. */
function escapeQuiet() {
  S.quietEscape = Date.now(); S.face = 'day'; S.statusList = false; S.swipedAt = Date.now();
  update();
}
function setFace(face) {
  S.face = face; S.statusList = false; S.swipedAt = Date.now();
  store.set('intercom.face', face);
  update();
}

const VIEW_IDLE_MS = 120000;
let viewTimer = null;
const btnFn = (object, actionId, mid) => S.btns.get(btnKey(object, actionId, mid));
const tzNow = () => (S.calendar && S.calendar.tz) || TZ_FALLBACK;
const surfaceUrl = (path) => apiUrl(`api/v1/surface/${path}`);
const authHeaders = () => ({ Authorization: `Bearer ${S.pair.token}` });

/* ---------- views (Event focus, Approval, draft, Conversation) ---------- */
function armViewTimer() {
  clearTimeout(viewTimer);
  if (S.view) viewTimer = setTimeout(closeAllViews, VIEW_IDLE_MS);
}
function syncViewFrame() {
  const want = S.view && S.view.type === 'convo' ? `conversation:${S.view.id}` : null;
  if (want === S.sentView) return;
  if (!sock || sock.state !== 'online' || sock.mode !== 'v2') { return; }
  sock.sendView(want);
  S.sentView = want;
}
function openView(v) {
  if (S.view) S.viewStack.push(S.view);
  S.view = v; armViewTimer(); syncViewFrame(); update();
}
function closeView() {
  S.view = S.viewStack.pop() || null;
  if (!S.view || S.view.type !== 'convo') { /* convo state is dropped when no convo view is left */ if (!S.viewStack.some((x) => x.type === 'convo') && !(S.view && S.view.type === 'convo')) S.convo = null; }
  armViewTimer(); syncViewFrame(); update();
}
function closeAllViews() {
  S.view = null; S.viewStack = []; S.convo = null; S.draftCtx = null;
  clearTimeout(viewTimer); syncViewFrame(); update();
}

function ensureImage(hash) {
  if (!hash || S.images.has(hash) || !S.pair) return;
  S.images.set(hash, null);
  fetch(surfaceUrl(`assets/${encodeURIComponent(hash)}`), { headers: authHeaders() })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => { S.images.set(hash, URL.createObjectURL(b)); update(); })
    .catch(() => { S.images.delete(hash); });
}

/** The ring Events of today in carousel order, with the model they came from. */
function carouselNow(now = new Date()) {
  const model = ringModel(itemsOf(S.store, 'events'), now, tzNow());
  return { model, order: carouselOrder(model) };
}
/** Open the ring Event carousel on `id` (the Event nearest the tap). Does nothing with no Events. */
function openCarousel(id) {
  const { order } = carouselNow();
  if (!order.length) return;
  for (const it of order) { const ev = S.store.items.events[it.id]; if (ev && ev.detail && ev.detail.image) ensureImage(ev.detail.image); }
  openView({ type: 'carousel', id });
}
/** Move the carousel by `d` cards (wraps round); the swipe direction picks the slide animation. */
function stepCarousel(d) {
  if (!S.view || S.view.type !== 'carousel') return;
  const { order } = carouselNow();
  const i = order.findIndex((x) => x.id === S.view.id);
  if (i < 0 || order.length < 2) return;
  S.view = { type: 'carousel', id: order[(i + d + order.length) % order.length].id };
  S.slideDir = d > 0 ? 'l' : 'r';
  armViewTimer(); update();
}

function openEvent(id) {
  const ev = S.store.items.events[id];
  if (!ev) return;
  if (ev.kind === 'approval') { openView({ type: 'approval', id }); return; }
  if (ev.opens === 'conversation' && ev.conversation_id) { openConvo(ev.conversation_id, ev.title); return; }
  const img = ev.detail && ev.detail.image;
  if (img) ensureImage(img);
  openView({ type: 'event', id });
}

async function openConvo(id, title = 'Conversation') {
  S.convo = { id, title, messages: [], nextBefore: null, loading: true, error: '', stick: true, prepend: false };
  openView({ type: 'convo', id });
  await loadConvoPage(null);
}
async function loadConvoPage(before) {
  const c = S.convo;
  if (!c || !S.pair) return;
  const id = c.id;
  try {
    const q = `limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const r = await fetch(surfaceUrl(`conversations/${encodeURIComponent(id)}?${q}`), { headers: authHeaders() });
    if (!S.convo || S.convo.id !== id) return;
    if (!r.ok) { S.convo.error = r.status === 404 ? 'Not available' : `Could not load (${r.status})`; S.convo.loading = false; update(); return; }
    const j = await r.json();
    if (!S.convo || S.convo.id !== id) return;
    S.convo.messages = mergeOlder(S.convo.messages, j.messages || []);
    S.convo.nextBefore = j.next_before || null;
    if (j.title) S.convo.title = j.title;
    S.convo.error = '';
  } catch { if (S.convo && S.convo.id === id) S.convo.error = 'Could not load'; }
  if (S.convo && S.convo.id === id) { S.convo.loading = false; update(); }
}
function loadOlder() {
  const c = S.convo;
  if (!c || c.loading || !c.nextBefore) return;
  c.loading = true; c.prepend = true; update();
  loadConvoPage(c.nextBefore);
}

/* ---------- actions: every button goes through here ---------- */
async function fire({ object, actionId, action = null, draft, messageId }) {
  if (!S.pair) return null;
  const p = submitAction({ url: surfaceUrl('actions'), token: S.pair.token, object, actionId, action, draft, messageId, states: S.btns });
  update();
  const r = await p;
  update();
  if (r.interp && r.interp.state === 'failed' && !r.interp.disabled) later(4100);
  return r;
}
/** Start an action: one with a confirm draft opens the draft view first; the Send there echoes the text back. */
function startAction({ object, actionId, action, messageId }) {
  if (!S.btns.canTap(btnKey(object, actionId, messageId))) return null; // already sent, expired or sending
  if (needsConfirm(action)) {
    S.draftCtx = { object, actionId, action, messageId, draft: action.confirm.draft, prompt: action.confirm.prompt || action.label };
    openView({ type: 'draft' });
    return null;
  }
  return fire({ object, actionId, action, messageId });
}

function loadPair() {
  try { const p = JSON.parse(store.get('intercom.pair') || 'null'); return p && p.token ? p : null; } catch { return null; }
}

/* ---------- sizing ---------- */
// Landscape shows the dial at the Compact's physical size: inches x CSS px per inch (calibratable).
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
if (params.has('ppi')) safeSet('intercom.ppi', String(clampPpi(params.get('ppi'))));
function getPpi() { const v = safeGet('intercom.ppi'); return v == null ? DEFAULT_PPI : clampPpi(v); }
function getDiam() { const d = Number(params.get('diam')); return d > 0 ? d : DIAL_INCHES; }
function wireCalibrate() {
  if (!params.has('calibrate')) return;
  const box = $('calibrate'), bar = $('calbar'), val = $('calval');
  const paint = () => { const p = getPpi(); bar.style.width = `${p}px`; val.textContent = `${p} px/in`; applySize(); };
  const bump = (d) => { safeSet('intercom.ppi', String(clampPpi(getPpi() + d))); paint(); };
  $('calminus').addEventListener('click', () => bump(-1));
  $('calplus').addEventListener('click', () => bump(1));
  box.hidden = false; paint();
}
function applySize() {
  const large = store.get('intercom.large') === '1';
  const wrap = document.querySelector('.stagewrap');
  let dial = 268;
  let landscape = false;
  try { landscape = window.matchMedia(LANDSCAPE_QUERY).matches; } catch { /* no matchMedia: portrait */ }
  if (landscape) {
    dial = physicalDialSize(getPpi(), getDiam(), wrap.clientHeight || document.documentElement.clientHeight - 24);
  } else if (large) {
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
  const prev = lastName;
  lastName = name;
  const html = render(name, props);
  $('dial').dataset.screen = name;
  if (html === lastHtml) return;
  lastHtml = html;
  const face = $('face');
  const sc = face.querySelector('[data-scroller]');
  const rec = sc && prev === name ? { top: sc.scrollTop, h: sc.scrollHeight, bottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60 } : null;
  face.innerHTML = html;
  const nsc = face.querySelector('[data-scroller]');
  const newCard = sc && nsc && sc.dataset.card !== nsc.dataset.card; // a different carousel card starts at the top
  if (nsc && !newCard) {
    const c = S.convo;
    if (name === 'convo' && c && (c.stick || (rec && rec.bottom)) && !c.prepend) { nsc.scrollTop = nsc.scrollHeight; if (c.stick && !c.loading) c.stick = false; }
    else if (name === 'convo' && c && c.prepend && rec) { nsc.scrollTop = rec.top + (nsc.scrollHeight - rec.h); if (!c.loading) c.prepend = false; }
    else if (rec) nsc.scrollTop = rec.top;
  }
  if (prev === name && (name === 'convo' || name === 'event' || name === 'carousel' || name === 'approval' || name === 'draft' || S.scrub)) return;
  face.classList.remove('fade');
  void face.offsetWidth;
  face.classList.add('fade');
}

function computeView(now = new Date()) {
  const cal = S.calendar;
  const tz = (cal && cal.tz) || TZ_FALLBACK;
  const realQuiet = forceQuiet === null ? isQuietHours(now) : forceQuiet;
  // Quiet escape: a left swipe on the quiet face is an override that lasts until the quiet window ends (or 12 h at most).
  if (!quietEscapeActive({ realQuiet, escapedAt: S.quietEscape, now: now.getTime() })) S.quietEscape = 0;
  const quiet = realQuiet && !S.quietEscape;
  const items = allItems(now.getTime());
  const attn = needsList(items);
  const list = attn.length ? attn : S.noteOpen ? infoList(items) : [];
  if (!attn.length && !list.length) S.noteOpen = false;
  if (list.length && !list.some((n) => n.id === S.nSel)) S.nSel = list[0].id;
  const a = S.activity;
  const running = a.state === 'running' || a.state === 'queued';
  const own = running && !!a.interaction_id && S.ownIids.has(a.interaction_id);
  const sent = !!S.sentAt && Date.now() - S.sentAt < 6000;
  let name = pickScreen({
    paired: !!S.pair,
    offline: S.conn !== 'online' && !S.reply && Date.now() - S.offlineSince > 1500,
    view: !!S.view, reply: !!S.reply, ownWorking: own || (sent && !running), done: Date.now() < S.doneUntil,
    needs: list.length > 0, quiet, otherWorking: running,
  });
  if (name === 'view') name = S.view.type === 'convo' ? 'convo' : S.view.type;
  if (name === 'idle' || name === 'quiet') {
    const f = chooseDeskFace({ quiet: name === 'quiet', preferred: S.face });
    name = f === 'quiet' ? 'quiet' : f === 'status' ? 'status' : 'idle';
  }
  switch (name) {
    case 'pairing': return [name, { error: S.pairError }];
    case 'offline': return [name, { connecting: S.conn === 'connecting' }];
    case 'reply': return [name, { reply: S.reply, expanded: S.expanded }];
    case 'working': return [name, { status: running ? a.status_text : 'Sent' }];
    case 'done': return [name, { word: S.doneWord }];
    case 'needs': return [name, { item: list.find((n) => n.id === S.nSel), index: list.findIndex((n) => n.id === S.nSel), total: list.length, expanded: S.nOpen === S.nSel }];
    case 'quiet': {
      const sessions = statusSessions();
      const counts = S.v2 ? { working: sessions.filter((x) => x.state === 'working').length, needs_you: sessions.filter((x) => x.needs_you).length } : deskCounts(S.desk);
      return [name, { tone: quietTone({ counts, stuck: sessions.some((x) => x.state === 'stuck'), attention: attn.length, notes: infoList(items).length }) }];
    }
    case 'status': return [name, { sessions: statusSessions(), now, tz, noticeFor: (id) => { const x = statusSessions().find((q) => q.id === id); return !!matchNotice(x, items); } }];
    case 'event': {
      const ev = S.store.items.events[S.view.id];
      if (!ev) { queueMicrotask(closeView); return ['offline', { connecting: true }]; }
      return [name, { ev, tz, btn: btnFn, image: ev.detail && ev.detail.image ? S.images.get(ev.detail.image) || null : null }];
    }
    case 'carousel': {
      const { model, order } = carouselNow(now);
      const i = order.findIndex((x) => x.id === S.view.id);
      const ev = i >= 0 ? S.store.items.events[S.view.id] : null;
      if (!ev) { queueMicrotask(closeView); return ['offline', { connecting: true }]; }
      const img = ev.detail && ev.detail.image;
      if (img) ensureImage(img);
      const it = order[i];
      const m = it.kind === 'seg' ? model.segs.find((x) => x.id === it.id) : model.ticks.find((x) => x.id === it.id);
      const dir = S.slideDir; S.slideDir = '';
      return [name, { ev, tz, btn: btnFn, image: img ? S.images.get(img) || null : null, index: i, total: order.length, past: !!(m && m.past), dir }];
    }
    case 'approval': {
      const ev = S.store.items.events[S.view.id];
      if (!ev) { queueMicrotask(closeView); return ['offline', { connecting: true }]; }
      return [name, { ev, btn: btnFn }];
    }
    case 'draft': {
      const d = S.draftCtx;
      if (!d) { queueMicrotask(closeView); return ['offline', { connecting: true }]; }
      return [name, { to: d.prompt, text: d.draft, btn: () => btnFn(d.object, d.actionId, d.messageId) }];
    }
    case 'convo': {
      const c = S.convo;
      if (!c) { queueMicrotask(closeView); return ['offline', { connecting: true }]; }
      return [name, { title: c.title, messages: c.messages, loading: c.loading, hasMore: !!c.nextBefore, error: c.error, btn: btnFn, convId: c.id }];
    }
    default: {
      const surfaceEvents = S.v2 ? itemsOf(S.store, 'events') : [];
      const departure = S.v2 ? pickDeparture(S.desk && S.desk.departure, surfaceEvents, now.getTime(), tz) : departureView(S.desk && S.desk.departure, now.getTime(), tz);
      if (S.scrub && !scrubActive(S.scrub, now.getTime())) S.scrub = null;
      return [name, {
        // Surface v2: the ring and the default primary line come only from surface Events and slots. The calendar draws only on the legacy path.
        events: S.v2 ? [] : (cal ? cal.events : []), now, tz, calendarKnown: !!cal, v2: S.v2,
        notes: infoList(items).length, halo: attentionLevel(attn) !== 'none', departure,
        surfaceEvents, store: S.store, layout: S.v2 ? faceLayout(S.store, 'day') : {}, scrub: S.scrub, btn: btnFn,
      }];
    }
  }
}

function statusSessions() { return S.v2 ? sessionsFromStore(S.store) : sessionsFromDesk(S.desk); }
/** Active notices plus pending bus approvals (as Needs-you items), most urgent first. */
function allItems(nowMs) {
  const items = activeItems(S.notes, nowMs, S.hidden);
  if (!S.v2) return items;
  const ap = approvalItems(S.store, nowMs).filter((n) => !S.hidden.has(n.id));
  if (!ap.length) return items;
  const t = (n) => Date.parse(n.updated_at || n.created_at || '') || 0;
  return [...items, ...ap].sort((a, b) => (LEVEL_RANK[b.level] || 2) - (LEVEL_RANK[a.level] || 2) || t(b) - t(a));
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
    case 'desk': S.desk = d; break;
    case 'conversation_append':
      if (S.convo && d.conversation_id === S.convo.id && appendMessage(S.convo.messages, d.message)) armViewTimer();
      break;
    default: break;
  }
  update();
}

function startSocket() {
  if (!S.pair) return;
  sock = new IntercomSocket({
    token: S.pair.token,
    getRevs: () => revsOf(S.store),
    handlers: {
      onDelta(f) { if (applyDelta(S.store, f) === 'gap') resync(); update(); },
      onMode(m) { if (m === 'v1') { S.v2 = false; S.store = createStore(); S.sentView = null; } },
      onWelcome(f) {
        S.v2 = f.version === 2; S.sentView = null; syncViewFrame();
        for (const id of S.hidden.keys()) sock.ackNotification(id);
        if (S.v2) resync();
      },
      onState(st) { if (S.conn === 'online' && st !== 'online') S.offlineSince = Date.now(); S.conn = st; update(); if (st !== 'online') later(1600); },
      onEvent,
      onReset() { S.notes.clear(); S.hidden.clear(); S.attention = null; S.reply = null; S.calendar = null; S.desk = null; S.activity = { state: 'idle', status_text: null }; },
      onAck(f) { if (f.interaction_id && f.status === 'queued') S.ownIids.add(f.interaction_id); if (f.status === 'rejected') { S.sentAt = 0; note(`Not sent: ${f.reason || 'rejected'}`); } },
      onUnauthorized() { unpair('Pairing was rejected. Open a new pairing link.'); },
      onError(f) { if (f.code === 'notification_not_found') update(); if (f.code === 'unauthorized') unpair('Pairing was rejected. Open a new pairing link.'); },
    },
  });
  sock.start();
  fetchToday();
  fetchDesk();
}

async function fetchToday() {
  if (!S.pair) return;
  try {
    const r = await fetch(apiUrl('api/v1/intercom/today'), { headers: { Authorization: `Bearer ${S.pair.token}` } });
    if (r.ok) { const c = await r.json(); if (!S.calendar || (c.generated_at || '') >= (S.calendar.generated_at || '')) S.calendar = c; update(); }
  } catch { /* offline: fine */ }
}

// Snapshot of every surface resource: after a delta gap, after welcome, and as the 60 s poll fallback.
let resyncAt = 0;
async function resync(force = false) {
  if (!S.pair || !S.surfaceHttp || (!S.v2 && !force)) return;
  if (Date.now() - resyncAt < 2000) return;
  resyncAt = Date.now();
  try {
    const r = await fetch(surfaceUrl('state'), { headers: authHeaders() });
    if (r.status === 401 || r.status === 403 || r.status === 404) { S.surfaceHttp = false; return; }
    if (r.ok) { applyState(S.store, await r.json()); update(); }
  } catch { /* offline: fine */ }
}

// Poll fallback for the `desk` event (every 60 s, and on becoming visible).
async function fetchDesk() {
  if (!S.pair) return;
  try {
    const r = await fetch(apiUrl('api/v1/intercom/desk'), { headers: { Authorization: `Bearer ${S.pair.token}` } });
    if (r.ok) { const d = await r.json(); if (!S.desk || (d.generated_at || '') >= (S.desk.generated_at || '')) S.desk = d; update(); }
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
  Object.assign(S, { pair: null, conn: 'offline', reply: null, calendar: null, desk: null, statusList: false, activity: { state: 'idle', status_text: null }, pairError: msg, sentAt: 0, doneUntil: 0, notes: new Map(), hidden: new Map(), attention: null, noteOpen: false, store: createStore(), v2: false, surfaceHttp: true, btns: new ButtonStates(), view: null, viewStack: [], convo: null, draftCtx: null, scrub: null, sentView: null });
  update();
}

/* ---------- notification taps ---------- */
function currentList() {
  const items = allItems(Date.now());
  const attn = needsList(items);
  return attn.length ? attn : infoList(items);
}
function cycle(delta) {
  S.nOpen = null;
  S.nSel = cycleId(currentList(), S.nSel, delta);
  update();
}
function hide(item) { S.hidden.set(item.id, item.updated_at || ''); }
function onAct(d) {
  const { act, i, id } = d;
  const now = Date.now();
  armViewTimer();
  if (act === 'session') {
    if (d.cid) { const sess = statusSessions().find((x) => x.id === id); openConvo(d.cid, (sess && (sess.subject || sess.title)) || 'Conversation'); return; }
    const sess = statusSessions().find((x) => x.id === id);
    const notice = matchNotice(sess, allItems(now));
    if (notice) { S.noteOpen = true; S.nSel = notice.id; update(); }
    return;
  }
  if (act === 'note') { const info = infoList(allItems(now)); if (info.length) { S.noteOpen = true; S.nSel = info[0].id; update(); } return; }
  if (act === 'cycle') { cycle(1); return; }
  if (act === 'expand') { S.nOpen = S.nSel; update(); return; }
  if (act === 'collapse') { S.nOpen = null; update(); return; }
  if (act === 'back') { closeView(); return; }
  if (act === 'cprev') { stepCarousel(-1); return; }
  if (act === 'cnext') { stepCarousel(1); return; }
  if (act === 'copenconv') {
    const ev = S.view && S.view.type === 'carousel' && S.store.items.events[S.view.id];
    if (ev && ev.conversation_id) openConvo(ev.conversation_id, ev.title);
    return;
  }
  if (act === 'dhold') { closeView(); return; }
  if (act === 'slotaction') {
    const slot = activeSlot(S.store, 'primary', now);
    if (slot && slot.action) startAction({ object: 'slots:primary', actionId: slot.action.id, action: slot.action });
    return;
  }
  if (act === 'efire') {
    const ev = S.view && S.store.items.events[S.view.id];
    const action = ev && (ev.actions || []).find((a) => a.id === d.aid);
    if (action) startAction({ object: `events:${ev.id}`, actionId: action.id, action });
    return;
  }
  if (act === 'dsend') {
    const c = S.draftCtx;
    if (!c) return;
    fire({ object: c.object, actionId: c.actionId, action: c.action, draft: c.draft, messageId: c.messageId }).then((r) => {
      if (r && r.interp && r.interp.state === 'sent') setTimeout(() => { if (S.view && S.view.type === 'draft') { S.draftCtx = null; closeView(); } }, 1100);
    });
    return;
  }
  if (act === 'cbtn') {
    const c = S.convo;
    if (c) fire({ object: `conversations:${c.id}`, actionId: d.i, messageId: d.mid });
    return;
  }
  const item = currentList().find((n) => n.id === S.nSel);
  if (!item) return;
  S.nOpen = null;
  if (item.approval) {
    // A bus approval riding the Needs-you screen: Review opens the Approval view, Got it just hides it locally.
    if (act === 'ack') hide(item); else if (act === 'action') openEvent(item.event_id);
    update(); return;
  }
  if (!sock) return;
  if (act === 'ack') { hide(item); sock.ackNotification(item.id); }
  else if (act === 'action') {
    hide(item);
    if (S.v2) {
      fire({ object: `notices:${item.id}`, actionId: String(i) }).then((r) => {
        if (r && r.interp && r.interp.state === 'failed') { S.hidden.delete(item.id); note('Not sent'); }
        update();
      });
    } else sock.sendAction(item.id, Number(i));
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
    if (Date.now() - S.swipedAt < 400 || Date.now() - S.scrubbedAt < 400) return;
    armViewTimer();
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (act && !S.reply) { onAct(act.dataset); return; }
    const t = Date.now();
    const dbl = t - lastTap < 350; lastTap = t;
    if (S.reply) {
      if (dbl) { dismissReply(); return; }
      if (!S.expanded) { S.expanded = true; armReplyTimer(); update(); }
    } else if (Date.now() < S.doneUntil) { S.doneUntil = 0; update(); }
    else if (lastName === 'idle' && S.v2) {
      // A tap anywhere in the ring band (not on the ball) opens the carousel on the Event nearest in time.
      const p = designPoint(ev);
      const now = new Date();
      if (faceLayout(S.store, 'day').ring !== false && inRingBand(p.x, p.y) && !ballHit(p.x, p.y, tzParts(now, tzNow()).hours)) {
        const hit = nearestRingEvent(p.x, p.y, ringModel(itemsOf(S.store, 'events'), now, tzNow()));
        if (hit) openCarousel(hit.id);
      }
    }
  });
  // Swipe left or right through several notifications, or between faces. A press on the progress ball scrubs instead.
  let sx = null, sy0 = null;
  const dial = $('dial');
  dial.addEventListener('pointerdown', (ev) => {
    armViewTimer();
    sx = ev.clientX; sy0 = ev.clientY;
    if (lastName === 'idle' && S.v2 && !S.reply) {
      const p = designPoint(ev);
      const nowH = tzParts(new Date(), tzNow()).hours;
      if (ballHit(p.x, p.y, nowH)) {
        sx = null;
        S.scrub = scrubStart(pointToHours(p.x, p.y));
        try { dial.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        update();
      }
    }
  });
  dial.addEventListener('pointermove', (ev) => {
    if (!S.scrub || !S.scrub.dragging) return;
    const p = designPoint(ev);
    S.scrub = scrubMove(S.scrub, pointToHours(p.x, p.y));
    update();
  });
  const endScrub = () => {
    if (!S.scrub || !S.scrub.dragging) return false;
    S.scrub = scrubRelease(S.scrub, Date.now());
    S.scrubbedAt = Date.now();
    later(SNAP_MS + 60); // snap back to now about four seconds after letting go
    update();
    return true;
  };
  dial.addEventListener('pointercancel', endScrub);
  dial.addEventListener('pointerup', (ev) => {
    if (endScrub()) { sx = null; return; }
    if (sx === null) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy0; sx = null;
    if (lastName === 'carousel') {
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { S.swipedAt = Date.now(); stepCarousel(dx < 0 ? 1 : -1); }
      return;
    }
    if (lastName === 'quiet') { if (dx < -40 && Math.abs(dx) > Math.abs(dy)) escapeQuiet(); return; }
    if (Math.abs(dx) > 40 && lastName === 'needs') { S.swipedAt = Date.now(); cycle(dx < 0 ? 1 : -1); }
    else if (Math.abs(dx) > 40 && (lastName === 'idle' || lastName === 'status')) moveFace(dx < 0 ? 1 : -1);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && (lastName === 'idle' || lastName === 'status')) moveFace(ev.key === 'ArrowRight' ? 1 : -1);
    if (ev.key === 'ArrowRight' && lastName === 'quiet') escapeQuiet();
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && lastName === 'carousel') stepCarousel(ev.key === 'ArrowRight' ? 1 : -1);
    if (ev.key === 'Escape' && S.view) closeView();
  });
  $('dial').addEventListener('scroll', (ev) => {
    if (S.reply) armReplyTimer();
    armViewTimer();
    const t = ev.target;
    if (S.convo && t && t.classList && t.classList.contains('cscroll') && t.scrollTop < 30) loadOlder();
  }, true);
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
  wireCalibrate();
  wireUi();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { sock?.nudge(); fetchToday(); fetchDesk(); resync(); update(); }
  });
  window.addEventListener('online', () => sock?.nudge());

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
  setInterval(update, 15000);
  setInterval(() => { if (S.pair) fetchToday(); }, 300000);
  setInterval(() => { if (S.pair) fetchDesk(); }, 60000);
  setInterval(() => { if (S.pair) resync(); }, 60000); // 60 s poll fallback for the surface resources
}

boot();
