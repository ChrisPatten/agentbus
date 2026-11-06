// Phase rendering primitives (spec 5): glass, crescent, rim, Moment marks, now dot and moon, progress arcs, curved captions,
// action capsule, pills, rows, status glyphs and icons. Every function returns an HTML or SVG string; colours are always
// the CSS custom properties of spec 3.1 (var(--token)), never literals.
import { escapeHtml as esc } from '../logic.js';
import { R, RIM_DASH, TOP_PATH, BOT_PATH, pt, arcD, upperArc, lowerArc, TRACK_UP, TRACK_LOW } from './geom.js';

export { esc };
export const V = (t) => `var(--${t})`;
const f1 = (n) => Math.round(n * 10) / 10;

/* ---------- text measure (canvas in the browser, an estimate elsewhere) ---------- */

let measureImpl = (text, font) => {
  const size = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [0, 15])[1]);
  return String(text).length * size * 0.74;
};
/** Install a real measure (the app passes a canvas-based one once the fonts have loaded). */
export function setMeasure(fn) { measureImpl = fn; }
/** Width in px of `text` in Lexend Exa at `weight`/`size` with `track` em of letter spacing per glyph. */
export function measure(text, size, weight = 600, track = 0) {
  const s = String(text);
  return measureImpl(s, `${weight} ${size}px "Lexend Exa"`) + s.length * track * size;
}

/* ---------- type ---------- */

/** CSS font shorthand plus letter spacing. fam: 'lx' (Lexend Exa) or 'hk' (Hanken Grotesk). */
export function font(weight, size, lh, ls = 0, fam = 'lx', italic = false) {
  const family = fam === 'hk' ? "'Hanken Grotesk',system-ui,sans-serif" : "'Lexend Exa',system-ui,sans-serif";
  return `font:${italic ? 'italic ' : ''}${weight} ${size}px/${lh}px ${family};letter-spacing:${ls}em`;
}
/** An absolutely positioned text block, centred across `width` by default. `text` is escaped; `html` is not. */
export function tx({ top, left = 0, width = 466, f, color = 'ink', op = null, text = '', html = null, cls = '', style = '', align = 'center', attrs = '' }) {
  return `<div class="t ${cls}" ${attrs} style="left:${left}px;top:${top}px;width:${width}px;text-align:${align};${f};color:${V(color)};${op !== null ? `opacity:${op};` : ''}${style}">${html !== null ? html : esc(text)}</div>`;
}
export const caps = (s) => String(s || '').toUpperCase();

/* ---------- layers ---------- */

/** The daylight shade: one r 260 circle whose box left is `left` (spec 5.3); on the rose flood it is alert-shade at 14%. */
export function crescent(left, alert = false) {
  if (left === null || left === undefined) return '';
  return `<circle class="shade" cx="${f1(left + 260)}" cy="233" r="260" style="fill:${V(alert ? 'alert-shade' : 'shade')}" fill-opacity="${alert ? 0.14 : 0.5}"/>`;
}

/**
 * The rim (spec 5.1, 7). kind: 'dots' (60 dots, rim at 80%), 'dashed' (offline: dash 10 / 12.4 at 70%), 'faint' (pairing: 25%),
 * 'night' (night-line), 'alert' (rose-ink at 22%, 3.5 px), 'none'.
 */
export function rim(kind = 'dots') {
  switch (kind) {
    case 'none': return '';
    case 'dashed': return `<circle cx="233" cy="233" r="214" fill="none" style="stroke:${V('rim')}" stroke-width="3" stroke-dasharray="10 12.4" stroke-opacity=".7"/>`;
    case 'faint': return `<circle cx="233" cy="233" r="214" fill="none" style="stroke:${V('rim')}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${RIM_DASH}" stroke-opacity=".25"/>`;
    case 'night': return `<circle cx="233" cy="233" r="214" fill="none" style="stroke:${V('night-line')}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${RIM_DASH}"/>`;
    case 'alert': return `<circle cx="233" cy="233" r="214" fill="none" style="stroke:${V('rose-ink')}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${RIM_DASH}" stroke-opacity=".22"/>`;
    default: return `<circle cx="233" cy="233" r="214" fill="none" style="stroke:${V('rim')}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${RIM_DASH}" stroke-opacity=".8"/>`;
  }
}
/** Individually drawn rim dots at clock angles (the alert drain and the pairing code's life). */
export function rimDotsAt(angles, tone, width, opacity = 1) {
  const r = width / 2;
  return angles.map((a) => { const p = pt(a, R.rim); return `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${r}" style="fill:${V(tone)}" fill-opacity="${opacity}"/>`; }).join('');
}

