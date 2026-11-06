// NOAA sunrise and sunset (the NOAA Solar Calculator / spreadsheet algorithm) and the daylight crescent (spec 5.3).
// Pure: no DOM, unit-tested under vitest.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Fallback when no location is known: 6:30 AM to 5:30 PM local (spec 5.3, 10). */
export const FALLBACK = { riseMin: 6 * 60 + 30, setMin: 17 * 60 + 30 };

function solar(jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eot = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  return { decl, eot };
}

/**
 * Sunrise and sunset for a calendar date (y, mo 1-12, d) at latitude/longitude (east positive).
 * Returns { rise, set } as UTC epoch ms, or { polar: 'day' | 'night' } when the sun never sets or never rises.
 */
export function sunTimes(y, mo, d, lat, lon) {
  const day0 = Date.UTC(y, mo - 1, d);
  const jd0 = day0 / 86400000 + 2440587.5;
  const event = (sign) => {
    // Two passes: first at UTC noon, then at the estimated event time.
    let min = 720 - 4 * lon;
    for (let i = 0; i < 2; i++) {
      const { decl, eot } = solar(jd0 + min / 1440);
      const cosH = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) - Math.tan(rad(lat)) * Math.tan(rad(decl));
      if (cosH < -1) return { polar: 'day' };
      if (cosH > 1) return { polar: 'night' };
      const ha = deg(Math.acos(cosH));
      min = 720 - 4 * lon - eot + sign * 4 * ha;
    }
    return { ms: day0 + Math.round(min * 60000) };
  };
  const r = event(-1);
  if (r.polar) return { polar: r.polar };
  const s = event(1);
  if (s.polar) return { polar: s.polar };
  return { rise: r.ms, set: s.ms };
}

/** Fraction of daylight elapsed (spec 5.3): d = (now - sunrise) / (sunset - sunrise). */
export const daylightFraction = (nowMs, riseMs, setMs) => (nowMs - riseMs) / (setMs - riseMs);

/**
 * Centre x of the shade circle (r 260). Night (d <= 0 or d >= 1): 233, fully shaded.
 * Morning: 233 + 2d x 493; afternoon: 233 + (2d - 2) x 493. `polar` 'day' gives a fully lit face (the circle off the panel).
 */
export function crescentCx(nowMs, riseMs, setMs, polar = null) {
  if (polar === 'day') return 233 + 493;
  if (polar === 'night') return 233;
  const d = daylightFraction(nowMs, riseMs, setMs);
  if (!(d > 0) || d >= 1) return 233;
  return d <= 0.5 ? 233 + 2 * d * 493 : 233 + (2 * d - 2) * 493;
}
/** Box left of the shade circle (cx - 260), the figure the spec's table lists. */
export const crescentLeft = (nowMs, riseMs, setMs, polar = null) => crescentCx(nowMs, riseMs, setMs, polar) - 260;
