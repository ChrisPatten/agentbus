// Compact Phase (Plum Dusk) web client: the 466 x 466 dial for usability testing on a phone.
// Reuses the shared client modules: socket (protocol 2 with v1 fallback), surface store, the one action path, logic helpers.
import { IntercomSocket, store as ls, apiUrl } from '../socket.js';
import { parsePairInput, physicalDialSize, clampPpi, DIAL_INCHES, DEFAULT_PPI, LANDSCAPE_QUERY, applyNotification, replyIsFresh, glanceOf } from '../logic.js';
import { createStore, applyDelta, applyState, revsOf, itemsOf } from '../surface.js';
import { ButtonStates, submitAction, btnKey } from '../actions.js';
import { appendMessage } from '../statusv2.js';
import * as M from './model.js';
import * as Sc from './screens.js';
import { compose, setMeasure, glyph, icon, caps } from './prims.js';
import { buildState, STATES, STATE_IDS } from './states.js';
import { sunTimes, crescentLeft, FALLBACK } from './sun.js';
import { zparts, hm, hmA, mss, timer, lengthText, shortHour, agoText, monthDay, zonedMs, DEFAULT_TZ } from './time.js';
import { createEarlier } from './earlier.js';
import { createKeepAwake } from './wake.js';
import { clockPoint, moonDeg, walkAt, sliderHit, clockDeg, drainLit } from './geom.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const STATE_ID = params.get('state');
const DEMO = params.has('demo');
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ; } catch { return DEFAULT_TZ; } })();
const H12 = 12 * 3600 * 1000;
// Dev: ?quiet forces quiet hours on, ?quiet=0 off (as in the main client).
const FORCE_QUIET = params.has('quiet') ? params.get('quiet') !== '0' : null;
const T = { dim: 30000, rest: 150000, home: 60000, quietRest: 20000, notice: 20000, sent: 5000, noAck: 3000, actTimeout: 10000, view: 60000 };
// Dev: ?fast divides the rest timeouts by 10 (dim 3 s, rest 15 s, quiet rest 2 s, back to Now 6 s) for the headless checks.
if (params.has('fast')) Object.assign(T, { dim: 3000, rest: 15000, home: 6000, quietRest: 2000 });

const safe = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  json(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } },
};
const storage = { getItem: (k) => safe.get(k), setItem: (k, v) => safe.set(k, v) };