/**
 * Moment marks (spec 5.1): { type: 'dot', deg } discs r 4 on r 214; { type: 'arc', a1, a2, lane, amber } 3 px arcs on r 197 / r 184.
 * opts: selected (id drawn 4 px, others dropped), dim (opacity, offline 0.55), tone override, diamond (no-end detail mark), width.
 */
export function marks(list, opts = {}) {
  const out = [];
  for (const m of list || []) {
    if (opts.selected && m.id !== opts.selected) continue;
    const tone = m.tone || (m.amber ? 'amber' : opts.tone || 'rose');
    const op = m.op ?? opts.dim ?? 1;
    if (m.type === 'dot') {
      const p = pt(m.deg, R.rim);
      if (opts.selected || m.diamond) out.push(`<rect x="${f1(p.x - 6)}" y="${f1(p.y - 6)}" width="12" height="12" transform="rotate(45 ${f1(p.x)} ${f1(p.y)})" style="fill:${V(tone)}" fill-opacity="${op}"/>`);
      else out.push(`<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="4" style="fill:${V(tone)}" fill-opacity="${op}"/>`);
    } else {
      const r = m.lane === 2 ? R.lane2 : R.lane1;
      const w = m.width || (opts.selected ? 4 : 3);
      out.push(`<path d="${arcD(m.a1, m.a2, r)}" fill="none" style="stroke:${V(tone)}" stroke-opacity="${op}" stroke-width="${w}" stroke-linecap="round"/>`);
    }
  }
  return out.join('');
}

/**
 * The now dot with its orbit ring and second-hand moon (spec 5.2). pal: 'day' | 'rose' | 'night'. moon: degrees, or null (hidden).
 * moonTone overrides the moon colour (the board draws it peri on the waiting-on-you screens).
 */
export function nowDot(p, moon, pal = 'day', moonTone = null, ring = true) {
  if (!p) return '';
  const x = f1(p.x), y = f1(p.y);
  const tone = { day: ['ink', 'hair', 0.6, 'rose'], rose: ['rose-ink', 'rose-ink', 0.35, 'rose-ink'], night: ['night', 'night-line', 0.8, 'night'] }[pal];
  const ringSvg = ring && moon !== null ? `<circle cx="${x}" cy="${y}" r="13" fill="none" style="stroke:${V(tone[1])}" stroke-opacity="${tone[2]}"/>` : '';
  const moonSvg = moon !== null ? `<g class="moon" data-x="${x}" data-y="${y}" transform="rotate(${moon} ${x} ${y})"><circle cx="${x}" cy="${f1(p.y - 13)}" r="3" style="fill:${V(moonTone || tone[3])}"/></g>` : '';
  return `${ringSvg}<circle class="nowdot" cx="${x}" cy="${y}" r="5" style="fill:${V(tone[0])}"/>${moonSvg}`;
}

