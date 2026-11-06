// Phase data model (spec 6, 7, 10): Surface v2 items mapped onto Moments, agent jobs, and the face models.
// Pure: no DOM, no network, unit-tested under vitest.
import { clockDeg } from './geom.js';
import { zparts, hm, hmA, sameDay, dayLabel, minuteOfDay, startOfDay, zonedMs, shortDur, agoText } from './time.js';

/* ---------- weights ---------- */

export const WEIGHTS = ['ambient', 'notice', 'decision', 'urgent'];
export const WEIGHT_RANK = { ambient: 0, notice: 1, decision: 2, urgent: 3 };
/** Surface Event `level` to Moment weight, used when the Event carries no `weight` (the bus has none yet). */
export const LEVEL_WEIGHT = { info: 'ambient', attention: 'decision', urgent: 'urgent' };
/** E89 notice `level` to weight: info is a Notice (Inform for 20 s), attention a Decision, urgent the rose flood. */
export const NOTICE_WEIGHT = { info: 'notice', attention: 'decision', urgent: 'urgent' };
export function weightOf(item, map = LEVEL_WEIGHT) {
  if (item && WEIGHTS.includes(item.weight)) return item.weight;
  return map[item && item.level] || (map === NOTICE_WEIGHT ? 'notice' : 'ambient');
}

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Action labels: at most 10 characters, cut without an ellipsis (spec 10); the cut is reported to `log`. */
export function capLabel(label, log = null) {
  const s = String(label || '').trim().toUpperCase();
  if (s.length <= 10) return s;
  if (log) log(`label cut to 10 characters: ${label}`);
  return s.slice(0, 10).trimEnd();
}

const cutLogged = new Set();
/** Report a cut label once (spec 10: "truncate without an ellipsis and log it"). */
export const logCut = (msg) => { if (!cutLogged.has(msg)) { cutLogged.add(msg); if (globalThis.console) console.info(`[phase] ${msg}`); } };

/** Bus Action -> Moment action. `hold` for anything that sends (a confirm draft) or that says so itself. */
export function mapAction(a, i) {
  const draft = a && a.confirm && typeof a.confirm.draft === 'string' && a.confirm.draft ? a.confirm.draft : null;
  return { id: String(a.id ?? i), label: capLabel(a.label, logCut), kind: a.kind === 'hold' || a.kind === 'tap' ? a.kind : draft ? 'hold' : 'tap', primary: i === 0, draft, destructive: a.style === 'destructive' || a.style === 'danger', raw: a };
}

/** A Surface v2 Event (kind event or approval) as a Moment. */
export function momentFromEvent(e) {
  const approval = e.kind === 'approval';
  const start = ms(e.at), end = ms(e.end);
  const actions = (e.actions || []).slice(0, 3).map(mapAction);
  const draftAct = actions.find((a) => a.draft);
  let travel = null;
  if (e.travel && Number(e.travel.minutes) > 0) {
    const leaveBy = ms(e.travel.leave_by) ?? (start !== null ? start - Number(e.travel.minutes) * 60000 : null);
    travel = { mode: e.travel.mode || null, minutes: Number(e.travel.minutes), leave_by: leaveBy };
  }
  return {
    id: e.id, src: approval ? 'approval' : 'event', object: `events:${e.id}`, title: e.title || (approval ? 'Approval needed' : 'Untitled'),
    weight: approval ? 'decision' : weightOf(e), start: approval ? null : start, end: approval ? null : end && start !== null && end > start ? end : null,
    place: str(e.detail && e.detail.location), note: str(e.detail && e.detail.description) || str(e.body), travel, actions,
    preview: approval ? { to: null, channel: null, text: (e.approval && e.approval.detail) || e.body || '' } : draftAct ? { to: (draftAct.raw.confirm && draftAct.raw.confirm.prompt) || null, channel: null, text: draftAct.draft } : (e.preview && typeof e.preview.text === 'string' ? e.preview : null),
    expires: ms(e.expires_at), consequence: str(e.consequence), changed: e.changed && e.changed.new !== undefined ? e.changed : null,
    state: e.state || 'open', arrival: ms(e.created_at) ?? ms(e.updated_at), updated: e.updated_at || e.created_at || '',
    source: e.source || '', conversationId: e.conversation_id || null, raw: e,
  };
}

