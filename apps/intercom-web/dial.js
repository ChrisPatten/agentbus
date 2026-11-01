// SVG builders for the dial rims.
import { C, RING_R, LANE_GAP, arcPath, polar, daySpans, assignLanes, tzParts } from './logic.js';

const PALETTE = ['#e39aab', '#74c978', '#ffb347', '#5fc0b3', '#9db4ff', '#c9a0ff'];

function colorFor(ev) {
  if (ev.color) return ev.color;
  let h = 0;
  for (const c of ev.calendar || ev.title || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Day-dial rim: 24 h ring, midnight at top, one arc per event, gold now-dot. */
export function dayRingSvg(events, now, tz) {
  const { timed } = daySpans(events, now, tz);
  const lanes = assignLanes(timed);
  const nowH = tzParts(now, tz).hours;
  let s = `<svg viewBox="0 0 466 466" aria-hidden="true">`;
  s += `<circle cx="${C}" cy="${C}" r="${RING_R}" fill="none" stroke="#1f1d1a" stroke-width="20"/>`;
  for (const h of [0, 6, 12, 18]) {
    const [x, y] = polar(h, RING_R - 24);
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${h === 0 ? 4 : 3}" fill="#5a544b"/>`;
  }
  for (const ev of lanes) {
    const r = RING_R - ev.lane * LANE_GAP;
    const a = ev.startH + 0.03;
    const b = Math.max(a + 0.25, ev.endH - 0.03);
    const past = ev.endH <= nowH;
    s += `<path d="${arcPath(a, Math.min(24, b), r)}" stroke="${colorFor(ev)}" stroke-width="${ev.lane ? 10 : 20}" fill="none"${past ? ' opacity=".4"' : ''}/>`;
  }
  const [nx, ny] = polar(nowH, RING_R);
  s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="15" fill="#d9b23a" stroke="#000" stroke-width="4"/>`;
  return s + '</svg>';
}

/** Working: grey track plus a slowly turning gold arc. */
export function workingRingSvg() {
  return `<svg viewBox="0 0 466 466" aria-hidden="true"><circle cx="233" cy="233" r="212" fill="none" stroke="#2c2924" stroke-width="16"/>` +
    `<g class="spin"><circle cx="233" cy="233" r="212" fill="none" stroke="#d9b23a" stroke-width="16" stroke-linecap="round" stroke-dasharray="300 1032" transform="rotate(-60 233 233)"/></g></svg>`;
}

/** Listening: a wobbly amber ring that follows the voice. */
export function waveRingSvg() {
  const pts = [];
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * 2 * Math.PI;
    const r = 200 + (Math.sin(i * 0.9) * Math.sin(i * 0.23) + Math.sin(i * 1.7) * 0.5) * 11;
    pts.push(`${(C + r * Math.cos(a)).toFixed(1)},${(C + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<svg viewBox="0 0 466 466" aria-hidden="true"><polygon class="wave" points="${pts.join(' ')}" fill="none" stroke="#ffb347" stroke-width="6"/></svg>`;
}