/** Progress arcs on Now (spec 4.4, 5.4): upper fills rose from 10 o'clock; lower fills rose at 55% left to right. */
export function progressArcs(upper, lower, fillTone = 'rose') {
  let s = '';
  if (upper !== null && upper !== undefined) {
    const u = upperArc(upper);
    s += `<path d="${TRACK_UP}" fill="none" style="stroke:${V('hair')}" stroke-width="2.5" stroke-linecap="round"/>`;
    if (u.fill) s += `<path d="${u.fill}" fill="none" style="stroke:${V(fillTone)}" stroke-width="3" stroke-linecap="round"/>`;
    if (fillTone === 'rose') s += `<circle cx="103.1" cy="158" r="4" style="fill:${V('rose')}"/><circle cx="${f1(u.head.x)}" cy="${f1(u.head.y)}" r="6.5" style="fill:${V('rose')}"/>`;
  }
  if (lower !== null && lower !== undefined) {
    const l = lowerArc(lower);
    s += `<path d="${TRACK_LOW}" fill="none" style="stroke:${V('hair')}" stroke-width="2.5" stroke-linecap="round"/>`;
    if (l.fill) s += `<path d="${l.fill}" fill="none" style="stroke:${V('rose')}" stroke-opacity=".55" stroke-width="3" stroke-linecap="round"/>`;
    s += `<circle cx="${f1(l.head.x)}" cy="${f1(l.head.y)}" r="6.5" style="fill:${V('hair')}"/>`;
  }
  return s;
}

/* ---------- curved captions (spec 4.3, 5.5) ---------- */

/** Longest caption, in px of arc, before the ellipsis (about 26 characters on the bottom path). */
export const CAP_MAX = { top: 375, bottom: 400 };
/** Fit a caption by measured arc length. */
export function fitCaption(text, where) {
  const size = where === 'top' ? 15 : 16;
  const t = caps(text).trim();
  const w = (s) => measure(s, size, 700, 0.16);
  if (!t || w(t) <= CAP_MAX[where]) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (w(`${t.slice(0, mid).trimEnd()}…`) <= CAP_MAX[where]) lo = mid; else hi = mid - 1; }
  return `${t.slice(0, lo).trimEnd()}…`;
}
/** A caption on the top (r 168) or bottom (r 182) path. c: { text, tone, op, size }. */
export function caption(c, where) {
  if (!c || !c.text) return '';
  const id = where === 'top' ? 'phTop' : 'phBot';
  const size = c.size || (where === 'top' ? 15 : 16);
  const t = c.fixed ? caps(c.text) : fitCaption(c.text, where);
  return `<text class="cap" data-cap="${where}" font-size="${size}" style="fill:${V(c.tone || 'ink')}" fill-opacity="${c.op ?? 1}" text-anchor="middle"><textPath href="#${id}" startOffset="50%">${esc(t)}</textPath></text>`;
}
export const CAPTION_DEFS = `<defs><path id="phTop" d="${TOP_PATH}" fill="none"/><path id="phBot" d="${BOT_PATH}" fill="none"/></defs>`;

/* ---------- icons (spec 5.10) and status glyphs (5.9) ---------- */