/* ---------- settings (local only) ---------- */
export const CITIES = [
  { city: 'Mansfield', lat: 42.0334, lon: -71.219 }, { city: 'Boston', lat: 42.3601, lon: -71.0589 }, { city: 'New York', lat: 40.7128, lon: -74.006 },
  { city: 'Chicago', lat: 41.8781, lon: -87.6298 }, { city: 'Denver', lat: 39.7392, lon: -104.9903 }, { city: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { city: 'London', lat: 51.5072, lon: -0.1276 }, { city: 'Paris', lat: 48.8566, lon: 2.3522 }, { city: 'Tokyo', lat: 35.6762, lon: 139.6503 }, { city: 'Sydney', lat: -33.8688, lon: 151.2093 },
];
const QUIET_PRESETS = [{ on: true, start: 1320, end: 420 }, { on: true, start: 1380, end: 420 }, { on: true, start: 1320, end: 390 }, { on: true, start: 1260, end: 360 }, { on: false, start: 1320, end: 420 }];
const DEF = { brightness: 1, volume: 0.6, quiet: QUIET_PRESETS[0], loc: { ...CITIES[0], source: 'picked' }, reduced: false };
const SET = { ...DEF, ...safe.json('phase.settings', {}) };
const isQuietNow = (now) => (FORCE_QUIET === null ? M.isQuiet(now, TZ, SET.quiet) : FORCE_QUIET);
const saveSettings = () => safe.set('phase.settings', JSON.stringify(SET));

/* ---------- state ---------- */
const S = {
  pair: loadPair(), conn: 'offline', offlineSince: Date.now(), lastOnline: 0, v2: false, store: createStore(), surfaceHttp: true,
  btns: new ButtonStates(), v1notes: new Map(), face: 'now', overlay: null, view: null, modal: null, power: false,
  aside: new Map(Object.entries(safe.json('phase.aside', {}))), seen: new Map(), known: new Map(),
  capture: null, saved: null, ptt: null, utter: null, act: null,
  lastTouch: Date.now(), rest: 'awake', quietEndedUntil: 0, wokeQuietAt: 0,
  threads: new Map(), threadId: null, questions: new Map(), agentName: safe.get('phase.agent') || '',
  pairedAt: Number(safe.get('phase.pairedAt')) || 0, lastFrame: 0, frozen: !!STATE_ID, demoId: null, demoT0: 0,
};
const earlier = createEarlier(storage);
const awake = createKeepAwake({ storage });
let sock = null;
const saveAside = () => safe.set('phase.aside', JSON.stringify(Object.fromEntries(S.aside)));
function loadPair() { try { const p = JSON.parse(ls.get('intercom.pair') || 'null'); return p && p.token ? p : null; } catch { return null; } }
const reduced = () => SET.reduced || (globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const surfaceUrl = (p) => apiUrl(`api/v1/surface/${p}`);
const auth = () => ({ Authorization: `Bearer ${S.pair.token}` });

/* ---------- sun ---------- */
let sunCache = { key: '', v: null };
function sun(now) {
  const p = zparts(now, TZ), loc = SET.loc;
  const key = `${p.ymd}|${loc ? `${loc.lat},${loc.lon}` : 'none'}`;
  if (sunCache.key !== key) {
    let v;
    if (!loc) v = { rise: zonedMs(p.y, p.mo, p.d, 6, 30, TZ), set: zonedMs(p.y, p.mo, p.d, 17, 30, TZ), polar: null, fallback: true };
    else { const r = sunTimes(p.y, p.mo, p.d, loc.lat, loc.lon); v = r.polar ? { rise: 0, set: 0, polar: r.polar } : { rise: r.rise, set: r.set, polar: null }; }
    sunCache = { key, v };
  }
  return sunCache.v;
}
const crescentAt = (now) => { const s = sun(now); return crescentLeft(now, s.rise, s.set, s.polar); };
void FALLBACK;

/* ---------- environment for a screen ---------- */
function env(now, opts = {}) {
  const p = zparts(now, TZ);
  return { t: now, nowPt: clockPoint(p.h, p.m, p.s), moon: opts.noMoon ? null : 0, crescent: crescentAt(now) };
}

/* ---------- live data ---------- */
const sessions = () => (S.v2 ? itemsOf(S.store, 'sessions') : []);
/** Open notices: the v2 `notices` resource, merged by id with the v1 `notification` events the bus sends alongside it. */
function noticeItems() {
  const all = new Map(S.v1notes);
  if (S.v2) for (const n of itemsOf(S.store, 'notices')) all.set(n.id, n);
  return [...all.values()].filter((n) => n.state === 'active');
}
function jobMoment(s) {
  const q = S.questions.get(s.id);
  return { id: `job:${s.id}`, src: 'session', weight: 'decision', title: s.subject || s.title || 'Agent', start: null, end: null, state: 'open', updated: `${s.needs_you_message_id || ''}`,
    arrival: Date.parse(s.last_activity_at || s.since || '') || null, expires: null, actions: [], session: s, question: q || null, object: s.conversation_id ? `conversations:${s.conversation_id}` : null };
}
function moments() {
  const out = [];
  if (S.v2) for (const e of itemsOf(S.store, 'events')) if (e.kind === 'event' || e.kind === 'approval') out.push(M.momentFromEvent(e));
  for (const n of noticeItems()) out.push(M.momentFromNotice(n));
  for (const s of sessions()) if (s.needs_you) out.push(jobMoment(s));
  return out;
}
function learnAgent() {
  const src = [...itemsOf(S.store, 'events'), ...itemsOf(S.store, 'notices')].map((x) => x.source || '').find((s) => /^agent:/.test(s));
  const name = src ? src.slice(6) : '';
  if (name && name !== S.agentName) { S.agentName = name; safe.set('phase.agent', name); }
}
const agentName = () => S.agentName || (S.pair && S.pair.surface_id) || 'Agent';
const quietActive = (now) => isQuietNow(now) && now >= S.quietEndedUntil;

/** First-seen times, auto-clear of notices after 20 s, and withdrawn / expired detection for the Earlier tray. */
function sweep(now) {
  const all = moments();
  const ids = new Set();
  for (const m of all) {
    if (M.WEIGHT_RANK[m.weight] < 1) continue;
    ids.add(m.id);
    if (!S.seen.has(m.id)) S.seen.set(m.id, now);
    S.known.set(m.id, { title: m.title, kind: m.weight === 'notice' ? 'notice' : m.weight, icon: m.icon || null, expires: m.expires });
    if (m.weight === 'notice' && now - S.seen.get(m.id) >= T.notice && !(S.aside.get(m.id) === m.updated)) {
      S.aside.set(m.id, m.updated); saveAside();
      earlier.add({ id: m.id, title: m.title, kind: 'notice', icon: iconFor(m), state: 'cleared', at: now });
    }
    if (m.expires !== null && m.expires <= now && !(S.aside.get(m.id) === m.updated)) {
      S.aside.set(m.id, m.updated); saveAside();
      earlier.add({ id: m.id, title: m.title, kind: m.weight, icon: iconFor(m), state: 'expired', at: now });
    }
  }
  for (const [id, k] of S.known) {
    if (ids.has(id)) continue;
    S.known.delete(id);
    const answered = S.answered && S.answered.has(id);
    const state = answered ? 'answered' : k.expires !== null && k.expires <= now ? 'expired' : 'withdrawn';
    const e = earlier.list().find((x) => x.id === id);
    if (e) { if (e.state === 'open') earlier.setState(id, state, now); }
    else if (!answered) earlier.add({ id, title: k.title, kind: k.kind, icon: k.icon, state, at: now });
    S.aside.delete(id); saveAside();
  }
}
S.answered = new Set();
S.wokeFor = new Set();
function iconFor(m) {
  if (m.icon) return m.icon;
  if (m.weight === 'urgent') return 'urgent';
  if (m.src === 'session') return 'agent';
  if (m.place) return 'place';
  return 'agent';
}
const alerts = (now) => M.alertList(moments(), S.aside, now);

/* ---------- the view model for this instant (spec 8.2) ---------- */
function vmNow(now) {
  if (!S.pair) return pairingVm(now);
  if (S.power) return Sc.powerMenu(env(now));
  if (S.capture) return captureVm(now);
  if (S.saved && now < S.saved.until) return Sc.saved({ ...env(now), length: lengthText(S.saved.len), note: 'Prototype: nothing was recorded or uploaded.', back: Math.ceil((S.saved.until - now) / 1000) });
  if (S.ptt) return listeningVm(now);
  if (S.modal) { const v = modalVm(now); if (v) return v; }
  const al = alerts(now), top = al[0];
  if (top) {
    const wakes = top.weight === 'urgent' || (top.weight === 'decision' && !isQuietNow(now));
    // A new urgent or decision Moment wakes the glass once, when it arrives; it does not hold the glass awake.
    const wk = `${top.id}|${top.updated}`;
    if (wakes && !S.wokeFor.has(wk)) { S.wokeFor.add(wk); if (S.rest !== 'awake') wake(now); }
    if (S.rest === 'awake' || wakes) return alertVm(top, al.length - 1, now);
  }
  if (S.rest === 'rest') return restVm(now);
  if (S.overlay) return overlayVm(now);
  if (S.view) { const v = viewVm(now); if (v) return v; }
  return faceVm(now);
}

function faceVm(now) {
  if (quietActive(now)) return nightVm(now);
  const stale = S.conn === 'online' && S.lastFrame && now - S.lastFrame > 30000;
  if ((S.conn !== 'online' && now - S.offlineSince > 1500) || stale) return nowVm(now, { offline: true, stale });
  if (S.face === 'day') return dayVm(now);
  if (S.face === 'agents') return agentsVm(now);
  if (S.face === 'thread') return threadVm(now);
  return nowVm(now);
}
function nowVm(now, o = {}) {
  const missed = earlier.missed(zonedMs(...ymdOf(now), 0, 0, TZ));
  const m = M.nowModel(moments(), now, TZ, { missed, quiet: SET.quiet, offline: o.offline, offlineSince: o.offline ? (o.stale ? S.lastFrame : S.offlineSince) : null });
  if (o.stale) m.top = `Last heard ${hmA(S.lastFrame, TZ)}`;
  const working = M.agentsModel(sessions(), now).working;
  const e = env(now, { noMoon: S.rest !== 'awake' });
  const vm = Sc.nowFace({ ...e, ...m, marks: m.marks, count: working || null, offline: o.offline });
  if (o.stale) vm.html = vm.html.replace('RECONNECTING', '');
  S.focusId = m.focusId;
  return vm;
}
function ymdOf(now) { const p = zparts(now, TZ); return [p.y, p.mo, p.d]; }
function dayVm(now) {
  const d = M.dayModel(moments(), now, TZ), s = sun(now);
  const bottom = s.polar ? '' : now < s.set ? `Sunset ${hmA(s.set, TZ)}` : `Sunrise ${hmA(s.rise + 86400000, TZ)}`;
  return Sc.dayList({ ...env(now), ...d, bottom, marks: M.rimMarks(moments(), now, TZ).marks });
}
function agentsVm(now) {
  const a = M.agentsModel(sessions(), now);
  if (a.nothing) return Sc.agentsNone({ ...env(now), last: a.lastDone ? `Last: ${a.lastDone.name}, ${hmA(a.lastDone.last, TZ)}` : '' });
  return Sc.agentsList({ ...env(now), top: a.caption, rows: a.rows.map((r) => ({ id: r.id, state: r.state, name: r.name, detail: r.detail })), more: a.more });
}
/** The most relevant conversation: a needs-you session's, else the one last answered or opened here, else the most recently active session's. */
function threadConv() {
  if (S.threadId) return S.threadId;
  const ss = sessions().filter((s) => s.conversation_id);
  const nv = ss.find((s) => s.needs_you);
  if (nv) return nv.conversation_id;
  if (S.lastConv) return S.lastConv;
  ss.sort((a, b) => (Date.parse(b.last_activity_at || '') || 0) - (Date.parse(a.last_activity_at || '') || 0));
  return ss[0] ? ss[0].conversation_id : null;
}
function threadVm(now) {
  const id = threadConv();
  if (!id) return Sc.thread({ ...env(now), top: 'Thread', text: '', empty: 'NO THREAD YET', scrollable: false });
  const c = loadThread(id);
  const msgs = c.messages || [];
  const m = [...msgs].reverse().find((x) => x.role === 'agent') || msgs[msgs.length - 1];
  if (!m) return Sc.thread({ ...env(now), top: c.title || 'Thread', text: '', empty: c.loading ? 'LOADING' : c.error ? caps(c.error) : 'NO MESSAGES', scrollable: false });
  const who = m.role === 'agent' ? agentName() : 'You';
  const at = Date.parse(m.created_at || '');
  const buttons = (m.buttons || []).slice(0, 3).map((b) => ({ label: b.label, act: 'tbtn', data: { bi: b.index, mid: m.id, cid: id } }));
  return Sc.thread({ ...env(now), top: `${who}${Number.isFinite(at) ? ` · ${hm(at, TZ)}` : ''}`, text: m.text || '', buttons, capState: capStateFor(`conversations:${id}`, now) });
}
function nightVm(now) {
  const e = env(now, { noMoon: false });
  const timed = M.timedMoments(moments()).filter((m) => m.start > now && m.start < now + 24 * 3600 * 1000);
  const next = timed[0];
  const dims = Math.max(0, Math.ceil((T.quietRest - (now - S.lastTouch)) / 1000));
  if (!next) return Sc.woken({ ...e, label: '', time: hm(now, TZ), unit: zparts(now, TZ).h < 12 ? 'AM' : 'PM', title: 'Nothing on', dims });
  const c = M.countdown(next.start, now, TZ);
  return Sc.woken({ ...e, label: c.tomorrow ? 'Tomorrow' : c.kind === 'min' ? `Next ${hm(next.start, TZ)}` : 'Next', time: c.kind === 'min' ? c.numeral : hm(next.start, TZ), unit: c.kind === 'min' ? 'MIN' : zparts(next.start, TZ).h < 12 ? 'AM' : 'PM', title: next.title, dims });
}
function restVm(now) {
  if (isQuietNow(now)) return Sc.resting({ clock: hm(now, TZ), until: `Quiet until ${hmA(M.quietEndsAt(now, TZ, SET.quiet), TZ)}` });
  return nowVm(now);
}

/* alerts */
function alertPills(m, max = 2) {
  const acts = m.actions.slice(0, max).map((a) => ({ label: a.label, act: 'aact', data: { aid: a.id } }));
  if (!acts.length) acts.push({ label: 'Got it', act: 'aack' });
  else if (acts.length === 1) acts.push({ label: 'Dismiss', act: 'aack' });
  return acts;
}
function withActState(list, m, now) {
  const st = S.act && S.act.object === m.object ? actPhase(now) : null;
  if (!st) return list;
  return list.map((p) => (p.data && p.data.aid === S.act.actionId ? { ...p, label: st === 'waiting' ? 'Waiting' : st === 'failed' ? '◆ Try again' : p.label } : p));
}
function alertVm(m, more, now) {
  S.shownAlert = m.id;
  const e = env(now);
  const top = more > 0 ? `${more} more` : '';
  const arrival = m.arrival ?? S.seen.get(m.id) ?? now;
  if (m.weight === 'urgent') {
    const lit = drainLit(arrival, m.expires ?? NaN, now);
    if (m.src === 'event' && m.travel) {
      const leaveNow = !m.travel.leave_by || m.travel.leave_by <= now + 60000;
      const word = { walk: 'WALK', drive: 'DRIVE', transit: 'TRANSIT', bike: 'BIKE', train: 'TRAIN' }[m.travel.mode] || 'TRAVEL';
      return Sc.nowAlert({ ...e, top: top || `Time to go · ${hmA(now, TZ)}`, bottom: m.start ? `${m.title} at ${hm(m.start, TZ)}` : m.title, verdict: leaveNow ? ['Leave', 'Now'] : ['Leave', hm(m.travel.leave_by, TZ)], sub: `${m.travel.minutes} min ${word}`, lit, pills: withActState(alertPills(m), m, now) });
    }
    const changed = m.changed ? { old: String(m.changed.old ?? ''), new: String(m.changed.new) } : null;
    return Sc.urgent({ ...e, top, title: m.title, changed, detail: m.note || m.place, consequence: m.consequence, lit, pills: withActState(alertPills(m), m, now) });
  }
  if (m.weight === 'decision') {
    let win = null;
    if (m.expires && m.expires > now) { const a1 = clockDeg(zparts(now, TZ).h, zparts(now, TZ).m); win = { a1, a2: a1 + (Math.min(m.expires - now, H12 - 60000) / H12) * 360 }; }
    if (m.src === 'session') return waitingVm(m, now, e, top);
    const src = (m.source || '').replace(/^agent:/, '') || agentName();
    if (m.src === 'approval') {
      return Sc.decision({ ...e, top, who: 'Needs you · Approval', headline: m.title, preview: m.preview ? m.preview.text : '', quote: false, meta: `Asked by ${src}`, actions: [{ label: 'Review', act: 'review' }, { label: 'Later', act: 'later' }], window: win });
    }
    const draft = m.actions.find((a) => a.draft);
    const acts = draft ? [{ label: 'Review', act: 'review', data: { aid: draft.id } }] : m.actions.slice(0, 2).map((a) => ({ label: a.label, act: 'aact', data: { aid: a.id } }));
    if (acts.length < 3) acts.push({ label: 'Later', act: 'later' });
    return Sc.decision({ ...e, top, who: `Needs you · ${src}`, headline: m.title, preview: draft ? draft.draft : m.note || '', quote: !!draft, meta: draft ? `Draft by ${src}` : '', actions: withActState(acts, m, now), window: win });
  }
  const left = Math.max(0, T.notice - (now - (S.seen.get(m.id) ?? now)));
  return Sc.inform({ ...e, top, icon: iconFor(m), title: m.title, detail: [m.note, m.arrival ? hmA(m.arrival, TZ) : ''].filter(Boolean).join(' · '), clears: Math.ceil(left / 1000), remaining: left / T.notice });
}
function waitingVm(m, now, e, top) {
  const s = m.session, q = m.question;
  ensureQuestion(s);
  const opts = (q ? q.options : []).slice(0, 2).map((o) => ({ label: o.label, act: 'qopt', data: { bi: o.index, mid: q.messageId, cid: s.conversation_id } }));
  opts.push({ label: 'Open', act: 'qopen', data: { cid: s.conversation_id || '' } });
  const since = Date.parse(s.since || '');
  return Sc.agentWaiting({ ...e, top, who: `${s.title || m.title} · Needs you`, question: q ? q.text : 'Waiting for your answer', asked: q && q.at ? `Asked ${agoText(q.at, now).toLowerCase()}` : '', running: Number.isFinite(since) ? `Running ${Math.max(1, Math.round((now - since) / 60000))} min` : '', options: opts, capState: s.conversation_id ? capStateFor(`conversations:${s.conversation_id}`, now) : null });
}

/* modal: confirm and sent */
function modalVm(now) {
  const md = S.modal;
  if (md.type === 'sent') {
    if (now >= md.until) { S.modal = null; S.face = 'now'; S.view = null; return null; }
    return Sc.sent({ ...env(now), words: md.words, back: Math.ceil((md.until - now) / 1000), beats: 2 });
  }
  if (md.type === 'confirm') {
    const st = S.act && S.act.object === md.object ? actPhase(now) : null;
    return Sc.confirm({ ...env(now), to: md.to, text: md.text, left: md.left, right: { label: 'Cancel', act: 'ccancel' }, state: st });
  }
  return null;
}
function listeningVm(now) {
  const p = S.ptt;
  return Sc.listening({ ...env(now), transcript: p.transcript, placeholder: p.supported ? 'Listening…' : 'Voice is not available in this browser', elapsed: mss((now - p.since) / 1000), release: p.supported ? 'Release to send' : 'Nothing will be sent' });
}
function captureVm(now) {
  const c = S.capture, sec = (now - c.since) / 1000;
  const alert = alerts(now).some((m) => m.weight === 'urgent') ? '1 ALERT' : '';
  if (now - c.lastTouch > 60000) return Sc.hourIn({ elapsed: timer(sec, true), title: 'Conversation', alert });
  return Sc.recording({ elapsed: timer(sec), title: 'Conversation', sub: 'Prototype · nothing is recorded', alert });
}
function pairingVm(now) {
  const v = parsePairInput($('input').value).toUpperCase();
  const parts = v ? (v.includes('-') ? v.split('-').slice(0, 2) : [v.slice(0, Math.ceil(v.length / 2)), v.slice(Math.ceil(v.length / 2))]) : ['···', '···'];
  return Sc.pairing({ ...env(now), label: v ? 'Pairing code' : 'Paste a pairing code', code: parts.map((x) => x.slice(0, 6)), expires: S.pairError || (v ? 'Tap pair below the dial' : 'Below the dial'), waiting: S.pairing ? 'Waiting for your agent' : '', cancel: 'The bus issues the code for now', lit: 0 });
}

/* overlays (spec 6: Settings, Earlier) and their sub-screens */
function overlayVm(now) {
  const e = env(now, { noMoon: true });
  switch (S.overlay) {
    case 'earlier': return earlierVm(now);
    case 'settings': return Sc.settings({ ...e, brightness: SET.brightness, volume: SET.volume, quiet: SET.quiet.on ? `${shortHour(SET.quiet.start)}–${shortHour(SET.quiet.end)}` : 'OFF', daylight: SET.loc ? caps(SET.loc.city).slice(0, 11) : 'NOT SET', agent: caps(agentName()).slice(0, 11) });
    case 'cities': return Sc.cityPicker({ ...e, note: S.cityNote || '', rows: [{ label: 'Use phone location', value: SET.loc && SET.loc.source === 'phone' ? '✓' : '' }, ...CITIES.map((c) => ({ label: c.city, value: SET.loc && SET.loc.source === 'picked' && SET.loc.city === c.city ? '✓' : '', on: !!(SET.loc && SET.loc.city === c.city && SET.loc.source === 'picked') }))] });
    case 'connected': {
      const ago = S.lastFrame ? Math.round((now - S.lastFrame) / 1000) : null;
      return Sc.connected({ ...env(now), state: S.conn === 'online' ? 'Connected' : S.conn === 'connecting' ? 'Reconnecting' : 'Offline', dot: S.conn === 'online' ? 'rose' : 'hair', agent: agentName(), account: S.pair ? `${S.pair.surface_id || 'surface'} surface` : '', line: `${S.pairedAt ? `Paired ${monthDay(S.pairedAt, TZ)}` : 'Paired earlier'}${ago !== null ? ` · synced ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago` : ''}` });
    }
    default: S.overlay = null; return faceVm(now);
  }
}
function earlierVm(now) {
  const list = earlier.list();
  const rows = list.slice(0, 3).map((x) => {
    const g = x.state === 'open' ? glyph('waiting', 26) : x.kind === 'urgent' ? icon('urgent', 26, 'rose') : x.state === 'answered' ? glyph('done', 26) : icon(x.icon || 'agent', 26, 'ink');
    return { id: x.id, glyph: g, name: x.title, detail: M.earlierDetail(x, TZ), open: x.state === 'open' };
  });
  return Sc.earlier({ ...env(now), rows, more: list.length > 3 ? `+${list.length - 3} MORE` : '' });
}
function viewVm(now) {
  const v = S.view;
  if (v.type === 'detail') {
    const all = moments(), m = all.find((x) => x.id === v.id);
    if (!m) { S.view = null; return null; }
    const d = M.detailModel(m, all, now, TZ);
    const mk = M.rimMarks([m], now, TZ).marks;
    return Sc.eventDetail({ ...env(now), ...d, actions: m.actions, selected: m.id, marks: mk, capState: capStateFor(m.object, now) });
  }
  if (v.type === 'understood') {
    const u = S.utter;
    if (!u) { S.view = null; return null; }
    const ph = utterPhase(now);
    const status = { sending: 'SENDING', waiting: 'WAITING', failed: '◆ TRY AGAIN', ok: 'UNDERSTOOD' }[ph];
    const answer = u.reply ? (u.reply.body && u.reply.body.length <= 120 ? u.reply.body : glanceOf(u.reply)) : '';
    return Sc.understood({ ...env(now), status, ok: ph === 'ok', statusTone: ph === 'failed' ? 'amber' : 'ink-2', heard: u.text, agent: agentName(), answer, pending: ph === 'ok' && !u.reply, buttons: [{ label: 'Open', act: 'uopen' }] });
  }
  return null;
}

/* ---------- action states (spec 5.6, 7.3: never claim success without an answer) ---------- */
function actPhase(now) {
  const a = S.act;
  if (!a) return null;
  if (a.result) return a.result.state === 'sent' || a.result.state === 'already' ? 'sent' : 'failed';
  return now - a.at < T.noAck ? 'sending' : 'waiting';
}
function capStateFor(object, now) {
  if (!S.act || S.act.object !== object) return null;
  const ph = actPhase(now);
  if (ph === 'sending') return null;
  if (ph === 'sent' && now - S.act.doneAt > 2500) return null;
  return { kind: ph };
}
function utterPhase(now) {
  const u = S.utter;
  if (u.acked) return 'ok';
  if (u.rejected || now - u.at > T.actTimeout) return 'failed';
  return now - u.at < T.noAck ? 'sending' : 'waiting';
}
const fetchT = (url, opts) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), T.actTimeout); return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t)); };
/** Fire one action through the shared action path. onSent runs only on a done (or already done) answer from the bus. */
async function fire({ object, actionId, action = null, draft, messageId, label = '', onSent }) {
  if (!S.pair) return;
  S.act = { object, actionId: String(actionId), label, at: Date.now(), result: null };
  const mine = S.act;
  paint();
  if (!S.v2 && object.startsWith('notices:') && sock) {
    // Legacy path: notice taps go through the outbox; the ack is the answer.
    const item = sock.sendAction(object.slice(8), Number(actionId));
    S.pendingV1 = { cmid: item.client_msg_id, act: mine, onSent };
    return;
  }
  const r = await submitAction({ fetchImpl: fetchT, url: surfaceUrl('actions'), token: S.pair.token, object, actionId: String(actionId), action, draft, messageId, states: S.btns });
  if (S.act !== mine) return;
  mine.result = r.interp; mine.doneAt = Date.now();
  if ((r.interp.state === 'sent' || r.interp.state === 'already') && onSent) onSent();
  if (r.interp.state === 'failed' && !r.interp.disabled) setTimeout(paint, 4100);
  paint();
}
const sentScreen = (words) => { S.modal = { type: 'sent', words, until: Date.now() + T.sent }; paint(); };
function answered(m) { S.answered.add(m.id); S.aside.set(m.id, m.updated); saveAside(); }

