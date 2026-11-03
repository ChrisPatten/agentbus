// Day Dial v2: pure geometry and decisions for the event ring, scrub, slots and widgets.
// Calendar events are the base layer; surface Events overlay them (docs/INTERCOM_WEB.md, "Day Dial v2").
import { C, RING_R, polar, tzParts, daySpans, assignLanes, shortTime, departureView, LATE_MIN } from './logic.js';
import { itemsOf, activeSlot } from './surface.js';

export const PRIMARY = { r: RING_R, w: 20 };
export const OVERLAP_W = 8;
export const OVERLAP_R = { in: 179, out: 222 }; // inside the calendar's second lane, and a hair outside the primary
export const TICK_R0 = 196, TICK_R1 = 228;
export const HIT_TOL = 18; // design px of slack around any segment or tick (the narrow overlaps especially)
export const TICK_HIT_TOL = 30; // design px: ticks are thin, so their target is larger and always beats a segment under the finger
export const TICK_HIT_PAD = 10; // design px added to each side of the tick's rim band for hit purposes
export const SCRUB_BALL_TOL = 34; // design px around the progress ball that starts a scrub
export const SNAP_MS = 4000;

const NAMED = { orange: '#ff9f43', red: '#ef6a5d', green: '#74c978', blue: '#6fa8ff', purple: '#c9a0ff', yellow: '#f4d35e', teal: '#5fc0b3', pink: '#e39aab', gray: '#8e8e93', white: '#f6eedb' };
/** `#rgb`, `#rrggbb` or a named colour from the bus; anything else gives the fallback. */
export function colorValue(c, fallback = '#ffb347') {
  const s = String(c || '').toLowerCase();
  if (NAMED[s]) return NAMED[s];
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s) ? s : fallback;
}
const LEVEL_COLOR = { urgent: '#ef6a5d', attention: '#ffb347', info: '#f6eedb' };

/** Hours (0..24) of an ISO time on today's ring, or null when it is not today. `edge` clamps a span that crosses midnight. */
function todayHours(iso, todayYmd, tz, edge) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = tzParts(d, tz);
  if (p.ymd === todayYmd) return p.hours;
  if (edge === 'start' && p.ymd < todayYmd) return 0;
  if (edge === 'end' && p.ymd > todayYmd) return 24;
  return null;
}

const isRingEvent = (e) => e && e.kind !== 'approval' && e.at && e.end;
const isTickEvent = (e) => e && e.kind !== 'approval' && e.at && !e.end;

/**
 * Everything the ring needs from the surface Events for one day.
 * segs: one per Event with both at and end. layer 'primary' draws wide on the main track; 'overlap' draws narrow,
 *       first overlap inside, second outside (max 2 overlapping; a third shares the outside lane).
 * ticks: Events with `at` only, a small mark across the rim.
 */
export function ringModel(events, now, tz) {
  const today = tzParts(now, tz).ymd;
  const nowH = tzParts(now, tz).hours;
  const segs = [];
  const ticks = [];
  for (const e of events || []) {
    if (isRingEvent(e)) {
      const s = todayHours(e.at, today, tz, 'start');
      const en = todayHours(e.end, today, tz, 'end');
      if (s === null || en === null) continue; // not on today's ring
      const startH = s;
      let endH = en;
      if (endH <= startH) endH = Math.min(24, startH + 0.25);
      const layer = e.layer === 'overlap' ? 'overlap' : 'primary';
      const seg = { id: e.id, ev: e, layer, startH, endH, color: colorValue(e.color, LEVEL_COLOR[e.level] || '#ffb347'), past: endH <= nowH, travel: null };
      if (e.travel && e.travel.minutes > 0) {
        const t0 = Math.max(0, startH - e.travel.minutes / 60);
        if (startH - t0 > 0.001) seg.travel = { startH: t0, endH: startH };
      }
      segs.push(seg);
    } else if (isTickEvent(e)) {
      const h = todayHours(e.at, today, tz);
      if (h === null) continue;
      ticks.push({ id: e.id, ev: e, h, color: colorValue(e.color, LEVEL_COLOR[e.level] || '#ffb347'), past: h <= nowH });
    }
  }
  segs.sort((a, b) => a.startH - b.startH || a.endH - b.endH);
  const laneEnds = [];
  for (const sg of segs) {
    if (sg.layer === 'primary') { sg.lane = 'primary'; sg.r = PRIMARY.r; sg.w = PRIMARY.w; continue; }
    let i = laneEnds.findIndex((end) => sg.startH >= end - 0.001);
    if (i === -1) i = laneEnds.length < 2 ? laneEnds.length : 1;
    laneEnds[i] = Math.max(laneEnds[i] ?? 0, sg.endH);
    sg.lane = i === 0 ? 'in' : 'out';
    sg.r = OVERLAP_R[sg.lane];
    sg.w = OVERLAP_W;
  }
  ticks.sort((a, b) => a.h - b.h);
  return { segs, ticks, nowH };
}