const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  urgent: '<path d="M12 4L21 19H3Z"/><path d="M12 10v4"/><path d="M12 16.6v.01"/>',
  place: '<path d="M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10Z"/><circle cx="12" cy="11" r="2.2"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  talk: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  quiet: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>',
  sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4Z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a8 8 0 0 1 0 11"/>',
  package: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5Z"/><path d="M3.5 7.5L12 12l8.5-4.5"/><path d="M12 12v9"/>',
  chevron: '<path d="M14 6l-6 6 6 6"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M5.5 12a9 9 0 0 1 3-2"/><path d="M18.5 12a9 9 0 0 0-3.2-2.2"/><path d="M12 19v.01"/>',
  agent: '<path d="M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8Z"/>',
  daylight: '<path d="M3 18h18"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 6v3"/><path d="M5 10l2 2"/><path d="M19 10l-2 2"/>',
};
export const ICON_NAMES = Object.keys(ICON);
/** An icon (24 px grid, 2 px stroke, round caps and joins) inside an SVG at (x, y), drawn at `size` px. */
export function iconAt(name, x, y, size = 24, tone = 'ink', stroke = 2) {
  const s = Math.round((size / 24) * 1000) / 1000;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" style="stroke:${V(tone)}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</g>`;
}
/** A standalone inline icon (its own small SVG), for HTML rows. */
export function icon(name, size = 24, tone = 'ink') {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="stroke:${V(tone)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
}

const GLYPH = {
  working: ['ink', '<path class="spin" d="M12 3a9 9 0 1 1-9 9"/>'],
  waiting: ['peri', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6" class="fill"/>'],
  done: ['ink-2', '<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  failed: ['amber', '<path d="M12 2.5L21.5 12 12 21.5 2.5 12Z"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/>'],
  queued: ['ink-2', '<circle cx="12" cy="12" r="9" stroke-dasharray="3.5 3.5"/>'],
  connected: ['rose', '<circle cx="12" cy="12" r="7" class="fill"/>'],
  reconnecting: ['rose', '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" class="fill"/>'],
  offline: ['ink-2', '<circle cx="12" cy="12" r="9"/><path d="M5.6 18.4L18.4 5.6"/>'],
};
/** A status glyph (spec 5.9) as an inline SVG. */
export function glyph(state, size = 28, tone = null) {
  const g = GLYPH[state];
  if (!g) return '';
  const t = tone || g[0];
  return `<svg class="ico glyph g-${state}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="stroke:${V(t)};--gf:${V(t)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g[1]}</svg>`;
}
export const GLYPH_NAMES = Object.keys(GLYPH);

/* ---------- action capsule (spec 5.6), pills (5.7), rows (5.8) ---------- */

/** Segment widths that fit their labels: each label's width plus an equal share of the spare room. */
export function segWidths(labels, total = 296, size = 14) {
  const tw = labels.map((l) => measure(l, size, 600, 0.04));
  const spare = (total - tw.reduce((a, b) => a + b, 0)) / labels.length;
  if (spare < 8) return labels.map(() => total / labels.length);
  const w = tw.map((t) => Math.round(t + spare));
  w[w.length - 1] += total - w.reduce((a, b) => a + b, 0);
  return w;
}

/**
 * The action capsule. segs: [{ label, act, hold, data }], 1 to 3 (1 draws the single 220 x 56 pill unless `forceCapsule`).
 * tone: 'hair' (border) or 'peri' (the waiting-on-you capsule). state: { kind: 'rest' | 'sent' | 'waiting' | 'failed', label? }.
 * Every segment carries data-act and data-i so the app routes taps; hold segments carry data-hold.
 */
export function capsule({ top, segs, tone = 'hair', state = null, left = 85, width = 296, height = 60, id = 'cap', single = true, primaryTone = null }) {
  const list = (segs || []).slice(0, 3);
  if (!list.length) return '';
  const pTone = primaryTone || (tone === 'peri' ? 'peri' : 'rose');
  const pInk = pTone === 'peri' ? 'peri-ink' : 'rose-ink';
  if (list.length === 1 && single) {
    const s = list[0];
    return `<div class="capsule pillone ${state ? `st-${state.kind}` : ''}" data-capsule="${id}" style="left:${Math.round(233 - 110)}px;top:${top}px;width:220px;height:56px;--pf:${V(pTone)};--pi:${V(pInk)}">`
      + `<div class="seg primary" ${segAttrs(s, 0)} style="left:0;width:220px;height:56px">${esc(caps(s.label))}</div>${stateLayer(state)}</div>`;
  }
  const widths = segWidths(list.map((s) => caps(s.label)), width, 14);
  let x = 0;
  const inner = list.map((s, i) => {
    const w = widths[i];
    const h = `<div class="seg ${i === 0 && !s.ghost ? 'primary' : 'ghost'}" ${segAttrs(s, i)} style="left:${x}px;width:${w}px;height:${height}px${i ? `;box-shadow:inset 2px 0 0 ${V(tone)}` : ''}">${esc(caps(s.label))}</div>`;
    x += w;
    return h;
  }).join('');
  return `<div class="capsule ${state ? `st-${state.kind}` : ''}" data-capsule="${id}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;--edge:${V(tone)};--pf:${V(pTone)};--pi:${V(pInk)}">${inner}${stateLayer(state)}</div>`;
}
function segAttrs(s, i) {
  const d = Object.entries(s.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `data-act="${esc(s.act || 'seg')}" data-i="${i}"${s.hold ? ` data-hold="${esc(s.holdLabel || `HOLD TO ${caps(s.label)}`)}"` : ''}${d} role="button"`;
}
function stateLayer(state) {
  if (!state || state.kind === 'rest') return '<div class="wipe"></div><div class="holdlabel"></div>';
  const label = { sent: 'SENT ✓', waiting: 'WAITING', failed: '◆ TRY AGAIN', sending: 'SENDING' }[state.kind] || state.label || '';
  return `<div class="wipe"></div><div class="holdlabel"></div><div class="statelabel" ${state.kind === 'failed' ? 'data-act="retry" role="button"' : ''}>${esc(state.label || label)}</div>`;
}

/**
 * A pill button. kind: 'fill' (primary), 'ghost' (bordered). tone/ink: the fill or border colour and the text colour.
 */
export function pill({ left, top, width, height = 58, label, kind = 'ghost', tone = 'hair', ink = 'ink', size = 15, act = '', hold = null, data = {}, cls = '' }) {
  const d = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  const bg = kind === 'fill' ? V(tone) : 'transparent';
  return `<div class="pill ${kind} ${cls}" data-act="${esc(act)}"${hold ? ` data-hold="${esc(hold)}"` : ''}${d} role="button" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-radius:${height / 2}px;border:2px solid ${V(tone)};background:${bg};color:${V(ink)};font:600 ${size}px/1 'Lexend Exa',system-ui,sans-serif;letter-spacing:.04em;--pf:${V(tone)}"><span>${esc(caps(label))}</span><div class="wipe"></div></div>`;
}