/* ---------- sends: typed and spoken ---------- */
function sendUtterance(text) {
  if (!sock || !text) return;
  const item = sock.send(text);
  S.utter = { text, cmid: item.client_msg_id, at: Date.now(), acked: false, rejected: false, iid: null, reply: null };
  S.view = { type: 'understood' }; S.overlay = null;
  paint();
}

/* ---------- rest and wake (spec 8.3, 11.1) ---------- */
function touch(now = Date.now()) { S.lastTouch = now; if (S.capture) S.capture.lastTouch = now; }
function wake(now = Date.now()) {
  const was = S.rest;
  S.rest = 'awake'; touch(now);
  if (was !== 'awake') { $('dimmer').classList.add('wake'); setTimeout(() => $('dimmer').classList.remove('wake'), 250); }
  if (was === 'rest' && isQuietNow(now) && now >= S.quietEndedUntil) { S.face = 'now'; S.overlay = null; S.view = null; }
}
function restTick(now) {
  if (S.frozen || !S.pair || S.capture || S.ptt) return;
  const idle = now - S.lastTouch;
  const quiet = quietActive(now);
  if (quiet) S.rest = idle >= T.quietRest ? 'rest' : 'awake';
  else S.rest = idle >= T.rest ? 'rest' : idle >= T.dim ? 'dim' : 'awake';
  // Day, Agents, Thread, Earlier, Settings untouched for 60 s: back to Now.
  if (idle >= T.home && (S.face !== 'now' || S.overlay || S.view) && !S.modal) { S.face = 'now'; S.overlay = null; S.view = null; S.threadId = null; }
}
function applyBrightness(now) {
  const quietRest = S.rest === 'rest' && isQuietNow(now);
  const dim = S.frozen ? 0 : S.rest === 'dim' ? 0.6 : S.rest === 'rest' && !quietRest ? 0.8 : 0;
  $('dimmer').style.opacity = String(dim);
  $('bright').style.opacity = S.frozen ? '0' : String(Math.max(0, Math.min(0.85, (1 - SET.brightness) * 0.85)));
}