/* ---------- touch: hit testing and scrub ---------- */

/** Hours (0..24) of a point in the 466 design square; midnight at the top, clockwise. */
export function pointToHours(x, y) {
  let a = Math.atan2(y - C, x - C) + Math.PI / 2;
  a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return (a / (2 * Math.PI)) * 24;
}
const radiusOf = (x, y) => Math.hypot(x - C, y - C);
/** Shortest distance between two hours on the 24 h circle. */
const hoursApart = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

/**
 * The segment or tick under a tap, or null. A tap picks the nearest one within `tol` design px, so the narrow overlap
 * segments are easy to hit; ties go to the narrower target. Ticks take priority: any tick within TICK_HIT_TOL of the
 * tap (nearest wins, earlier on a tie) beats every segment, which is considered only when no tick is in range. Returns `{ kind: 'seg'|'tick', id }`.
 */
export function hitTest(x, y, model, tol = HIT_TOL) {
  const r = radiusOf(x, y);
  if (!model || r < 150) return null;
  const h = pointToHours(x, y);
  const pxPerHour = (2 * Math.PI * Math.max(r, 1)) / 24;
  let bestTick = null;
  const tickTol = Math.max(TICK_HIT_TOL, tol);
  for (const t of model.ticks) {
    const lo = TICK_R0 - TICK_HIT_PAD, hi = TICK_R1 + TICK_HIT_PAD;
    const dr = r >= lo && r <= hi ? 0 : Math.min(Math.abs(r - lo), Math.abs(r - hi));
    const cost = Math.hypot(dr, hoursApart(h, t.h) * pxPerHour);
    if (cost <= tickTol && (!bestTick || cost < bestTick.c)) bestTick = { id: t.id, c: cost }; // strict <: ties keep the earlier tick
  }
  if (bestTick) return { kind: 'tick', id: bestTick.id };
  let best = null;
  const consider = (kind, id, cost, narrow) => {
    if (cost > tol) return;
    const c = cost - (narrow ? 0.5 : 0);
    if (!best || c < best.c) best = { kind, id, c };
  };
  for (const sg of model.segs) {
    const dr = Math.max(0, Math.abs(r - sg.r) - sg.w / 2);
    const dh = h >= sg.startH && h <= sg.endH ? 0 : Math.min(hoursApart(h, sg.startH), hoursApart(h, sg.endH));
    consider('seg', sg.id, Math.hypot(dr, dh * pxPerHour), sg.layer === 'overlap');
  }
  return best ? { kind: best.kind, id: best.id } : null;
}

/** Does a press at (x, y) land on the progress ball (at `nowH` on the main track)? Only the ball starts a scrub. */
export function ballHit(x, y, nowH, tol = SCRUB_BALL_TOL) {
  const [bx, by] = polar(nowH, RING_R);
  return Math.hypot(x - bx, y - by) <= tol;
}

/** Scrub state: `{ hours, dragging, releasedAt }`. Active while dragging and for SNAP_MS after release. */
export const scrubStart = (hours) => ({ hours, dragging: true, releasedAt: 0 });
export const scrubMove = (s, hours) => (s && s.dragging ? { ...s, hours } : s);
export const scrubRelease = (s, nowMs) => (s ? { ...s, dragging: false, releasedAt: nowMs } : s);
export const scrubActive = (s, nowMs) => !!s && (s.dragging || nowMs - s.releasedAt < SNAP_MS);
/** Milliseconds until the scrub snaps back to now (0 while dragging or when idle). */
export const scrubRemaining = (s, nowMs) => (!s || s.dragging ? 0 : Math.max(0, SNAP_MS - (nowMs - s.releasedAt)));