/** A list row (spec 5.8): capsule, fill raise, 1.5 px line edge, glyph then name (caps) and detail. */
export function listRow({ left, top, width, height = 66, glyphSvg = '', name, detail, detailTone = 'ink-2', nameTone = 'ink', edge = null, act = '', data = {} }) {
  const d = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<div class="erow" data-act="${esc(act)}"${d} role="button" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-radius:${height / 2}px${edge ? `;box-shadow:inset 0 0 0 2px ${V(edge)}` : ''}">${glyphSvg}<div class="estack"><b style="color:${V(nameTone)}">${esc(name)}</b><span style="color:${V(detailTone)}">${esc(detail)}</span></div></div>`;
}

/** Pulsing three dots (Reconnecting, Waiting for your agent). */
export function pulseDots(cy, tone = 'ink-2') {
  return `<g style="fill:${V(tone)}"><circle class="d1" cx="215" cy="${cy}" r="4"/><circle class="d2" cx="233" cy="${cy}" r="4"/><circle class="d3" cx="251" cy="${cy}" r="4"/></g>`;
}

/* ---------- compose ---------- */

/**
 * One screen. vm: {
 *   ground: 'glass' | 'rose' | 'black', crescent (box left or null), rim ('dots' ...), rimExtra (svg), marks (svg), now (svg),
 *   svg (content svg: arcs, captions, shapes; walks with the content), html (content), cls, screen (name)
 * }
 */
export function compose(vm, walk = { x: 0, y: 0 }) {
  const g = vm.ground || 'glass';
  return `<div class="ph g-${g} ${vm.cls || ''}" data-screen="${esc(vm.screen || '')}">`
    + `<svg class="layer" viewBox="0 0 466 466" aria-hidden="true">${crescent(vm.crescent, g === 'rose')}${rim(vm.rim || 'dots')}${vm.rimExtra || ''}${vm.marks || ''}${vm.now || ''}</svg>`
    + `<div class="walk" style="transform:translate(${walk.x}px,${walk.y}px)"><svg class="layer" viewBox="0 0 466 466" aria-hidden="true">${CAPTION_DEFS}${vm.svg || ''}</svg>${vm.html || ''}</div>`
    + `</div>`;
}
