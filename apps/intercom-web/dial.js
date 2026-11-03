// SVG builders for the dial rims.
import { C, RING_R, LANE_GAP, arcPath, polar, daySpans, assignLanes, tzParts, PRESSURE_COLORS } from './logic.js';
import { ringModel, TICK_R0, TICK_R1 } from './dayv2.js';

const PALETTE = ['#e39aab', '#74c978', '#ffb347', '#5fc0b3', '#9db4ff', '#c9a0ff'];

function colorFor(ev) {
  if (ev.color) return ev.color;
  let h = 0;
  for (const c of ev.calendar || ev.title || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * Day-dial rim: 24 h ring, midnight at top, calendar events as the base layer, surface Events over them
 * (primary wide, overlaps narrow inside/outside, travel wedge before, ticks across the rim), and the gold progress ball.
 * extra: { surfaceEvents, model (a ringModel result), scrub: {hours} while scrubbing }.
 */
export function dayRingSvg(events, now, tz, halo = false, pressure = null, extra = {}) {
  const { timed } = daySpans(events, now, tz);
  const lanes = assignLanes(timed);
  const nowH = tzParts(now, tz).hours;
  const model = extra.model || ringModel(extra.surfaceEvents || [], now, tz);
  let s = `<svg viewBox="0 0 466 466" aria-hidden="true">`;
  if (pressure) {
    // Leave-by pressure replaces the attention halo: green, amber, red, and a gentle pulse under five minutes.
    s += `<circle class="${pressure === 'pulse' ? 'prs-pulse' : ''}" cx="${C}" cy="${C}" r="225" fill="none" stroke="${PRESSURE_COLORS[pressure]}" stroke-width="6"/>`;
  } else if (halo) {
    s += `<defs><filter id="hb" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="5"/></filter></defs>` +
      `<circle cx="${C}" cy="${C}" r="224" fill="none" stroke="#ffb347" stroke-width="14" opacity=".7" filter="url(#hb)"/>` +
      `<circle cx="${C}" cy="${C}" r="225" fill="none" stroke="#ffb347" stroke-width="5"/>`;
  }
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
  // Surface Events over the calendar: wide primaries first, then the narrow overlaps.
  const arc = (a, b, r, w, color, opacity, dash = '') => `<path d="${arcPath(a, Math.min(24, Math.max(a + 0.05, b)), r)}" stroke="${color}" stroke-width="${w}" fill="none"${dash ? ` stroke-dasharray="${dash}"` : ''}${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`;
  for (const g of model.segs) {
    if (g.travel) s += arc(g.travel.startH, g.travel.endH, g.r, g.w, g.color, g.past ? 0.15 : 0.4, '5 4');
  }
  for (const g of model.segs.filter((x) => x.layer === 'primary')) s += arc(g.startH + 0.03, g.endH - 0.03, g.r, g.w, g.color, g.past ? 0.4 : 1);
  for (const g of model.segs.filter((x) => x.layer === 'overlap')) s += arc(g.startH + 0.03, g.endH - 0.03, g.r, g.w, g.color, g.past ? 0.4 : 1);
  for (const t of model.ticks) {
    const [x1, y1] = polar(t.h, TICK_R0);
    const [x2, y2] = polar(t.h, TICK_R1);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#000" stroke-width="10" stroke-linecap="round"/>` +
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${t.color}" stroke-width="5" stroke-linecap="round"${t.past ? ' opacity=".4"' : ''}/>`;
  }
  const [nx, ny] = polar(nowH, RING_R);
  if (extra.scrub) {
    // The ball becomes the scrub head; a small ring marks where now is.
    const [bx, by] = polar(extra.scrub.hours, RING_R);
    s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="7" fill="none" stroke="#d9b23a" stroke-width="3"/>` +
      `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="19" fill="#d9b23a" stroke="#f6eedb" stroke-width="4"/>`;
  } else {
    s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="15" fill="#d9b23a" stroke="#000" stroke-width="4"/>`;
  }
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

/** SVG arc between two angles in radians (0 at the top, clockwise). */
function segPath(a0, a1, r) {
  const pt = (a) => [C + r * Math.sin(a), C - r * Math.cos(a)];
  const [x1, y1] = pt(a0);
  const [x2, y2] = pt(a1);
  const f = (n) => Math.round(n * 10) / 10;
  return `M${f(x1)} ${f(y1)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f(x2)} ${f(y2)}`;
}

/** Status face rim: one segment per session (first eight, then a "+N" marker), coloured by state; an amber breathing ring while something needs you. */
export function statusRingSvg(model) {
  let s = `<svg viewBox="0 0 466 466" aria-hidden="true">`;
  if (model.needs) s += `<circle class="breathe" cx="${C}" cy="${C}" r="225" fill="none" stroke="#ffb347" stroke-width="7"/>`;
  if (!model.segs.length) {
    s += `<circle cx="${C}" cy="${C}" r="${RING_R}" fill="none" stroke="#1f1d1a" stroke-width="20"/>`;
  } else {
    for (const g of model.segs) s += `<path d="${segPath(g.a0, g.a1, RING_R)}" stroke="${g.color}" stroke-width="20" fill="none" stroke-linecap="butt"/>`;
  }
  if (model.more) s += `<text x="${C}" y="402" text-anchor="middle" font-size="26" font-weight="600" fill="#b3aa9a">+${model.more}</text>`;
  return s + '</svg>';
}