/** What is at hour `h`: a surface primary segment first, then a calendar event, then an overlap; else Free. */
export function scrubInfo(h, model, calSpans) {
  const inSpan = (s) => h >= s.startH && h < s.endH;
  const prim = model.segs.find((s) => s.layer === 'primary' && inSpan(s));
  const cal = (calSpans || []).find(inSpan);
  const over = model.segs.find((s) => s.layer === 'overlap' && inSpan(s));
  const pick = prim ? { title: prim.ev.title, color: prim.color } : cal ? { title: cal.title, color: cal.color || '#ffb347' } : over ? { title: over.ev.title, color: over.color } : null;
  return { time: shortTime(h), title: pick ? pick.title : 'Free', free: !pick, color: pick ? pick.color : null };
}

/* ---------- travel and the leave-by line ---------- */

/**
 * The Event whose travel-adjusted leave time is soonest and still relevant (not more than LATE_MIN past), as the
 * `departure` shape departureView understands.
 */
export function travelDeparture(events, nowMs) {
  let best = null;
  for (const e of events || []) {
    if (!isRingEvent(e) || !e.travel || !(e.travel.minutes > 0)) continue;
    const at = Date.parse(e.at);
    const end = Date.parse(e.end);
    if (isNaN(at) || (!isNaN(end) && end <= nowMs)) continue;
    const leave = at - e.travel.minutes * 60000;
    if ((leave - nowMs) / 60000 < -LATE_MIN) continue;
    if (!best || leave < best.leave) best = { leave, e };
  }
  return best ? { label: best.e.title, kind: 'travel', event_id: best.e.id, leave_at: new Date(best.leave).toISOString() } : null;
}

/** The departure the face shows: the earlier live one of the bus's desk departure (the train) and an Event's travel. */
export function pickDeparture(deskDep, events, nowMs, tz) {
  const cands = [deskDep, travelDeparture(events, nowMs)].map((d) => (d ? { d, v: departureView(d, nowMs, tz) } : null)).filter((x) => x && x.v);
  if (!cands.length) return null;
  const t = (c) => Date.parse(c.d.leave_at) + Math.max(0, Number(c.d.delay_min) || 0) * 60000;
  cands.sort((a, b) => t(a) - t(b));
  return cands[0].v;
}

/* ---------- primary slot ---------- */

/** The next thing starting today after `nowH`: a calendar span, a surface segment or a tick. */
export function nextUp(calSpans, model, nowH) {
  const all = [
    ...(calSpans || []).filter((s) => s.startH > nowH).map((s) => ({ h: s.startH, title: s.title })),
    ...model.segs.filter((s) => s.startH > nowH).map((s) => ({ h: s.startH, title: s.ev.title })),
    ...model.ticks.filter((t) => t.h > nowH).map((t) => ({ h: t.h, title: t.ev.title })),
  ];
  all.sort((a, b) => a.h - b.h);
  return all[0] || null;
}

/**
 * The orange line under the time. A live `primary` slot overrides the next Event; with an `action` it is a tappable button.
 * Returns null when there is neither (the face then says it is clear).
 */
export function primaryView(store, next, nowMs) {
  const slot = activeSlot(store, 'primary', nowMs);
  if (slot) {
    const a = slot.action && slot.action.id ? slot.action : null;
    return { source: 'slot', text: slot.text || (a ? a.label : ''), color: slot.color ? colorValue(slot.color, null) : null, action: a };
  }
  if (next) return { source: 'next', text: `${shortTime(next.h)} · ${next.title}`, color: null, action: null };
  return null;
}

/* ---------- context slot and widgets ---------- */

const WIDGET_ALIAS = { gauge: 'gauge', progress: 'gauge', countdown: 'countdown', icon: 'icon', 'icon-with-value': 'icon', icon_with_value: 'icon', 'icon-value': 'icon', sparkline: 'spark', 'sparkline-lite': 'spark', text: 'text' };