/* ---------- painting ---------- */
let lastHtml = '', lastKey = '', pendingTx = null, holding = false, deferred = false;
function screenKey(vm) { return `${vm.screen}|${S.face}|${S.overlay || ''}|${S.view ? S.view.type + (S.view.id || '') : ''}|${S.modal ? S.modal.type : ''}`; }
function paint(tx = null) {
  if (tx) pendingTx = tx;
  if (holding) { deferred = true; return; }
  const now = S.frozen ? S.frozenAt : Date.now();
  if (!S.frozen) { sweep(now); restTick(now); }
  let vm;
  if (S.frozen) vm = buildState(S.demoId || STATE_ID) || Sc.nowFace({ label: 'UNKNOWN STATE', numeral: '?', marks: [] });
  else vm = vmNow(now);
  const walk = S.frozen ? { x: 0, y: 0 } : walkAt(Math.floor(now / 60000));
  const html = compose(vm, S.frozen ? { x: 0, y: 0 } : walk);
  const key = screenKey(vm);
  applyBrightness(now);
  updateChrome();
  if (html === lastHtml && !pendingTx) return;
  const face = $('face');
  const scrolls = [...face.querySelectorAll('[data-scroller]')].map((el) => el.scrollTop);
  let txn = pendingTx; pendingTx = null;
  if (!txn && key !== lastKey && lastKey) {
    if (vm.ground === 'rose' && !lastKey.startsWith('alert') && !lastKey.startsWith('urgent')) txn = 'flood';
    else if (vm.screen === 'now' && /^(alert|urgent|decision|inform|waiting)/.test(lastKey)) txn = 'clear';
  }
  const old = face.firstElementChild;
  const tpl = document.createElement('div'); tpl.innerHTML = html;
  const nu = tpl.firstElementChild;
  const rm = reduced();
  if (old && txn && !S.frozen) {
    const cls = { 'slide-l': ['out-l', 'in-l'], 'slide-r': ['out-r', 'in-r'], 'slide-u': ['out-u', 'in-u'], 'slide-d': ['out-d', 'in-d'], 'step-l': ['step-out step-out-l', 'step-in-l'], 'step-r': ['step-out step-out-r', 'step-in-r'], clear: ['clear-out', 'fade-in'], fade: ['xfade-out', 'fade-in'] }[txn];
    if (txn === 'flood') {
      face.replaceChildren(nu);
      if (!rm) { const cov = document.createElement('div'); cov.className = 'floodcover'; nu.appendChild(cov); setTimeout(() => cov.remove(), 520); }
    } else if (cls) {
      const [o, n] = rm ? ['xfade-out', 'xfade-in'] : cls;
      face.querySelectorAll('.ph').forEach((x) => { if (x !== old) x.remove(); });
      old.className += ` ${o}`; nu.className += ` ${n}`;
      face.appendChild(nu);
      setTimeout(() => { old.remove(); nu.classList.remove(...n.split(' ')); }, rm ? 170 : 340);
    } else face.replaceChildren(nu);
  } else face.replaceChildren(nu);
  if (key === lastKey) face.querySelectorAll('[data-scroller]').forEach((el, i) => { if (scrolls[i] !== undefined) el.scrollTop = scrolls[i]; });
  lastHtml = html; lastKey = key;
  afterPaint();
  tickMoon();
}
function afterPaint() {
  const face = $('face');
  face.querySelectorAll('.cscroll').forEach((el) => el.classList.toggle('fits', el.scrollHeight <= el.clientHeight + 2));
  const sc = face.querySelector('.tscroll');
  if (sc) { const upd = () => thumb(sc); sc.addEventListener('scroll', upd, { passive: true }); upd(); }
}
function thumb(sc) {
  const t = sc.closest('.ph') && sc.closest('.ph').querySelector('.thumb');
  if (!t) return;
  const h = sc.scrollHeight, v = sc.clientHeight;
  if (h <= v + 2) { t.setAttribute('height', '120'); t.setAttribute('y', '140'); return; }
  const th = Math.max(24, (v / h) * 120), y = 140 + (sc.scrollTop / (h - v)) * (120 - th);
  t.setAttribute('height', th.toFixed(1)); t.setAttribute('y', y.toFixed(1));
}
/** The second hand: step the moon on each second boundary (spec 5.2); parked at 12 o'clock under reduced motion. */
function tickMoon() {
  if (S.frozen && !DEMO) return;
  const now = S.frozen ? S.frozenAt + (Date.now() - S.demoT0) : Date.now();
  const parked = reduced() || (S.ptt && !S.frozen);
  const deg = moonDeg(zparts(now, TZ).s, parked);
  $('face').querySelectorAll('.moon').forEach((g) => g.setAttribute('transform', `rotate(${deg} ${g.dataset.x} ${g.dataset.y})`));
}
function loop() {
  const now = Date.now();
  if (!S.frozen) paint(); else tickMoon();
  setTimeout(loop, 1000 - (now % 1000) + 2);
}