/** An E89 notice as a Moment (no time on the rim). */
export function momentFromNotice(n) {
  const actions = (n.actions || []).slice(0, 3).map((a, i) => ({ id: String(i), label: capLabel(a.label, logCut), kind: 'tap', primary: i === 0, draft: null, destructive: a.style === 'danger', raw: a }));
  return {
    id: n.id, src: 'notice', object: `notices:${n.id}`, title: n.title || 'Notice', weight: weightOf(n, NOTICE_WEIGHT), start: null, end: null,
    place: null, note: str(n.body), travel: null, actions, preview: null, expires: ms(n.expires_at), consequence: str(n.consequence),
    changed: n.changed && n.changed.new !== undefined ? n.changed : null, state: n.state === 'active' ? 'open' : n.state || 'open',
    arrival: ms(n.created_at), updated: n.updated_at || n.created_at || '', source: n.source || '', icon: n.icon || null, raw: n,
  };
}

/* ---------- agent jobs (sessions) ---------- */

/** Surface session -> agent job state (spec 6.3). Idle sessions are hidden (null). */
export function sessionState(s) {
  if (!s) return null;
  if (s.needs_you || s.state === 'waiting') return 'waiting';
  if (s.state === 'stuck') return 'failed';
  if (s.state === 'working') return 'working';
  if (s.state === 'finished') return 'done';
  if (s.state === 'queued') return 'queued';
  return null;
}
const JOB_ORDER = { waiting: 0, failed: 1, working: 2, queued: 3, done: 4 };