/** Countdown text: "2h 10m", "35m", "now". */
export function countdownText(toMs, nowMs) {
  const m = Math.ceil((toMs - nowMs) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`.replace(' 00m', '');
  return `${Math.floor(m / 1440)}d`;
}

/** One widget as a render model, or null when it cannot be drawn (unknown type without text). */
export function widgetView(w, nowMs) {
  if (!w) return null;
  const d = (w.data && typeof w.data === 'object') ? w.data : {};
  const kind = WIDGET_ALIAS[String(w.type || '').toLowerCase()];
  const label = d.label != null ? String(d.label) : '';
  const color = d.color ? colorValue(d.color, null) : null;
  switch (kind) {
    case 'text': return d.text != null || d.value != null ? { kind, text: String(d.text ?? d.value), label, color } : null;
    case 'gauge': {
      const max = Number(d.max) > 0 ? Number(d.max) : 100;
      const v = Number(d.value);
      if (!Number.isFinite(v)) return d.text != null ? { kind: 'text', text: String(d.text), label, color } : null;
      const frac = Math.min(1, Math.max(0, v / max));
      return { kind, frac, text: d.text != null ? String(d.text) : `${Math.round(frac * 100)}%`, label, color };
    }
    case 'countdown': {
      const to = Date.parse(d.to || d.at || d.until || '');
      if (isNaN(to)) return d.text != null ? { kind: 'text', text: String(d.text), label, color } : null;
      return { kind, text: countdownText(to, nowMs), label, color, done: to <= nowMs };
    }
    case 'icon': return d.icon != null || d.value != null ? { kind, icon: String(d.icon ?? ''), text: d.value != null ? String(d.value) : '', label, color } : null;
    case 'spark': {
      const pts = Array.isArray(d.points) ? d.points.map(Number).filter(Number.isFinite).slice(-24) : [];
      if (pts.length < 2) return d.text != null ? { kind: 'text', text: String(d.text), label, color } : null;
      const lo = Math.min(...pts), hi = Math.max(...pts);
      return { kind, points: pts.map((p) => (hi === lo ? 0.5 : (p - lo) / (hi - lo))), text: d.text != null ? String(d.text) : '', label, color };
    }
    default: return d.text != null ? { kind: 'text', text: String(d.text), label, color } : null; // unknown type: its text, or nothing
  }
}

/**
 * What goes above the time. At most two text lines in all.
 *   - a departure ("Leave in N min") always comes first;
 *   - a live `context` slot then adds its `lines` (up to the room left) or its `widgets` (up to 3 that exist and can be drawn);
 *   - the face's `layout.slots.context` ('lines' or 'widgets') limits which form is drawn;
 *   - with no departure and no slot content, the date.
 * Items: { kind: 'leave', departure } | { kind: 'line', text } | { kind: 'widgets', list } | { kind: 'date' }.
 */
export function contextView(store, { departure = null, layout = {}, nowMs }) {
  const items = [];
  if (departure) items.push({ kind: 'leave', departure });
  const slot = activeSlot(store, 'context', nowMs);
  let slotShown = false;
  if (slot) {
    const room = 2 - items.length;
    const mode = layout.context || null;
    if (Array.isArray(slot.widgets) && slot.widgets.length && mode !== 'lines') {
      const list = slot.widgets.slice(0, 3).map((id) => widgetView(store.items.widgets[id], nowMs)).filter(Boolean);
      if (list.length) { items.push({ kind: 'widgets', list }); slotShown = true; }
    } else if (Array.isArray(slot.lines) && slot.lines.length && mode !== 'widgets') {
      for (const t of slot.lines.slice(0, room)) { items.push({ kind: 'line', text: String(t) }); slotShown = true; }
    } else if (slot.text && mode !== 'widgets') {
      if (room > 0) { items.push({ kind: 'line', text: String(slot.text) }); slotShown = true; }
    }
  }
  if (!departure && !slotShown) items.push({ kind: 'date' });
  return items;
}

/** Calendar spans as the day dial draws them: timed, with lanes (existing base layer). */
export function calendarLanes(events, now, tz) {
  const { timed, allDay } = daySpans(events, now, tz);
  return { lanes: assignLanes(timed), timed, allDay };
}

export { itemsOf };