/* ---------- chrome ---------- */
function note(text, ms = 4000) { const n = $('note'); n.textContent = text; n.dataset.sticky = '1'; clearTimeout(note.t); note.t = setTimeout(() => { delete n.dataset.sticky; updateChrome(); }, ms); }
function updateChrome() {
  if (S.frozen) return;
  const labels = { online: 'Connected', connecting: 'Connecting', offline: 'Offline' };
  $('dot').className = `dot ${S.pair ? S.conn : ''}`;
  $('dotlabel').textContent = S.pair ? labels[S.conn] : 'Not paired';
  $('input').placeholder = S.pair ? `Message ${agentName()}` : 'Paste pairing code';
  $('go').textContent = S.pair ? 'SEND' : 'PAIR';
  const n = sock ? sock.outbox.size : 0;
  if (!$('note').dataset.sticky) $('note').textContent = n && S.conn !== 'online' ? `${n} waiting to send` : '';
}

/* ---------- sizing (same rules as the main client) ---------- */
if (params.has('ppi')) safe.set('intercom.ppi', String(clampPpi(params.get('ppi'))));
const getPpi = () => { const v = safe.get('intercom.ppi'); return v == null ? DEFAULT_PPI : clampPpi(v); };
const getDiam = () => { const d = Number(params.get('diam')); return d > 0 ? d : DIAL_INCHES; };
function applySize() {
  if (S.frozen && !DEMO) { document.documentElement.style.setProperty('--dial', '466px'); document.documentElement.style.setProperty('--s', '1'); return; }
  const large = ls.get('intercom.large') === '1';
  const wrap = document.querySelector('.stagewrap');
  let dial = 268, landscape = false;
  try { landscape = matchMedia(LANDSCAPE_QUERY).matches; } catch { /* portrait */ }
  if (landscape) dial = physicalDialSize(getPpi(), getDiam(), wrap.clientHeight || document.documentElement.clientHeight - 24);
  else if (large) { const w = wrap.clientWidth || document.documentElement.clientWidth - 32; const h = wrap.clientHeight || w; dial = Math.floor((Math.min(w, h) * 466) / 506); }
  document.documentElement.style.setProperty('--dial', `${dial}px`);
  document.documentElement.style.setProperty('--s', String(dial / 466));
  $('size').textContent = large ? 'True size' : 'Large';
}
function wireCalibrate() {
  if (!params.has('calibrate')) return;
  const paintCal = () => { const p = getPpi(); $('calbar').style.width = `${p}px`; $('calval').textContent = `${p} px/in`; applySize(); };
  const bump = (d) => { safe.set('intercom.ppi', String(clampPpi(getPpi() + d))); paintCal(); };
  $('calminus').addEventListener('click', () => bump(-1)); $('calplus').addEventListener('click', () => bump(1));
  $('calibrate').hidden = false; paintCal();
}