/** Agents face model (spec 7.4): rows sorted waiting, failed, working, done; first 3 plus a "+N" line. */
export function agentsModel(sessions, nowMs) {
  const jobs = [];
  (sessions || []).forEach((s, i) => {
    const state = sessionState(s);
    if (!state) return;
    const since = ms(s.since), last = ms(s.last_activity_at) ?? since;
    const name = String(s.subject || s.title || 'Session');
    let detail = state;
    if (state === 'waiting') detail = s.needs_you ? 'needs you' : 'waiting';
    else if (state === 'working') detail = `working · ${shortDur(nowMs - (since ?? nowMs))}`;
    else if (state === 'done') detail = `done · ${shortDur(nowMs - (last ?? nowMs))} ago`;
    jobs.push({ id: s.id, i, state, name, detail, conversationId: s.conversation_id || null, needsYou: !!s.needs_you, since, last, raw: s });
  });
  jobs.sort((a, b) => JOB_ORDER[a.state] - JOB_ORDER[b.state] || a.i - b.i);
  const active = jobs.filter((j) => j.state !== 'done');
  const counts = { waiting: 0, failed: 0, working: 0, queued: 0, done: 0 };
  for (const j of jobs) counts[j.state]++;
  const caption = ['waiting', 'failed', 'working', 'queued'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(' · ');
  const rows = jobs.slice(0, 3), rest = jobs.slice(3);
  const more = rest.length ? (rest.every((j) => j.state === 'working') ? `+${rest.length} WORKING` : `+${rest.length} MORE`) : '';
  const done = jobs.filter((j) => j.state === 'done').sort((a, b) => (b.last || 0) - (a.last || 0))[0] || null;
  return { jobs, rows, more, caption, counts, working: counts.working, nothing: active.length === 0, lastDone: done };
}

/** The question a waiting job asks: its answer-needed message (text and up to 3 buttons) from a conversation page. */
export function questionOf(session, messages) {
  const list = messages || [];
  const m = list.find((x) => session && session.needs_you_message_id && x.id === session.needs_you_message_id)
    || [...list].reverse().find((x) => x.answer_needed) || null;
  if (!m) return null;
  return { messageId: m.id, text: String(m.text || ''), options: (m.buttons || []).slice(0, 3).map((b) => ({ index: b.index, label: b.label })), at: ms(m.created_at) };
}

/* ---------- rim marks (spec 5.1) ---------- */

const H12 = 12 * 3600 * 1000;
const degOf = (t, tz) => { const p = zparts(t, tz); return clockDeg(p.h, p.m, p.s); };
/** Moments with a start that the rim and the day list use, sorted by start. */
export const timedMoments = (moments) => (moments || []).filter((m) => m.start !== null && m.src === 'event').sort((a, b) => a.start - b.start || (a.end === null) - (b.end === null) || String(a.id).localeCompare(String(b.id)));

/**
 * Rim marks for the next 12 hours. Points are dots on r 214; spans are arcs on lane r 197; the later of two overlapping spans
 * moves to lane r 184 in amber; a third overlapping span is not drawn and is counted in `hidden`.
 * A Moment that started before now and is still running draws from now to its end.
 */
export function rimMarks(moments, nowMs, tz) {
  const marks = [];
  let lane1End = -Infinity, lane2End = -Infinity, hidden = 0;
  for (const m of timedMoments(moments)) {
    const endish = m.end ?? m.start;
    if (endish < nowMs || m.start > nowMs + H12) continue;
    if (m.end === null) { marks.push({ id: m.id, type: 'dot', deg: degOf(m.start, tz) }); continue; }
    const s = Math.max(m.start, nowMs), e = Math.min(m.end, nowMs + H12 - 60000);
    let lane;
    if (m.start >= lane1End) { lane = 1; lane1End = m.end; } else if (m.start >= lane2End) { lane = 2; lane2End = m.end; } else { hidden++; continue; }
    const a1 = degOf(s, tz);
    let a2 = a1 + ((e - s) / H12) * 360;
    marks.push({ id: m.id, type: 'arc', a1, a2, lane, amber: lane === 2 });
  }
  return { marks, hidden };
}

/** Overlap in minutes between two spans (0 if none or either has no end). */
export function overlapMin(a, b) {
  if (!a || !b || a.end === null || b.end === null) return 0;
  return Math.max(0, Math.round((Math.min(a.end, b.end) - Math.max(a.start, b.start)) / 60000));
}

/* ---------- countdown (spec 7.1, 10) ---------- */

/** Minutes to `target`, rounded up so 2:48:20 to 3:30 reads 42. */
export const minutesUntil = (target, nowMs) => Math.max(0, Math.ceil((target - nowMs) / 60000));
/**
 * 0-119 minutes: the number (Numeral XL) and MIN. From 120: the clock time (Numeral L), no unit, and `tomorrow` when the date differs.
 */
export function countdown(target, nowMs, tz) {
  const m = minutesUntil(target, nowMs);
  if (m <= 119) return { kind: 'min', numeral: String(m), unit: 'MIN', size: 'xl', tomorrow: false };
  return { kind: 'clock', numeral: hm(target, tz), unit: null, size: 'l', tomorrow: !sameDay(target, nowMs, tz) };
}

/* ---------- quiet hours and the waking day ---------- */

export const DEFAULT_QUIET = { on: true, start: 22 * 60, end: 7 * 60 };
export function isQuiet(nowMs, tz, q = DEFAULT_QUIET) {
  if (!q || !q.on) return false;
  const m = minuteOfDay(nowMs, tz);
  return q.start > q.end ? m >= q.start || m < q.end : m >= q.start && m < q.end;
}
/** Next instant quiet hours end (for "QUIET UNTIL 7:00 AM"). */
export function quietEndsAt(nowMs, tz, q = DEFAULT_QUIET) {
  const p = zparts(nowMs, tz);
  let t = zonedMs(p.y, p.mo, p.d, Math.floor(q.end / 60), q.end % 60, tz);
  if (t <= nowMs) t = zonedMs(...ymdPlus(p, 1), Math.floor(q.end / 60), q.end % 60, tz);
  return t;
}
function ymdPlus(p, days) { const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + days)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; }
/** The waking day for the lower arc: quiet-hours end to quiet-hours start, today (default 7 AM to 10 PM). */
export function wakingDay(nowMs, tz, q = DEFAULT_QUIET) {
  const p = zparts(nowMs, tz);
  const s = zonedMs(p.y, p.mo, p.d, Math.floor(q.end / 60), q.end % 60, tz);
  let e = zonedMs(p.y, p.mo, p.d, Math.floor(q.start / 60), q.start % 60, tz);
  if (e <= s) e += 24 * 3600 * 1000;
  return { start: s, end: e };
}
const frac = (now, a, b) => (b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : 0);

/* ---------- Now face (spec 4.4, 7.1) ---------- */

/**
 * The Now face: label, numeral and unit, captions, status line, progress arcs, rim marks.
 * opts: missed (count for the top caption), quiet (quiet-hours setting), offline (bool: "~" before minutes, no arcs).
 */
