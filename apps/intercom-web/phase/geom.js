// Phase face geometry (spec 4): the 12-hour rim, clock-to-point, arcs, the alert drain, progress arcs, the moon.
// Pure: no DOM, unit-tested under vitest.

export const C = 233;
export const R = { panel: 233, rim: 214, tap: 210, lane1: 197, text: 190, lane2: 184, capBottom: 182, capTop: 168, prog: 150 };
export const RIM_DOTS = 60;
export const RIM_DASH = '0.1 22.31'; // 60 round-capped dots on r 214, one every 6 degrees (period 22.41 = 2 pi 214 / 60)
export const TOP_PATH = 'M65 233A168 168 0 0 1 401 233';
export const BOT_PATH = 'M51 233A182 182 0 0 0 415 233';

const f1 = (n) => Math.round(n * 10) / 10;

/** Clock angle in degrees, clockwise from 12 o'clock, for h (any), m, s on the 12-hour dial (spec 4.2). */
export const clockDeg = (h, m = 0, s = 0) => (((h % 12) + m / 60 + s / 3600) / 12) * 360;
/** Point at clock angle `deg` on radius r. */
export function pt(deg, r) {
  const a = (deg * Math.PI) / 180;
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
}
/** Spec 4.2: x = 233 + r sin theta, y = 233 - r cos theta. */
export const clockPoint = (h, m, s = 0, r = R.rim) => pt(clockDeg(h, m, s), r);

/** SVG path along radius r from angle a1 clockwise to a2 (degrees, a2 may exceed 360). */
export function arcD(a1, a2, r) {
  let sweep = a2 - a1;
  if (sweep <= 0) sweep += 360;
  if (sweep >= 359.99) sweep = 359.99;
  const p1 = pt(a1, r), p2 = pt(a1 + sweep, r);
  return `M${f1(p1.x)} ${f1(p1.y)}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${f1(p2.x)} ${f1(p2.y)}`;
}

/** The same arc around an arbitrary centre (the hold target's ring at (233, 300)). */
export function arcAround(cx, cy, a1, a2, r) {
  let sweep = a2 - a1;
  if (sweep <= 0) sweep += 360;
  if (sweep >= 359.99) sweep = 359.99;
  const rad = (d) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.sin(rad(a1)), y1 = cy - r * Math.cos(rad(a1)), x2 = cx + r * Math.sin(rad(a1 + sweep)), y2 = cy - r * Math.cos(rad(a1 + sweep));
  return `M${f1(x1)} ${f1(y1)}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${f1(x2)} ${f1(y2)}`;
}

/** Clock angle of an instant given its local h/m/s parts. */
export const partsDeg = (p) => clockDeg(p.h, p.m, p.s || 0);

/**
 * Alert rim drain (spec 7.1): one dot per 1/60 of the window from arrival to expires_at.
 * Returns how many dots are still lit (60 at arrival, 0 at expiry). Without a valid window all 60 stay lit.
 */
export function drainLit(arrivalMs, expiresMs, nowMs) {
  const w = expiresMs - arrivalMs;
  if (!(w > 0) || !Number.isFinite(w)) return RIM_DOTS;
  const gone = Math.floor(((nowMs - arrivalMs) / w) * RIM_DOTS);
  return Math.max(0, Math.min(RIM_DOTS, RIM_DOTS - Math.max(0, gone)));
}
/** Clock angles of the lit dots: dots go out clockwise from 12, so the lit run ends at 354 degrees. */
export function drainDots(lit) {
  const out = [];
  for (let i = RIM_DOTS - Math.max(0, Math.min(RIM_DOTS, lit)); i < RIM_DOTS; i++) out.push(i * 6);
  return out;
}

/** Upper progress arc (spec 4.4 row 4): r 150 from 10 o'clock (300 deg) to 2 o'clock (60 deg) over the top. */
export const UPPER = { a0: -60, a1: 60 };
/** Lower progress arc (row 6): r 150 from 8 o'clock (240 deg) to 4 o'clock (120 deg) under the bottom, left to right. */
export const LOWER = { a0: 240, a1: 120 };
export function upperArc(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const a = UPPER.a0 + 120 * f;
  return { track: TRACK_UP, fill: f > 0 ? arcD(UPPER.a0, a, R.prog) : '', start: pt(UPPER.a0, R.prog), head: pt(a, R.prog) };
}
export function lowerArc(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const a = LOWER.a0 - 120 * f; // counter-clockwise on the clock = left to right along the bottom
  const p0 = pt(LOWER.a0, R.prog), p1 = pt(a, R.prog);
  return { track: TRACK_LOW, fill: f > 0 ? `M${f1(p0.x)} ${f1(p0.y)}A150 150 0 0 0 ${f1(p1.x)} ${f1(p1.y)}` : '', head: p1 };
}
export const TRACK_UP = 'M103.1 158A150 150 0 0 1 362.9 158';
export const TRACK_LOW = 'M103.1 308A150 150 0 0 0 362.9 308';

/** Moon angle (spec 5.2): seconds x 6 degrees clockwise from 12 o'clock; parked at 0 when reduced motion is on. */
export const moonDeg = (sec, parked = false) => (parked ? 0 : (Math.floor(sec) % 60) * 6);

/** Burn-in walk (spec 11.2): 12 positions on a 3 x 4 grid, 3 px apart, one step a minute along a snake path. */
export const WALK = (() => {
  const xs = [-3, 0, 3], ys = [-4.5, -1.5, 1.5, 4.5], out = [];
  ys.forEach((y, i) => (i % 2 ? xs.slice().reverse() : xs).forEach((x) => out.push({ x, y })));
  return out;
})();
export const walkAt = (minuteIndex) => WALK[((minuteIndex % 12) + 12) % 12];

/** Settings rim sliders (spec 7.8): brightness 8 o'clock (240) up to 10 o'clock (300); volume 4 o'clock (120) up to 2 o'clock (60). */
export const SLIDERS = { left: { a0: 240, a1: 300 }, right: { a0: 120, a1: 60 } };
export function sliderArcs(side, frac) {
  const s = SLIDERS[side], f = Math.max(0, Math.min(1, frac));
  const a = s.a0 + (s.a1 - s.a0) * f;
  const p0 = pt(s.a0, R.rim), p1 = pt(s.a1, R.rim), pk = pt(a, R.rim);
  const ccw = side === 'right';
  const seg = (q0, q1) => `M${f1(q0.x)} ${f1(q0.y)}A214 214 0 0 ${ccw ? 0 : 1} ${f1(q1.x)} ${f1(q1.y)}`;
  return { track: seg(p0, p1), fill: f > 0 ? seg(p0, pk) : '', knob: pk };
}
/** Which slider (if any) a design point is on, and its value there: the touch band is 56 px wide along the rim. */
export function sliderHit(x, y) {
  const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
  if (r < R.rim - 28 || r > R.rim + 28) return null;
  const a = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  for (const side of ['left', 'right']) {
    const s = SLIDERS[side], lo = Math.min(s.a0, s.a1) - 6, hi = Math.max(s.a0, s.a1) + 6;
    if (a >= lo && a <= hi) return { side, value: Math.max(0, Math.min(1, (a - s.a0) / (s.a1 - s.a0))) };
  }
  return null;
}