/* ---------- conversations (Thread face, waiting questions) ---------- */
function loadThread(id) {
  let c = S.threads.get(id);
  if (!c) { c = { id, messages: [], loading: true, error: '', title: '', at: 0 }; S.threads.set(id, c); fetchThread(id); }
  else if (!c.loading && Date.now() - c.at > 15000) { c.loading = true; fetchThread(id).then(() => { c.loading = false; }); }
  if (S.v2 && sock && S.viewSent !== `conversation:${id}`) { if (sock.sendView(`conversation:${id}`)) S.viewSent = `conversation:${id}`; }
  return c;
}
/** Merge a fetched page into the held messages: fresh copies win (buttons close once answered), chronological order. */
function mergePage(held, page) {
  const byId = new Map(held.map((m) => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  const t = (m) => Date.parse(m.created_at || '') || 0;
  return [...byId.values()].sort((a, b) => t(a) - t(b));
}
async function fetchThread(id, limit = 30) {
  if (!S.pair) return null;
  const c = S.threads.get(id) || { id, messages: [] };
  try {
    const r = await fetch(surfaceUrl(`conversations/${encodeURIComponent(id)}?limit=${limit}`), { headers: auth() });
    if (!r.ok) { c.error = r.status === 404 ? 'Not available' : `Could not load (${r.status})`; }
    else { const j = await r.json(); c.messages = mergePage(c.messages, j.messages || []); c.title = j.title || c.title; c.error = ''; }
  } catch { c.error = 'Could not load'; }
  c.loading = false; c.at = Date.now();
  S.threads.set(id, c);
  paint();
  return c;
}
/** After an answer the agent usually writes back: fetch the thread again shortly (live appends also arrive while it is open). */
function refreshThreadSoon(id) { if (id) { S.lastConv = id; setTimeout(() => fetchThread(id), 600); setTimeout(() => fetchThread(id), 2500); } }
function ensureQuestion(s) {
  if (!s.conversation_id) return;
  const key = `${s.id}|${s.needs_you_message_id || ''}`;
  if (S.qKeys && S.qKeys.has(key)) return;
  (S.qKeys ||= new Set()).add(key);
  fetchThread(s.conversation_id, 10).then((c) => {
    const q = c && M.questionOf(s, c.messages);
    if (q) { S.questions.set(s.id, q); paint(); }
  });
}

/* ---------- socket ---------- */
function onEvent(name, d) {
  switch (name) {
    case 'notification': applyNotification(S.v1notes, d); break;
    case 'reply':
      if (S.utter && !S.utter.reply && replyIsFresh(d, Date.now()) && (!S.utter.iid || !d.interaction_id || d.interaction_id === S.utter.iid)) S.utter.reply = d;
      break;
    case 'conversation_append': {
      const c = S.threads.get(d.conversation_id);
      if (c && appendMessage(c.messages, d.message)) { /* new message */ }
      break;
    }
    default: break;
  }
  paint();
}
function startSocket() {
  if (!S.pair) return;
  sock = new IntercomSocket({
    token: S.pair.token,
    getRevs: () => revsOf(S.store),
    handlers: {
      onDelta(f) { S.lastFrame = Date.now(); if (applyDelta(S.store, f) === 'gap') resync(); learnAgent(); paint(); },
      // A path switch while offline keeps the last data (the dial counts on locally); a v1 welcome drops the v2 store.
      onMode() { /* nothing until a welcome says which protocol answered */ },
      onWelcome(f) { if (f.version !== 2 && S.v2) S.store = createStore(); S.v2 = f.version === 2; S.lastFrame = Date.now(); S.viewSent = null; if (S.v2) resync(true); paint(); },
      onState(st) {
        if (st === 'online') { S.lastOnline = Date.now(); S.lastFrame = Date.now(); }
        if (S.conn === 'online' && st !== 'online') S.offlineSince = Date.now();
        S.conn = st; paint(); if (st !== 'online') setTimeout(paint, 1600);
      },
      onEvent(n, d) { S.lastFrame = Date.now(); onEvent(n, d); },
      onReset() { S.v1notes.clear(); },
      onAck(f) {
        S.lastFrame = Date.now();
        if (S.utter && f.client_msg_id === S.utter.cmid) { if (f.status === 'queued') { S.utter.acked = true; S.utter.iid = f.interaction_id || null; } else if (f.status === 'rejected') S.utter.rejected = true; }
        if (S.pendingV1 && f.client_msg_id === S.pendingV1.cmid) {
          const p = S.pendingV1; S.pendingV1 = null;
          p.act.result = f.status === 'queued' ? { state: 'sent' } : { state: 'failed', disabled: false }; p.act.doneAt = Date.now();
          if (f.status === 'queued' && p.onSent) p.onSent();
        }
        paint();
      },
      onUnauthorized() { unpair('Pairing was rejected. Paste a new code.'); },
      onError(f) { if (f.code === 'unauthorized') unpair('Pairing was rejected. Paste a new code.'); },
    },
  });
  sock.start();
}
let resyncAt = 0;
async function resync(force = false) {
  if (!S.pair || !S.surfaceHttp || (!S.v2 && !force)) return;
  if (!force && Date.now() - resyncAt < 2000) return;
  resyncAt = Date.now();
  try {
    const r = await fetch(surfaceUrl('state'), { headers: auth() });
    if (r.status === 401 || r.status === 403 || r.status === 404) { S.surfaceHttp = false; return; }
    if (r.ok) { applyState(S.store, await r.json()); learnAgent(); paint(); }
  } catch { /* offline */ }
}

/* ---------- pairing ---------- */
async function pair(code) {
  if (!code) { S.pairError = 'Enter the pairing code'; paint(); return; }
  S.pairError = 'Pairing…'; S.pairing = true; paint();
  try {
    const r = await fetch(apiUrl('api/v1/intercom/pair'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (r.ok) {
      const j = await r.json();
      S.pair = { surface_id: j.surface_id, token: j.token };
      ls.set('intercom.pair', JSON.stringify(S.pair)); ls.set('intercom.cursor', '0');
      S.pairedAt = Date.now(); safe.set('phase.pairedAt', String(S.pairedAt));
      S.pairError = ''; S.pairing = false; S.conn = 'connecting'; S.offlineSince = Date.now(); $('input').value = '';
      startSocket(); paint(); return;
    }
    S.pairError = { 400: 'Not a code', 404: 'Code not recognised', 410: 'Code expired or used', 429: 'Too many tries' }[r.status] || `Pairing failed (${r.status})`;
  } catch { S.pairError = 'Could not reach the bus'; }
  S.pairing = false; paint();
}
function unpair(msg = '') {
  sock?.stop(); sock = null;
  ['intercom.pair', 'intercom.cursor', 'intercom.outbox'].forEach((k) => ls.del(k));
  Object.assign(S, { pair: null, conn: 'offline', v2: false, store: createStore(), btns: new ButtonStates(), v1notes: new Map(), overlay: null, view: null, modal: null, threads: new Map(), questions: new Map(), pairError: msg, utter: null, act: null });
  paint();
}

/* ---------- taps ---------- */
function currentAlert() { const now = Date.now(); return alerts(now)[0] || null; }
function setAside(m) {
  if (!m) return;
  S.aside.set(m.id, m.updated); saveAside();
  earlier.add({ id: m.id, title: m.title, kind: m.weight === 'notice' ? 'notice' : m.weight, icon: iconFor(m), state: 'open', at: Date.now(), object: m.object });
}
function onTap(el) {
  const act = el.dataset.act, d = el.dataset;
  const now = Date.now();
  const al = currentAlert();
  switch (act) {
    case 'numeral': { if (S.focusId) { S.view = { type: 'detail', id: S.focusId }; paint('fade'); } return; }
    case 'dayrow': if (d.id) { S.view = { type: 'detail', id: d.id }; paint('fade'); } return;
    case 'prev': case 'next': stepDetail(act === 'next' ? 1 : -1); return;
    case 'eact': {
      const m = moments().find((x) => S.view && x.id === S.view.id);
      const a = m && m.actions.find((x) => x.id === d.aid);
      if (!a) return;
      if (a.draft) { openConfirm(m, a); return; }
      if (a.kind === 'hold') return; // fires on the completed hold only
      fire({ object: m.object, actionId: a.id, action: a.raw, label: a.label });
      return;
    }
    case 'aact': {
      if (!al) return;
      const a = al.actions.find((x) => x.id === d.aid);
      if (!a) return;
      if (S.act && S.act.object === al.object && S.act.result && S.act.result.state === 'failed' && S.act.result.disabled) return;
      if (a.draft) { openConfirm(al, a); return; }
      fire({ object: al.object, actionId: a.id, action: a.raw, label: a.label, onSent: () => { answered(al); sentScreen(`${agentName()} has “${a.label}”.`); } });
      return;
    }
    case 'aack': {
      if (!al) return;
      if (al.src === 'notice' && sock) sock.ackNotification(al.id);
      S.aside.set(al.id, al.updated); saveAside();
      earlier.add({ id: al.id, title: al.title, kind: al.weight === 'notice' ? 'notice' : al.weight, icon: iconFor(al), state: 'cleared', at: now });
      paint('clear'); return;
    }
    case 'gotit': {
      if (!al) return;
      if (al.src === 'notice' && sock) sock.ackNotification(al.id);
      S.aside.set(al.id, al.updated); saveAside();
      earlier.add({ id: al.id, title: al.title, kind: 'notice', icon: iconFor(al), state: 'cleared', at: now });
      paint('clear'); return;
    }
    case 'later': setAside(al); paint('clear'); return;
    case 'review': {
      if (!al) return;
      if (al.src === 'approval') {
        const ap = al.actions.find((x) => x.id === 'approve') || al.actions[0];
        const dn = al.actions.find((x) => x.id === 'deny');
        S.modal = { type: 'confirm', object: al.object, m: al, a: ap, to: 'Approve exactly this', text: al.preview ? al.preview.text : al.title, left: dn ? { label: 'Deny', act: 'cdeny', hold: 'HOLD TO DENY' } : null, approval: true };
        paint('fade'); return;
      }
      const a = al.actions.find((x) => x.id === d.aid) || al.actions.find((x) => x.draft);
      if (a) openConfirm(al, a);
      return;
    }
    case 'ccancel': S.modal = null; paint('fade'); return;
    case 'qopt': {
      const m = al && al.src === 'session' ? al : null;
      fire({ object: `conversations:${d.cid}`, actionId: d.bi, messageId: d.mid, label: el.textContent, onSent: () => { if (m) answered(m); sentScreen(`${agentName()} has “${caps(el.textContent)}”.`); refreshThreadSoon(d.cid); } });
      return;
    }
    case 'qopen': if (al) setAside(al); S.threadId = d.cid || null; S.lastConv = d.cid || S.lastConv; S.face = 'thread'; S.overlay = null; S.view = null; paint('fade'); return;
    case 'tbtn': fire({ object: `conversations:${d.cid}`, actionId: d.bi, messageId: d.mid, label: el.textContent, onSent: () => refreshThreadSoon(d.cid) }); return;
    case 'retry': {
      if (S.act && S.act.result && S.act.result.state === 'failed') { const a = S.act; fire({ object: a.object, actionId: a.actionId, label: a.label }); }
      else if (S.utter && utterPhase(now) === 'failed' && sock) { sendUtterance(S.utter.text); }
      return;
    }
    case 'uopen': S.view = null; S.face = 'thread'; paint('fade'); return;
    case 'erow': {
      const e = earlier.list().find((x) => x.id === d.id);
      if (e && e.state === 'open') { S.aside.delete(e.id); saveAside(); earlier.remove(e.id); S.overlay = null; paint('fade'); }
      return;
    }
    case 'job': {
      const j = sessions().find((s) => s.id === d.id);
      if (j && j.conversation_id) { S.threadId = j.conversation_id; S.lastConv = j.conversation_id; S.face = 'thread'; paint('slide-l'); }
      return;
    }
    case 'squiet': { const i = QUIET_PRESETS.findIndex((q) => q.on === SET.quiet.on && q.start === SET.quiet.start && q.end === SET.quiet.end); SET.quiet = QUIET_PRESETS[(i + 1) % QUIET_PRESETS.length]; saveSettings(); paint(); return; }
    case 'sdaylight': S.overlay = 'cities'; S.cityNote = ''; paint('fade'); return;
    case 'sagent': S.overlay = 'connected'; paint('fade'); return;
    case 'city': {
      const i = Number(d.i);
      if (i === 0) usePhoneLocation();
      else { const c = CITIES[i - 1]; SET.loc = { ...c, source: 'picked' }; saveSettings(); sunCache.key = ''; S.overlay = 'settings'; paint('fade'); }
      return;
    }
    case 'endquiet': S.quietEndedUntil = M.quietEndsAt(now, TZ, SET.quiet); S.rest = 'awake'; paint('fade'); return;
    case 'psleep': S.power = false; S.lastTouch = 0; S.rest = 'rest'; paint(); return;
    case 'preload': location.reload(); return;
    case 'pcancel': S.power = false; paint(); return;
    case 'undo': return;
    default: return;
  }
}
function openConfirm(m, a) {
  const to = (a.raw && a.raw.confirm && a.raw.confirm.prompt) || `Sends as you · ${agentName()}`;
  S.modal = { type: 'confirm', object: m.object, m, a, to, text: a.draft, left: null };
  paint('fade');
}
/** Completed holds (0.8 s): the only way anything that sends or cannot be undone fires. */
function onHold(el) {
  const act = el.dataset.act, d = el.dataset;
  switch (act) {
    case 'csend': {
      const md = S.modal;
      if (!md || md.type !== 'confirm') return;
      const draft = md.approval ? undefined : md.text;
      fire({ object: md.object, actionId: md.a.id, action: md.a.raw, draft, label: md.a.label, onSent: () => { answered(md.m); S.modal = null; sentScreen(md.approval ? `Approved for ${agentName()}.` : `${agentName()} sent it exactly as shown.`); } });
      return;
    }
    case 'cdeny': {
      const md = S.modal;
      if (!md || !md.approval) return;
      const dn = md.m.actions.find((x) => x.id === 'deny');
      if (dn) fire({ object: md.object, actionId: dn.id, action: dn.raw, label: dn.label, onSent: () => { answered(md.m); S.modal = null; sentScreen(`Denied. ${agentName()} will be told.`); } });
      return;
    }
    case 'eact': {
      const m = moments().find((x) => S.view && x.id === S.view.id);
      const a = m && m.actions.find((x) => x.id === d.aid);
      if (a && !a.draft) fire({ object: m.object, actionId: a.id, action: a.raw, label: a.label });
      return;
    }
    case 'eclear': earlier.clear(); paint(); return;
    case 'disconnect': unpair(''); return;
    case 'capstop': stopCapture(); return;
    default: onTap(el);
  }
}

/* ---------- navigation ---------- */
const FACES = ['day', 'now', 'agents', 'thread'];
function swipe(dx, dy, startEl) {
  const horiz = Math.abs(dx) > Math.abs(dy);
  if (S.capture || S.ptt || S.power || !S.pair) return;
  if (S.modal) return;
  if (S.overlay) {
    if (!horiz && dy < 0 && (S.overlay === 'settings')) { S.overlay = null; paint('slide-u'); }
    else if (!horiz && dy < 0 && (S.overlay === 'cities' || S.overlay === 'connected')) { S.overlay = 'settings'; paint('fade'); }
    else if (!horiz && dy > 0 && S.overlay === 'earlier') { S.overlay = null; paint('slide-d'); }
    return;
  }
  if (alerts(Date.now())[0]) return; // takeovers own the glass; the power button sets them aside
  if (horiz) {
    if (S.view && S.view.type === 'detail') { stepDetail(dx < 0 ? 1 : -1); return; }
    if (quietActive(Date.now())) return;
    const i = FACES.indexOf(S.face), j = Math.max(0, Math.min(FACES.length - 1, i + (dx < 0 ? 1 : -1)));
    if (j === i) return;
    S.face = FACES[j]; S.view = null; if (S.face !== 'thread') S.threadId = null;
    paint(dx < 0 ? 'slide-l' : 'slide-r');
    return;
  }
  if (startEl && startEl.closest('[data-scroller]')) return;
  if (dy < 0) { S.overlay = 'earlier'; S.view = null; paint('slide-u'); }
  else { S.overlay = 'settings'; S.view = null; paint('slide-d'); }
}
function stepDetail(d) {
  const now = Date.now();
  const list = M.timedMoments(moments()).filter((m) => (m.end ?? m.start) >= now || m.id === (S.view && S.view.id));
  const i = list.findIndex((m) => m.id === S.view.id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return;
  S.view = { type: 'detail', id: list[j].id };
  paint(d > 0 ? 'step-l' : 'step-r');
}

/* ---------- hardware stand-ins ---------- */
function powerClick() {
  const now = Date.now();
  if (S.ptt) { cancelPtt(); return; }
  if (S.capture) { touch(now); paint(); return; }
  if (S.rest !== 'awake') { wake(now); paint('fade'); return; }
  if (S.power) { S.power = false; paint(); return; }
  const al = alerts(now)[0];
  if (al && !S.modal) setAside(al);
  S.modal = null; S.overlay = null; S.view = null; S.face = 'now'; S.threadId = null;
  paint('fade');
}
const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
function startPtt() {
  if (S.capture || !S.pair) return;
  wake();
  const p = { since: Date.now(), transcript: '', final: '', supported: !!SR, rec: null, ended: false };
  if (SR) {
    try {
      const rec = new SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
      rec.onresult = (ev) => {
        let fin = '', interim = '';
        for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; }
        p.final = fin.trim(); p.transcript = `${fin}${interim}`.trim(); paint();
      };
      rec.onerror = (e) => { p.error = e.error; };
      rec.onend = () => { p.ended = true; if (p.onEnd) p.onEnd(); };
      rec.start(); p.rec = rec;
    } catch { p.supported = false; }
  }
  S.ptt = p; paint();
}
function releasePtt() {
  const p = S.ptt;
  if (!p) return;
  const finish = () => {
    if (S.ptt !== p) return;
    S.ptt = null;
    const text = (p.final || p.transcript || '').trim();
    if (p.supported && text) sendUtterance(text); else { if (p.supported) note('Nothing heard; nothing sent'); paint(); }
  };
  if (p.rec && !p.ended) { p.onEnd = finish; try { p.rec.stop(); } catch { finish(); } setTimeout(finish, 1500); } else finish();
}
function cancelPtt() {
  const p = S.ptt;
  if (!p) return;
  S.ptt = null;
  try { p.rec && p.rec.abort(); } catch { /* ignore */ }
  note('Cancelled; nothing sent'); paint();
}
function toggleCapture() {
  if (S.ptt) return;
  if (S.capture) { stopCapture(); return; }
  wake();
  S.capture = { since: Date.now(), lastTouch: Date.now() }; paint('fade');
}
function stopCapture() {
  if (!S.capture) return;
  const len = (Date.now() - S.capture.since) / 1000;
  S.capture = null; S.saved = { len, until: Date.now() + T.sent }; paint('fade');
  setTimeout(() => paint(), T.sent + 50);
}
function wireHardware() {
  const side = $('side'), power = $('power');
  let sideTimer = null, sideLong = false, lastClick = 0, powerTimer = null, powerLong = false;
  const sideDown = (e) => {
    e && e.preventDefault(); side.classList.add('down'); sideLong = false;
    sideTimer = setTimeout(() => { sideLong = true; startPtt(); }, 300);
  };
  const sideUp = () => {
    side.classList.remove('down');
    clearTimeout(sideTimer);
    if (sideLong) { sideLong = false; releasePtt(); return; }
    const t = Date.now();
    if (t - lastClick < 450) { lastClick = 0; toggleCapture(); } else lastClick = t;
  };
  const powerDown = (e) => { e && e.preventDefault(); power.classList.add('down'); powerLong = false; powerTimer = setTimeout(() => { powerLong = true; S.power = true; wake(); paint('fade'); }, 3000); };
  const powerUp = () => { power.classList.remove('down'); clearTimeout(powerTimer); if (!powerLong) powerClick(); };
  side.addEventListener('pointerdown', sideDown); side.addEventListener('pointerup', sideUp); side.addEventListener('pointercancel', sideUp);
  side.addEventListener('contextmenu', (e) => e.preventDefault()); power.addEventListener('contextmenu', (e) => e.preventDefault());
  power.addEventListener('pointerdown', powerDown); power.addEventListener('pointerup', powerUp); power.addEventListener('pointercancel', () => { power.classList.remove('down'); clearTimeout(powerTimer); });
  // Keyboard on a desktop: Space is the side button, Escape (or P) the power button.
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Space' && !e.repeat && !spaceDown) { spaceDown = true; e.preventDefault(); sideDown(); }
    else if (e.key === 'Escape' || e.key === 'p') powerClick();
    else if (e.key === 'ArrowLeft') swipe(120, 0); else if (e.key === 'ArrowRight') swipe(-120, 0);
    else if (e.key === 'ArrowUp') swipe(0, -120); else if (e.key === 'ArrowDown') swipe(0, 120);
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { spaceDown = false; e.preventDefault(); sideUp(); } });
}

/* ---------- touch on the dial ---------- */
function designPoint(ev) {
  const r = $('dial').getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * 466, y: ((ev.clientY - r.top) / r.height) * 466 };
}
function wireDial() {
  const dial = $('dial');
  let start = null, holdT = null, holdEl = null, pressEl = null, slider = null, consumed = false;
  const endHold = (done) => {
    clearTimeout(holdT); holdT = null;
    if (holdEl) {
      const cap = holdEl.closest('.capsule'), ph = holdEl.closest('.ph');
      (cap || holdEl).classList.remove('holding');
      if (ph) ph.classList.remove('ringhold');
      if (done) { const el = holdEl; holdEl = null; holding = false; onHold(el); if (deferred) { deferred = false; paint(); } return; }
    }
    holdEl = null; holding = false;
    if (deferred) { deferred = false; paint(); }
  };
  dial.addEventListener('pointerdown', (ev) => {
    if (S.frozen && !DEMO) return;
    const now = Date.now();
    consumed = false;
    if (S.rest !== 'awake' || (S.capture && now - S.capture.lastTouch > 60000)) { consumed = true; wake(now); paint('fade'); return; }
    touch(now);
    try { dial.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    const p = designPoint(ev);
    start = { x: ev.clientX, y: ev.clientY, el: ev.target, t: now };
    if (S.overlay === 'settings') { const h = sliderHit(p.x, p.y); if (h) { slider = h.side; setSlider(h); return; } }
    const el = ev.target.closest && ev.target.closest('[data-act]');
    if (!el) return;
    pressEl = el; el.classList.add('pressed');
    if (el.dataset.hold) {
      holdEl = el; holding = true;
      const cap = el.closest('.capsule');
      if (cap) { cap.querySelector('.holdlabel').textContent = el.dataset.hold; cap.querySelector('.wipe').textContent = el.dataset.hold; cap.classList.add('holding'); el.classList.remove('pressed'); }
      else if (el.dataset.ring) { el.closest('.ph').classList.add('ringhold'); }
      else { el.classList.add('holding'); el.classList.remove('pressed'); }
      holdT = setTimeout(() => endHold(true), 800);
    }
  });
  dial.addEventListener('pointermove', (ev) => {
    if (slider) { const h = sliderHit(designPoint(ev).x, designPoint(ev).y); if (h && h.side === slider) setSlider(h); return; }
    if (!start) return;
    const k = 466 / $('dial').getBoundingClientRect().width;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) * k > 14) { if (pressEl) pressEl.classList.remove('pressed'); if (holdEl) endHold(false); }
  });
  const up = (ev, cancel = false) => {
    if (consumed) { consumed = false; start = null; return; }
    if (slider) { slider = null; saveSettings(); start = null; return; }
    if (pressEl) pressEl.classList.remove('pressed');
    const wasHold = !!holdEl;
    if (holdEl) endHold(false); // released before 0.8 s: cancel, nothing sent
    if (!start || cancel) { start = null; pressEl = null; return; }
    const k = 466 / $('dial').getBoundingClientRect().width;
    const dx = (ev.clientX - start.x) * k, dy = (ev.clientY - start.y) * k;
    const el = pressEl; pressEl = null;
    const s = start; start = null;
    if (Math.abs(dx) > 40 || Math.abs(dy) > 40) { swipe(dx, dy, s.el); return; }
    if (wasHold) return;
    if (el && !el.dataset.hold) onTap(el);
  };
  dial.addEventListener('pointerup', (ev) => up(ev));
  dial.addEventListener('pointercancel', (ev) => up(ev, true));
  dial.addEventListener('contextmenu', (e) => e.preventDefault());
}
function setSlider(h) {
  if (h.side === 'left') SET.brightness = Math.max(0.1, h.value); else SET.volume = h.value;
  paint();
}
function usePhoneLocation() {
  if (!navigator.geolocation) { S.cityNote = 'No location on this phone'; paint(); return; }
  S.cityNote = 'Asking the phone…'; paint();
  navigator.geolocation.getCurrentPosition((pos) => {
    SET.loc = { city: 'Phone', lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100, source: 'phone' };
    saveSettings(); sunCache.key = ''; S.overlay = 'settings'; S.cityNote = ''; paint('fade');
  }, () => { S.cityNote = 'Location not allowed'; paint(); }, { maximumAge: 3600000, timeout: 10000 });
}