export function nowModel(moments, nowMs, tz, opts = {}) {
  const q = opts.quiet || DEFAULT_QUIET;
  const timed = timedMoments(moments);
  const today = (t) => sameDay(t, nowMs, tz);
  const running = timed.find((m) => m.end !== null && m.start <= nowMs && m.end > nowMs) || null;
  const next = timed.find((m) => m.start > nowMs && today(m.start)) || null;
  const focus = running || next;
  const { marks, hidden } = rimMarks(moments, nowMs, tz);
  const wake = wakingDay(nowMs, tz, q);
  const out = { marks, hidden, focusId: focus ? focus.id : null, arcs: { upper: null, lower: opts.offline ? null : frac(nowMs, wake.start, wake.end) } };
  // Overlap with the focus Moment.
  let ov = null;
  if (focus) for (const m of timed) { if (m.id !== focus.id && overlapMin(focus, m) > 0) { ov = { min: overlapMin(focus, m), at: Math.max(focus.start, m.start) }; break; } }
  const tilde = opts.offline ? '~' : '';
  if (!focus) {
    Object.assign(out, { nothing: true, label: 'NOTHING ON', numeral: hm(nowMs, tz), unit: null, size: 'l', top: opts.offline && opts.offlineSince ? `Offline since ${hmA(opts.offlineSince, tz)}` : dayLabel(nowMs, tz), bottom: '', status: null });
    out.marks = []; // bare rim
    return out;
  }
  if (running) {
    const c = countdown(running.end, nowMs, tz);
    Object.assign(out, { label: 'NOW', numeral: (c.kind === 'min' ? tilde : '') + c.numeral, unit: c.unit, size: c.size });
    out.arcs.upper = opts.offline ? null : frac(nowMs, running.start, running.end);
  } else {
    const c = countdown(next.start, nowMs, tz);
    Object.assign(out, { label: c.kind === 'min' ? `NEXT ${hm(next.start, tz)}` : c.tomorrow ? 'TOMORROW' : 'NEXT', numeral: (c.kind === 'min' ? tilde : '') + c.numeral, unit: c.unit, size: c.size });
    const prevEnd = timed.filter((m) => (m.end ?? m.start) <= nowMs && today(m.end ?? m.start)).reduce((a, m) => Math.max(a, m.end ?? m.start), -Infinity);
    const from = Math.max(prevEnd, wake.start);
    out.arcs.upper = opts.offline ? null : frac(nowMs, Number.isFinite(from) && from < nowMs ? from : startOfDay(nowMs, tz), next.start);
  }
  const parts = [];
  if (opts.missed) parts.push(`${opts.missed} missed`);
  if (ov) parts.push(`overlap at ${hm(ov.at, tz)}`);
  out.top = parts.length ? parts.join(' · ') : running ? `Until ${hm(running.end, tz)}` : `Clear until ${hm(next.start, tz)}`;
  if (opts.offline && opts.offlineSince) out.top = `Offline since ${hmA(opts.offlineSince, tz)}`;
  out.bottom = focus.title + (focus.place ? ` · ${focus.place}` : '');
  const left = timed.filter((m) => m.start > nowMs && today(m.start)).length;
  if (ov) out.status = { text: `◆ OVERLAP ${ov.min} MIN`, amber: true };
  else if (hidden) out.status = { text: `◆ ${hidden} MORE OVERLAPPING`, amber: true };
  else out.status = left ? { text: `${left} LEFT TODAY`, amber: false } : null;
  return out;
}

/* ---------- Day list (spec 7.2) ---------- */

/** Today's remaining Moments: first 3 as rows, one overlap note, one gap row (free 30 min or more), "+N LATER TODAY". */
export function dayModel(moments, nowMs, tz) {
  const list = timedMoments(moments).filter((m) => sameDay(m.start, nowMs, tz) && (m.end ?? m.start) >= nowMs);
  const shown = list.slice(0, 3);
  const nextId = (list.find((m) => m.start > nowMs) || {}).id;
  const items = [];
  let noted = false, gapped = false, maxEnd = -Infinity;
  shown.forEach((m, i) => {
    items.push({ kind: 'row', id: m.id, time: hm(m.start, tz), title: m.title, next: m.id === nextId });
    maxEnd = Math.max(maxEnd, m.end ?? m.start);
    if (!noted) {
      const other = list.find((o) => o.id !== m.id && o.start >= m.start && overlapMin(m, o) > 0);
      if (other) { items.push({ kind: 'note', text: `◆ OVERLAPS ${overlapMin(m, other)} MIN` }); noted = true; }
    }
    const nx = shown[i + 1];
    if (nx && !gapped) {
      const free = Math.round((nx.start - maxEnd) / 60000);
      if (free >= 30) { items.push({ kind: 'gap', text: `${free} MIN FREE` }); gapped = true; }
    }
  });
  return { items, more: list.length > 3 ? `+${list.length - 3} LATER TODAY` : '', top: dayLabel(nowMs, tz), empty: list.length === 0 };
}

