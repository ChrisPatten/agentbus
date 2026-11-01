// Pure logic for the Intercom web app: geometry, calendar selection, backoff, outbox.
// No DOM access here so it can be unit-tested under vitest.

export const C = 233; // centre of the 466 design square
export const RING_R = 208; // radius of the outer lane
export const LANE_GAP = 17; // second lane sits just inside the first; never more than two lanes

/** Hours (0..24) to an angle in radians; midnight at the top, clockwise. */
export function hourToAngle(h) {
  return (h / 24) * 2 * Math.PI - Math.PI / 2;
}

export function polar(h, r) {
  const a = hourToAngle(h);
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

const f1 = (n) => Math.round(n * 10) / 10;

/** SVG path for an arc on the 24 h ring from h1 to h2 (h1 < h2). */
export function arcPath(h1, h2, r = RING_R) {
  const span = Math.min(24, Math.max(0, h2 - h1));
  const end = span >= 24 ? h1 + 23.999 : h2;
  const [x1, y1] = polar(h1, r);
  const [x2, y2] = polar(end, r);
  return `M${f1(x1)} ${f1(y1)} A${r} ${r} 0 ${end - h1 > 12 ? 1 : 0} 1 ${f1(x2)} ${f1(y2)}`;
}

/** Local wall-clock parts of a Date in a given IANA timezone. */
export function tzParts(date, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date);
  }
  const g = (t) => parts.find((p) => p.type === t).value;
  const hour = Number(g('hour')) % 24;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hour, minute: Number(g('minute')), hours: hour + Number(g('minute')) / 60 };
}

/** Normalise calendar events to hour spans on the given day (clamped to 0..24). */
export function daySpans(events, now, tz) {
  const today = tzParts(now, tz).ymd;
  const timed = [];
  const allDay = [];
  for (const ev of events || []) {
    if (!ev) continue;
    if (ev.all_day) {
      allDay.push(ev);
      continue;
    }
    const s = new Date(ev.start);
    const e = new Date(ev.end || ev.start);
    if (isNaN(s) || isNaN(e)) continue;
    const sp = tzParts(s, tz);
    const ep = tzParts(e, tz);
    if (ep.ymd < today || sp.ymd > today) continue;
    const start = sp.ymd < today ? 0 : sp.hours;
    let end = ep.ymd > today ? 24 : ep.hours;
    if (end <= start) end = Math.min(24, start + 0.25);
    timed.push({ ...ev, startH: start, endH: end, startDate: s });
  }
  timed.sort((a, b) => a.startH - b.startH || a.endH - b.endH);
  return { timed, allDay };
}

/** Greedy lane packing so overlapping events sit on inner lanes. Max 3 lanes. */
export function assignLanes(spans) {
  const laneEnds = [];
  return spans.map((sp) => {
    let lane = laneEnds.findIndex((end) => sp.startH >= end - 0.001);
    if (lane === -1) lane = laneEnds.length < 2 ? laneEnds.length : 1; // at most 2 lanes, so arcs stay clear of the text
    laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, sp.endH);
    return { ...sp, lane };
  });
}

/** First timed event that has not started yet, or null. */
export function nextEvent(spans, now, tz) {
  const nowH = tzParts(now, tz).hours;
  return spans.find((s) => s.startH > nowH) || null;
}

/** 12-hour clock with no am/pm and no seconds: "7:52". */
export function clockText(now, tz) {
  const p = tzParts(now, tz);
  const h = p.hour % 12 || 12;
  return `${h}:${String(p.minute).padStart(2, '0')}`;
}

export function shortTime(hours) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60) % 24;
  return `${h % 12 || 12}:${String(total % 60).padStart(2, '0')}`;
}

export function dateText(now, tz) {
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (tz) opts.timeZone = tz;
  let s;
  try { s = new Intl.DateTimeFormat('en-US', opts).format(now); } catch { delete opts.timeZone; s = new Intl.DateTimeFormat('en-US', opts).format(now); }
  // "Mon, Nov 2" -> "MON · NOV 2"
  return s.replace(',', ' ·').toUpperCase();
}

export function allDayLine(allDay) {
  if (!allDay.length) return '';
  const first = allDay[0].title || '';
  return allDay.length > 1 ? `${first} +${allDay.length - 1}` : first;
}

/** Reconnect delay: 0.5 s doubling up to 10 s, with optional jitter fn (0..1). */
export function backoffDelay(attempt, jitter = () => 0) {
  const base = Math.min(10000, 500 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 - 0.2 * jitter()));
}

/** Pull a pairing code out of a pasted code, URL or fragment. */
export function parsePairInput(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/pair=([^&\s]+)/);
  return decodeURIComponent(m ? m[1] : t);
}

/** Reply glance: server glance if present, else first sentence of the body. */
export function glanceOf(reply) {
  const g = (reply.glance || '').trim();
  if (g) return g.length > 100 ? g.slice(0, 99).trimEnd() + '…' : g;
  const body = (reply.body || '').replace(/\s+/g, ' ').trim();
  const m = body.match(/^.*?[.!?](\s|$)/);
  let s = (m ? m[0] : body).trim();
  if (s.length > 100) {
    s = s.slice(0, 100);
    const i = s.lastIndexOf(' ');
    s = (i > 40 ? s.slice(0, i) : s).trimEnd() + '…';
  }
  return s;
}

/** Is a replayed reply fresh enough to show on the dial? */
export function replyIsFresh(reply, nowMs, maxAgeMs = 120000) {
  const t = Date.parse(reply.created_at || '');
  return isNaN(t) ? true : nowMs - t <= maxAgeMs;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Outbox of sends awaiting an ack. Resends reuse the same client_msg_id. */
export class Outbox {
  constructor(items = [], makeId = () => crypto.randomUUID()) {
    this.items = items.slice();
    this.makeId = makeId;
  }
  add(body) {
    const item = { client_msg_id: this.makeId(), body };
    this.items.push(item);
    return item;
  }
  ack(id) {
    const n = this.items.length;
    this.items = this.items.filter((i) => i.client_msg_id !== id);
    return this.items.length !== n;
  }
  pending() { return this.items.slice(); }
  get size() { return this.items.length; }
}