/* ---------- chrome wiring ---------- */
function wireChrome() {
  $('size').addEventListener('click', () => { ls.set('intercom.large', ls.get('intercom.large') === '1' ? '0' : '1'); applySize(); });
  window.addEventListener('resize', applySize);
  window.addEventListener('orientationchange', () => setTimeout(applySize, 200));
  $('reduced').checked = !!SET.reduced;
  $('reduced').addEventListener('change', () => { SET.reduced = $('reduced').checked; saveSettings(); document.documentElement.classList.toggle('rm', !!reduced()); paint(); });
  if (awake.supported) {
    $('keepawake-row').hidden = false;
    $('keepawake').checked = awake.enabled();
    $('keepawake').addEventListener('change', () => { awake.set($('keepawake').checked); });
    document.addEventListener('visibilitychange', () => { awake.visible(); });
    document.addEventListener('pointerdown', () => { awake.gesture(); }, { passive: true });
    awake.visible(); // restore a saved "on" at load (iOS may wait for the first gesture)
  }
  $('input').addEventListener('input', () => { if (!S.pair) paint(); });
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('input').value.trim();
    if (!v) return;
    if (!S.pair) { pair(parsePairInput(v)); return; }
    if (v.length > 4000) { note('Too long (4,000 characters at most)'); return; }
    touch(); wake();
    sendUtterance(v);
    $('input').value = ''; $('input').blur();
  });
  let lp = null;
  const dotbtn = $('dotbtn');
  dotbtn.addEventListener('pointerdown', () => { lp = setTimeout(() => { lp = null; $('confirm').classList.add('show'); }, 700); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((n) => dotbtn.addEventListener(n, () => clearTimeout(lp)));
  dotbtn.addEventListener('contextmenu', (e) => e.preventDefault());
  $('cancel').addEventListener('click', () => $('confirm').classList.remove('show'));
  $('unpair').addEventListener('click', () => { $('confirm').classList.remove('show'); unpair(); });
}

/* ---------- demo and state hooks ---------- */
function wireDemo() {
  const sel = $('dsel');
  sel.innerHTML = STATE_IDS.map((id) => `<option value="${id}">${id}</option>`).join('');
  $('demo').hidden = false; $('democap').hidden = false; $('hw').hidden = true; $('form').hidden = true;
  const show = (id) => {
    S.demoId = id; sel.value = id;
    const s = STATES.find((x) => x.id === id);
    S.frozenAt = zonedMs(2026, 11, 5, s.time[0], s.time[1], 'America/New_York', s.time[2]);
    S.demoT0 = Date.now() - (s.moon && s.moon !== 'park' ? 0 : 0);
    $('democap').textContent = `${id} · ${hmA(S.frozenAt, 'America/New_York')}, Thursday 5 Nov 2026`;
    lastHtml = ''; paint('fade');
  };
  sel.addEventListener('change', () => show(sel.value));
  const step = (d) => show(STATE_IDS[(STATE_IDS.indexOf(S.demoId) + d + STATE_IDS.length) % STATE_IDS.length]);
  $('dprev').addEventListener('click', () => step(-1)); $('dnext').addEventListener('click', () => step(1));
  show(STATE_IDS.includes(params.get('demo')) ? params.get('demo') : STATE_IDS[0]);
}

/* ---------- boot ---------- */
function takePairCode() {
  const m = location.hash.match(/pair=([^&]+)/);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(m[1]);
}
async function installMeasure() {
  try { await Promise.all(['700 15px "Lexend Exa"', '700 16px "Lexend Exa"', '600 14px "Lexend Exa"', '200 30px "Lexend Exa"', '500 18px "Hanken Grotesk"'].map((f) => document.fonts.load(f))); } catch { /* fonts unavailable */ }
  const ctx = document.createElement('canvas').getContext('2d');
  setMeasure((text, f) => { ctx.font = f; return ctx.measureText(text).width; });
}
async function boot() {
  document.documentElement.classList.toggle('rm', !!reduced());
  await installMeasure();
  if (STATE_ID || DEMO) {
    S.frozen = true;
    if (STATE_ID && !DEMO) {
      document.documentElement.classList.add('statemode');
      const s = STATES.find((x) => x.id === STATE_ID);
      S.frozenAt = s ? zonedMs(2026, 11, 5, s.time[0], s.time[1], 'America/New_York', s.time[2]) : Date.now();
      $('face').classList.add('frozen');
      applySize(); paint();
      document.documentElement.dataset.ready = '1';
      return;
    }
    applySize(); wireDemo(); loop();
    document.documentElement.dataset.ready = '1';
    return;
  }
  applySize(); wireCalibrate(); wireChrome(); wireDial(); wireHardware();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sock?.nudge(); resync(); paint(); } });
  window.addEventListener('online', () => sock?.nudge());
  const code = takePairCode();
  if (S.pair && !code) { S.conn = 'connecting'; S.offlineSince = Date.now(); startSocket(); }
  if (code) { unpair(); pair(code); }
  window.addEventListener('hashchange', () => { const c = takePairCode(); if (c) { unpair(); pair(c); } });
  setInterval(() => { if (S.pair) resync(); }, 60000);
  loop();
  document.documentElement.dataset.ready = '1';
}
boot();
