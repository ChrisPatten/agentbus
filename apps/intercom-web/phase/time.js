// Phase (Plum Dusk) client: time-zone aware clock parts and the spec's time formats (12-hour, spec 10).
// Pure: no DOM, unit-tested under vitest.

export const DEFAULT_TZ = 'America/New_York';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtCache = new Map();
function fmt(tz) {
  const key = tz || '';
  if (!fmtCache.has(key)) {
    let f;
    const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' };
    try { f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || undefined }); } catch { f = new Intl.DateTimeFormat('en-US', opts); }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}

/** Wall-clock parts of an instant in a time zone: y, mo (1-12), d, h (0-23), m, s, wd (0 = Sunday), ymd. */
export function zparts(ms, tz) {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  const y = Number(g('year')), mo = Number(g('month')), d = Number(g('day'));
  const wdName = g('weekday');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wdName);
  return { y, mo, d, h: Number(g('hour')) % 24, m: Number(g('minute')), s: Number(g('second')), wd, ymd: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** Offset of `tz` from UTC at `ms`, in minutes (EST = -300). */
export function tzOffsetMin(ms, tz) {
  const p = zparts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.m, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant of a local wall-clock time in `tz` (y, mo 1-12, d, h, m). */
export function zonedMs(y, mo, d, h, m, tz, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, m, s);
  let off = tzOffsetMin(guess, tz);
  let ms = guess - off * 60000;
  const off2 = tzOffsetMin(ms, tz);
  if (off2 !== off) ms = guess - off2 * 60000;
  return ms;
}

/** Local midnight (start of the day) for the day containing `ms`. */
export function startOfDay(ms, tz) {
  const p = zparts(ms, tz);
  return zonedMs(p.y, p.mo, p.d, 0, 0, tz);
}

/** "3:30" (12-hour, no AM/PM). */
export function hm(ms, tz) {
  const p = zparts(ms, tz);
  return `${p.h % 12 || 12}:${String(p.m).padStart(2, '0')}`;
}
export const ampm = (ms, tz) => (zparts(ms, tz).h < 12 ? 'AM' : 'PM');
/** "3:30 PM". */
export const hmA = (ms, tz) => `${hm(ms, tz)} ${ampm(ms, tz)}`;
/** "Thursday · 5 Nov". */
export function dayLabel(ms, tz) {
  const p = zparts(ms, tz);
  return `${WEEKDAYS[p.wd]} · ${p.d} ${MONTHS[p.mo - 1]}`;
}
/** "Oct 12". */
export function monthDay(ms, tz) {
  const p = zparts(ms, tz);
  return `${MONTHS[p.mo - 1]} ${p.d}`;
}
export const sameDay = (a, b, tz) => zparts(a, tz).ymd === zparts(b, tz).ymd;

/** Hours and minutes as "10P", "7A", "6:30A" (the quiet-hours row). */
export function shortHour(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'A' : 'P'}`;
}
/** Minutes of the day (0-1439) of `ms` in `tz`. */
export function minuteOfDay(ms, tz) { const p = zparts(ms, tz); return p.h * 60 + p.m; }

/** "0:04", "12:05" (elapsed m:ss). */
export function mss(sec) { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
/** "00:03" under an hour, "00:47:12" after (the Capture timer). */
export function timer(sec, long = false) {
  const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return long || h ? `${p(h)}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
/** "47 MIN 12 S". */
export function lengthText(sec) {
  const s = Math.max(0, Math.floor(sec)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${h} H ` : ''}${m || h ? `${m} MIN ` : ''}${r} S`;
}
/** "4 MIN AGO", "2M AGO" style ages. */
export function agoText(fromMs, nowMs) {
  const m = Math.max(0, Math.round((nowMs - fromMs) / 60000));
  if (m < 1) return 'JUST NOW';
  if (m < 60) return `${m} MIN AGO`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} H AGO` : `${Math.floor(h / 24)} D AGO`;
}
/** "12m", "2h" (the compact form on Agents rows). */
export function shortDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