/* ---------- Event detail (spec 7.2) ---------- */

const TRAVEL_WORD = { walk: 'WALK', drive: 'DRIVE', transit: 'TRANSIT', bike: 'BIKE', train: 'TRAIN' };
export function travelLine(m, tz) {
  if (!m.travel) return null;
  const word = TRAVEL_WORD[m.travel.mode] || 'TRAVEL';
  return m.travel.leave_by ? `LEAVE ${hm(m.travel.leave_by, tz)} · ${m.travel.minutes} MIN ${word}` : `${m.travel.minutes} MIN ${word}`;
}
/** "In 8 min", "Now", "Ended", or the day. */
export function inLine(m, nowMs, tz) {
  if (m.start === null) return '';
  if (m.end !== null && m.start <= nowMs && m.end > nowMs) return 'Now';
  if (m.start <= nowMs) return 'Earlier today';
  const min = minutesUntil(m.start, nowMs);
  if (min < 120) return `In ${min} min`;
  if (!sameDay(m.start, nowMs, tz)) return dayLabel(m.start, tz);
  return `In ${Math.floor(min / 60)} h ${min % 60} min`;
}
export function detailModel(m, moments, nowMs, tz) {
  const pm = m.start !== null ? (zparts(m.start, tz).h < 12 ? 'AM' : 'PM') : '';
  const dur = m.end !== null ? Math.round((m.end - m.start) / 60000) : null;
  const other = timedMoments(moments).find((o) => o.id !== m.id && overlapMin(m, o) > 0);
  return {
    top: inLine(m, nowMs, tz), title: m.title, sparse: m.end === null,
    range: m.start === null ? '' : m.end !== null ? `${hm(m.start, tz)}–${hm(m.end, tz)}` : hm(m.start, tz),
    sub: m.end !== null ? `${pm} · ${dur >= 60 && dur % 60 === 0 ? `${dur / 60} H` : `${dur} MIN`}` : pm,
    place: m.place, travel: travelLine(m, tz), conflict: other ? `◆ OVERLAPS ${other.title}, ${hm(other.start, tz)}` : null, note: m.note,
  };
}

/* ---------- alerts and priority (spec 6.2, 7.3, 8.2) ---------- */

/** Open alerts (notice, decision, urgent Moments) not set aside, highest weight first, newest first. */
export function alertList(moments, aside = new Map(), nowMs = Date.now()) {
  return (moments || []).filter((m) => WEIGHT_RANK[m.weight] >= 1 && m.state === 'open' && !(m.expires !== null && m.expires <= nowMs) && !(aside.has(m.id) && aside.get(m.id) === m.updated))
    .sort((a, b) => WEIGHT_RANK[b.weight] - WEIGHT_RANK[a.weight] || (b.arrival || 0) - (a.arrival || 0));
}

/**
 * What owns the glass (spec 8.2), highest first: capture, listening, urgent, decision, notice, settings/earlier, the face, rest.
 * While capture runs an urgent Moment does not take the glass (it waits; REC shows "1 ALERT").
 */
export function pickLayer({ capture = false, listening = false, alert = null, overlay = null, resting = false } = {}) {
  if (capture) return 'capture';
  if (listening) return 'listening';
  if (alert && alert.weight === 'urgent') return 'urgent';
  if (alert && alert.weight === 'decision') return 'decision';
  if (alert && alert.weight === 'notice' && !resting) return 'notice';
  if (overlay) return overlay;
  if (resting) return 'rest';
  return 'face';
}

/* ---------- captions ---------- */

/** Fit text to `maxWidth` by measured width, cutting with an ellipsis (spec 5.5). `measure` returns px for a string. */
export function fitText(text, maxWidth, measure) {
  const t = String(text || '').trim();
  if (!t || measure(t) <= maxWidth) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${t.slice(0, mid).trimEnd()}…`) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return lo ? `${t.slice(0, lo).trimEnd()}…` : '…';
}

/** Earlier-tray row detail: "2:14 PM · cleared" or, for an open one, "open · tap to act". */
export const earlierDetail = (e, tz) => (e.state === 'open' ? 'open · tap to act' : `${hmA(e.at, tz)} · ${e.state}`);
export { agoText };
