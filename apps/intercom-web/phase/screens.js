// Phase screens (spec 7): each function takes semantic props and returns a view model for prims.compose().
// Positions are panel px from the boards (screens/<board>/<id>.html); type and colour follow spec 3.
// Common props: crescent (shade box left), nowPt ({x, y} on r 214), moon (degrees or null), moonTone.
import { font, tx, caps, esc, V, marks as drawMarks, nowDot, progressArcs, caption, capsule, pill, listRow, glyph, icon, iconAt, pulseDots, rimDotsAt, measure } from './prims.js';
import { arcD, arcAround, drainDots, sliderArcs, pt } from './geom.js';

const LX = (w, s, lh, ls = 0) => font(w, s, lh, ls, 'lx');
const HK = (w, s, lh, italic = false) => font(w, s, lh, 0, 'hk', italic);
const clamp = (n) => `display:-webkit-box;-webkit-line-clamp:${n};-webkit-box-orient:vertical;overflow:hidden;`;
const balance = 'text-wrap:balance;';
const base = (p, extra = {}) => ({ ground: 'glass', crescent: p.crescent ?? null, rim: 'dots', now: nowDot(p.nowPt, p.moon ?? null, 'day', p.moonTone || null), ...extra });
const caps1 = (p, where, tone = 'ink', op = where === 'top' ? 0.85 : 1) => (p ? caption({ text: p, tone, op }, where) : '');

/* ---------- 7.1 Now ---------- */

/** Now face. p: label, numeral, unit, size ('xl' | 'l'), top, bottom, status {text, amber}, arcs {upper, lower}, marks, count, offline. */
export function nowFace(p) {
  const off = !!p.offline;
  const numF = p.size === 'l' ? LX(200, 100, 108, -0.02) : LX(200, 124, 124, -0.02);
  let svg = (off ? '' : progressArcs(p.arcs ? p.arcs.upper : null, p.arcs ? p.arcs.lower : null)) + caps1(p.top, 'top') + caps1(p.bottom, 'bottom');
  let html = '';
  if (p.count) {
    svg += `<circle cx="46" cy="233" r="16" fill="none" style="stroke:${V('hair')}" stroke-width="1.5"/>`;
    html += tx({ top: 224, left: 30, width: 32, f: LX(600, 15, 18), text: String(p.count), cls: 'tab' });
  }
  html += tx({ top: 124, f: LX(600, 16, 18, 0.16), color: 'rose', text: caps(p.label) });
  html += `<div class="t numrow" data-act="numeral" role="button" style="left:0;top:${p.size === 'l' ? 158 : 150}px;width:466px;height:124px"><span class="tab" style="${numF};color:${V('ink')}">${esc(p.numeral)}</span>${p.unit ? `<span style="${LX(600, 16, 18, 0.16)};color:${V('rose')}">${esc(p.unit)}</span>` : ''}</div>`;
  if (off) {
    html += tx({ top: 304, f: LX(600, 14, 16, 0.14), color: 'ink-2', text: 'RECONNECTING' });
    svg += pulseDots(344);
  } else if (p.status) html += tx({ top: 318, f: LX(600, 15, 18, 0.14), color: p.status.amber ? 'amber' : 'ink-2', text: caps(p.status.text) });
  return base(p, { screen: off ? 'offline' : 'now', rim: off ? 'dashed' : 'dots', marks: drawMarks(p.marks, { dim: off ? 0.55 : 1 }), svg, html });
}

/** Rose pills on the flood (spec 5.7): primary rose-ink fill / rose text, secondary 2 px rose-ink border. */
function floodPills(list, top, geo) {
  const [a, b] = geo;
  const l = (list || []).slice(0, 2);
  if (l.length === 1) return pill({ left: 233 - a.w / 2, top, width: a.w, label: l[0].label, kind: 'fill', tone: 'rose-ink', ink: 'rose', act: l[0].act, hold: l[0].hold || null, data: l[0].data || {} });
  return l.map((x, i) => pill({ left: geo[i].x, top, width: geo[i].w, label: x.label, kind: i ? 'ghost' : 'fill', tone: 'rose-ink', ink: i ? 'rose-ink' : 'rose', act: x.act, hold: x.hold || null, data: x.data || {} })).join('');
}
const floodRim = (lit) => rimDotsAt(drainDots(lit), 'rose-ink', 3.5, 0.8);

/** The alert face (Now, needs me now): LEAVE / NOW in Display, the sub line, two pills at y 290. */
export function nowAlert(p) {
  const svg = caps1(p.top, 'top', 'rose-ink', 1) + caps1(p.bottom, 'bottom', 'rose-ink', 1);
  let html = tx({ top: 96, f: LX(200, 72, 76, 0.02), color: 'rose-ink', html: (p.verdict || ['LEAVE', 'NOW']).map((s) => esc(caps(s))).join('<br>') });
  if (p.sub) html += tx({ top: 258, f: LX(600, 16, 18, 0.16), color: 'rose-ink', text: caps(p.sub) });
  html += floodPills(p.pills, 290, [{ x: 103, w: 124 }, { x: 239, w: 124 }]);
  return { screen: 'alert', ground: 'rose', crescent: p.crescent ?? null, rim: 'alert', rimExtra: floodRim(p.lit ?? 60), now: nowDot(p.nowPt, p.moon ?? null, 'rose'), svg, html, cls: 'flood' };
}

/* ---------- 7.2 Day and Event detail ---------- */

/** Day list. p: top, bottom, items [{kind: 'row', time, title, next, id} | {kind: 'note', text} | {kind: 'gap', text}], more, marks. */
export function dayList(p) {
  let y = 110, prev = null, html = '';
  const gapAfter = { row: { note: 18, gap: 14, row: 16 }, note: { row: 12, gap: 12 }, gap: { row: 10 } };
  for (const it of p.items || []) {
    if (prev) y += gapAfter[prev.kind][it.kind] ?? 12;
    if (it.kind === 'row') {
      const lines = it.lines || (measure(caps(it.title), 16, 600, 0.06) > 174 ? 2 : 1);
      const col = it.next ? `color:${V('rose')};` : '';
      html += `<div class="drow" data-act="dayrow" data-id="${esc(it.id || '')}" role="button" style="top:${y}px"><span class="tm" style="${col}">${esc(it.time)}</span><span class="tt" style="${col}${clamp(2)}">${esc(it.title)}</span></div>`;
      y += lines > 1 ? 44 : 32;
    } else if (it.kind === 'note') {
      html += tx({ top: y, left: 199, width: 174, align: 'left', f: LX(600, 14, 16, 0.06), color: 'amber', text: caps(it.text) });
      y += 16;
    } else {
      html += `<div class="t gaprow" style="left:93px;top:${y}px;width:280px;${LX(600, 14, 16, 0.1)};color:${V('ink-2')}"><span class="dl"></span>${esc(caps(it.text))}<span class="dl"></span></div>`;
      y += 16;
    }
    prev = it;
  }
  if (p.more) html += tx({ top: 328, f: LX(600, 14, 16, 0.14), color: 'ink-2', text: p.more });
  if (p.empty) html += tx({ top: 220, f: LX(600, 15, 18, 0.14), color: 'ink-2', text: 'NOTHING MORE TODAY' });
  const svg = caps1(p.top, 'top') + (p.bottom ? caption({ text: p.bottom, tone: 'ink-2', op: 1 }, 'bottom') : '');
  return base(p, { screen: 'day', marks: drawMarks(p.marks), svg, html });
}

const CHEVRONS = `<path d="M42 222L33 233L42 244" fill="none" style="stroke:${V('ink-2')}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M424 222L433 233L424 244" fill="none" style="stroke:${V('ink-2')}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const STEP_ZONES = '<div class="zone" data-act="prev" role="button" style="left:8px;top:173px;width:56px;height:120px"></div><div class="zone" data-act="next" role="button" style="left:402px;top:173px;width:56px;height:120px"></div>';

/** Event detail (and the sparse variant with no end time). p: top, title, range, sub, place, travel, conflict, note, sparse, actions, selected, marks, capState. */
export function eventDetail(p) {
  const segs = (p.actions || []).map((a, i) => ({ label: a.label, act: 'eact', hold: a.kind === 'hold' && !a.draft, data: { aid: a.id }, i }));
  let html = '', svg = CHEVRONS + (p.top ? caption({ text: p.top, tone: 'rose', op: 1 }, 'top') : '');
  if (p.sparse) {
    html += tx({ top: 96, left: 83, width: 300, f: LX(600, 17, 21, 0.06), style: `text-transform:uppercase;${clamp(3)}`, text: p.title });
    html += tx({ top: 176, f: LX(200, 64, 68, -0.02), color: 'rose', text: p.range });
    if (p.sub) html += tx({ top: 246, f: LX(600, 14, 16, 0.14), color: 'ink-2', text: caps(p.sub) });
    if (p.note) html += tx({ top: 272, left: 96, width: 274, f: HK(500, 17, 23), color: 'ink', style: balance + clamp(2), text: p.note });
    if (segs.length === 1) html += capsule({ top: 334, segs, state: p.capState });
    else if (segs.length) html += capsule({ top: 322, segs, state: p.capState });
  } else {
    html += tx({ top: 92, left: 83, width: 300, f: LX(600, 17, 21, 0.06), style: `text-transform:uppercase;${clamp(3)}`, text: p.title });
    html += tx({ top: 166, f: LX(200, 36, 40, -0.02), color: 'rose', text: p.range });
    if (p.sub) html += tx({ top: 208, f: LX(600, 14, 16, 0.14), color: 'ink-2', text: caps(p.sub) });
    let y = 238;
    const rows = [[p.place, 'ink', 0.08], [p.travel, 'ink-2', 0.08], [p.conflict, 'amber', 0.06]];
    for (const [t, c, ls] of rows) { if (!t) continue; html += tx({ top: y, f: LX(600, 14, 16, ls), color: c, style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 60px;box-sizing:border-box', text: caps(t) }); y += 22; }
    if (p.note && y <= 282) html += tx({ top: y + 2, left: 96, width: 274, f: HK(500, 15, 20), color: 'ink-2', style: clamp(y <= 238 ? 2 : 1), text: p.note });
    if (segs.length === 1) html += capsule({ top: 324, segs, state: p.capState });
    else if (segs.length) html += capsule({ top: 322, segs, state: p.capState });
  }
  html += STEP_ZONES;
  return base(p, { screen: 'detail', marks: drawMarks(p.marks, { selected: p.selected }), svg, html });
}

/** Stepping between Moments, frozen mid-swipe (board 02c): the outgoing card at 35%, the incoming one, the rail. */
export function stepping(p) {
  const card = (c, left, op) => `<div class="t stepcard" style="left:${left}px;top:130px;width:260px;${op < 1 ? `opacity:${op};` : ''}">`
    + `<div style="${LX(600, 14, 16, 0.14)};color:${V('rose')}">${esc(caps(c.label))}</div>`
    + `<div style="${LX(600, 17, 21, 0.06)};text-transform:uppercase;${clamp(3)}">${esc(c.title)}</div>`
    + `<div style="${LX(200, 36, 40)};color:${V('rose')}">${esc(c.time)}</div>`
    + (c.ampm ? `<div style="${LX(600, 14, 16, 0.14)};color:${V('ink-2')}">${esc(c.ampm)}</div>` : '') + '</div>';
  let html = card(p.out, p.outLeft ?? -60, 0.35) + card(p.in, p.inLeft ?? 220, 1);
  const n = p.rail ? p.rail.count : 0;
  if (n > 1) {
    html += `<div class="t rail" style="left:0;top:352px;width:466px">${Array.from({ length: n }, (_, i) => `<span class="${i === p.rail.index ? 'on' : ''}"></span>`).join('')}</div>`;
  }
  return base(p, { screen: 'stepping', marks: p.marksSvg || '', html });
}

/* ---------- 7.3 Alerts ---------- */

/** Urgent (board 03a/a): rose flood, triangle, struck-through old time, new time, detail, consequence, pills at y 312. */
export function urgent(p) {
  let html = '', y = 96;
  html += tx({ top: y, f: LX(600, 17, 20, 0.16), color: 'rose-ink', style: 'padding:0 70px;box-sizing:border-box', text: caps(p.title) });
  if (p.changed) {
    html += tx({ top: y + 26, f: LX(200, 30, 34), color: 'rose-ink', op: 0.78, style: 'text-decoration:line-through 2px', text: p.changed.old });
    html += tx({ top: y + 56, f: LX(200, 92, 96, -0.02), color: 'rose-ink', text: p.changed.new });
    y += 156;
  } else if (p.detail) {
    // No changed time: the detail sentence takes the empty band as a headline (a choice; the board always has a time here).
    html += tx({ top: 150, left: 83, width: 300, f: HK(600, 24, 30), color: 'rose-ink', style: balance + clamp(3), text: p.detail });
    y = 252;
    p = { ...p, detail: null };
  } else y += 26;
  if (p.detail) { html += tx({ top: y, f: LX(600, 14, 16, 0.08), color: 'rose-ink', style: `padding:0 56px;box-sizing:border-box;${clamp(2)}`, text: caps(p.detail) }); y += measure(caps(p.detail), 14, 600, 0.08) > 350 ? 38 : 22; }
  if (p.consequence) html += tx({ top: y, f: LX(700, 14, 16, 0.06), color: 'rose-ink', style: 'padding:0 70px;box-sizing:border-box', text: caps(p.consequence) });
  html += floodPills(p.pills, 312, [{ x: 97, w: 134 }, { x: 241, w: 128 }]);
  const svg = iconAt('urgent', 219, 58, 28, 'rose-ink', 2) + caps1(p.top, 'top', 'rose-ink', 1);
  return { screen: 'urgent', ground: 'rose', crescent: p.crescent ?? null, rim: 'alert', rimExtra: floodRim(p.lit ?? 60), now: nowDot(p.nowPt, p.moon ?? null, 'rose'), svg, html, cls: 'flood' };
}

/** Peri pills (decision): REVIEW filled peri / LATER bordered; three actions use the capsule instead. */
function periActions(list, top) {
  const l = list || [];
  if (l.length >= 3) return capsule({ top, segs: l, tone: 'peri', single: false });
  if (l.length === 1) return pill({ left: 166, top, width: 134, label: l[0].label, kind: 'fill', tone: 'peri', ink: 'peri-ink', act: l[0].act, hold: l[0].hold || null, data: l[0].data || {} });
  return l.map((x, i) => pill({ left: i ? 241 : 97, top, width: i ? 128 : 134, label: x.label, kind: i ? 'ghost' : 'fill', tone: 'peri', ink: i ? 'ink' : 'peri-ink', act: x.act, hold: x.hold || null, data: x.data || {} })).join('');
}
const WAIT_GLYPH = `<circle cx="233" cy="78" r="12" fill="none" style="stroke:${V('peri')}" stroke-width="2.5"/><circle cx="233" cy="78" r="3.5" style="fill:${V('peri')}"/>`;

/** Decision (board 03a/b). p: who, headline, preview, meta, actions [{label, act}], window {a1, a2} (the open window on the rim), top. */
export function decision(p) {
  let html = tx({ top: 100, f: LX(600, 14, 16, 0.16), color: 'peri', style: 'padding:0 76px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: caps(p.who) });
  html += tx({ top: 124, left: 83, width: 300, f: LX(600, 21, 26, 0.06), style: `text-transform:uppercase;${clamp(2)}`, text: p.headline });
  if (p.preview) html += tx({ top: 186, left: 83, width: 300, f: HK(500, 19, 25), color: 'ink', style: balance + clamp(3), text: p.quote === false ? p.preview : `“${p.preview}”` });
  if (p.meta) html += tx({ top: 268, f: LX(600, 13, 16, 0.1), color: 'ink-2', text: caps(p.meta) });
  html += periActions(p.actions, 312);
  const rimExtra = p.window ? `<path d="${arcD(p.window.a1, p.window.a2, 197)}" fill="none" style="stroke:${V('peri')}" stroke-width="4" stroke-linecap="round"/>` : '';
  return base({ ...p, moonTone: 'peri' }, { screen: 'decision', rimExtra, svg: WAIT_GLYPH + caps1(p.top, 'top'), html });
}

/**
 * Confirm what is sent (board 03a/c). p: to, text (exact), hold (0-1 for a frozen reference), left/right pills [{label, act, hold}].
 * The hold target is a disc r 50 with a 3 px ring that fills rose clockwise over 0.8 s.
 */
export function confirm(p) {
  const C = 2 * Math.PI * 48;
  const fill = p.hold ? `<path d="${arcAround(233, 300, 0, 360 * p.hold, 48)}" fill="none" style="stroke:${V('rose')}" stroke-width="4" stroke-linecap="round"/>` : '';
  const svg = caption({ text: p.top || 'Sends exactly this', tone: 'rose', op: 1 }, 'top')
    + `<circle cx="233" cy="300" r="50" style="fill:${V('raise')}"/><circle cx="233" cy="300" r="48" fill="none" style="stroke:${V('hair')}" stroke-width="3"/>${fill}`
    + `<circle class="holdring" cx="233" cy="300" r="48" fill="none" style="stroke:${V('rose')};--c:${C.toFixed(1)}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}" transform="rotate(-90 233 300)"/>`;
  let html = tx({ top: 92, f: LX(600, 14, 16, 0.12), color: 'ink-2', text: caps(p.to || '') });
  html += `<div class="t cscroll" data-scroller="1" style="left:83px;top:116px;width:300px;height:146px;${HK(500, 18, 24)};color:${V('ink')};text-align:center;${balance}">${esc(p.text)}</div>`;
  html += `<div class="holdtarget" data-act="${esc(p.holdAct || 'csend')}" data-hold="HOLD TO SEND" data-ring="1" role="button" style="left:183px;top:250px;width:100px;height:100px"></div>`;
  html += tx({ top: 278, left: 183, width: 100, f: LX(600, 13, 16, 0.06), html: 'HOLD<br>TO SEND', style: 'pointer-events:none' });
  const ghost = (x, s) => (s ? pill({ left: x, top: 272, width: 74, height: 56, label: s.label, kind: 'ghost', tone: 'hair', ink: 'ink', size: 13, act: s.act, hold: s.hold || null }) : '');
  html += ghost(72, p.left) + ghost(320, p.right);
  if (p.state) html += tx({ top: 358, f: LX(600, 13, 16, 0.14), color: p.state === 'failed' ? 'amber' : 'ink-2', text: { sending: 'SENDING', waiting: 'WAITING', failed: '◆ TRY AGAIN', sent: 'SENT ✓' }[p.state] || '' });
  return base(p, { screen: 'confirm', svg, html });
}

/** Inform (board 03b/a): icon, title, detail, a thin ink arc that drains over 20 s, CLEARS IN N S, GOT IT. */
export function inform(p) {
  const svg = progressArcs(p.remaining ?? 1, null, 'ink') + iconAt(p.icon || 'agent', 213, 108, 40, 'ink', 1.5) + caps1(p.top, 'top');
  let html = tx({ top: 168, f: LX(600, 17, 20, 0.1), style: 'padding:0 60px;box-sizing:border-box', text: caps(p.title) });
  if (p.detail) html += tx({ top: 198, f: LX(600, 14, 16, 0.08), color: 'ink-2', style: `padding:0 70px;box-sizing:border-box;${clamp(2)}`, text: caps(p.detail) });
  html += tx({ top: 262, f: LX(600, 14, 16, 0.14), color: 'ink-2', cls: 'tab', text: `CLEARS IN ${p.clears ?? 20} S` });
  html += pill({ left: 151, top: 300, width: 164, label: p.ack || 'GOT IT', kind: 'ghost', tone: 'hair', ink: 'ink', act: 'gotit' });
  return base(p, { screen: 'inform', svg, html });
}

/** Sent (board 03b/b): check in a rose ring, SENT, the words, BACK TO NOW IN 5 S, three-beat dots. */
export function sent(p) {
  const beats = p.beats ?? 2;
  let svg = `<circle cx="233" cy="146" r="44" fill="none" style="stroke:${V('rose')}" stroke-width="3.5"/><path d="M212 147L226 161L254 131" fill="none" style="stroke:${V('rose')}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  [205, 233, 261].forEach((x, i) => { svg += i < beats ? `<circle cx="${x}" cy="372" r="4" style="fill:${V('rose')}"/>` : `<circle cx="${x}" cy="372" r="4" fill="none" style="stroke:${V('rose')}" stroke-width="1.5"/>`; });
  let html = tx({ top: 214, f: LX(600, 22, 26, 0.2), text: p.word || 'SENT' });
  if (p.words) html += tx({ top: 256, left: 93, width: 280, f: HK(500, 20, 26), style: balance + clamp(2), text: p.words });
  html += tx({ top: 324, f: LX(600, 14, 16, 0.14), color: 'ink-2', cls: 'tab', text: `BACK TO NOW IN ${p.back ?? 5} S` });
  return base(p, { screen: 'sent', svg, html });
}

/** Earlier tray (board 03b/c). p: rows [{glyph: svg, name, detail, open, id}], canClear. */
export function earlier(p) {
  const geo = [{ x: 100, w: 266 }, { x: 90, w: 286 }, { x: 90, w: 286 }];
  let html = '';
  (p.rows || []).slice(0, 3).forEach((r, i) => {
    html += listRow({ left: geo[i].x, top: 96 + i * 70, width: geo[i].w, glyphSvg: r.glyph, name: r.name, detail: r.detail, detailTone: r.open ? 'peri' : 'ink-2', edge: r.open ? 'peri' : null, act: 'erow', data: { id: r.id } });
  });
  if (!(p.rows || []).length) html += tx({ top: 200, f: LX(600, 15, 18, 0.14), color: 'ink-2', text: 'NOTHING EARLIER' });
  if (p.more) html += tx({ top: 304, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: p.more });
  if (p.canClear !== false && (p.rows || []).length) html += pill({ left: 138, top: 318, width: 190, height: 56, label: 'HOLD TO CLEAR', kind: 'ghost', tone: 'hair', ink: 'ink', size: 13, act: 'eclear', hold: 'HOLD TO CLEAR' });
  return base(p, { screen: 'earlier', svg: caps1(p.top || 'Earlier', 'top'), html });
}

/* ---------- 7.4 Agents ---------- */

export function agentsNone(p) {
  const svg = `<circle cx="233" cy="164" r="58" fill="none" style="stroke:${V('hair')}" stroke-opacity=".6" stroke-width="1.5"/><circle cx="233" cy="164" r="38" fill="none" style="stroke:${V('hair')}" stroke-width="2"/><circle cx="233" cy="164" r="7" style="fill:${V('rose')}"/>` + caps1(p.top || 'All quiet', 'top');
  let html = tx({ top: 250, f: LX(600, 17, 20, 0.1), text: 'NOTHING RUNNING' });
  if (p.last) html += tx({ top: 282, f: LX(600, 14, 16, 0.06), color: 'ink-2', style: 'padding:0 60px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: caps(p.last) });
  html += tx({ top: 324, left: 103, width: 260, f: HK(500, 18, 24), color: 'ink', style: balance, text: p.hint || 'Hold the side button and ask' });
  return base(p, { screen: 'agents', svg, html });
}
const JOB_TONE = { failed: 'amber', done: 'ink-2' };
/** Several running (board 04b). p: top, rows [{state, name, detail, id}], more. */
export function agentsList(p) {
  const geo = [{ x: 104, w: 258 }, { x: 88, w: 290 }, { x: 92, w: 282 }];
  let html = '';
  (p.rows || []).slice(0, 3).forEach((r, i) => {
    html += listRow({ left: geo[i].x, top: 90 + i * 74, width: geo[i].w, glyphSvg: glyph(r.state, 28), name: r.name, detail: r.detail, detailTone: r.state === 'failed' ? 'amber' : r.state === 'waiting' ? 'peri' : 'ink-2', nameTone: r.state === 'done' ? 'ink-2' : 'ink', act: 'job', data: { id: r.id } });
  });
  if (p.more) html += tx({ top: 322, f: LX(600, 14, 16, 0.14), color: 'ink-2', text: p.more });
  return base(p, { screen: 'agents', svg: caps1(p.top, 'top'), html });
}
export { JOB_TONE };

/** One waiting on me (board 04c). p: who, question, asked, running, options [{label, act, data}] (the capsule). */
export function agentWaiting(p) {
  let html = tx({ top: 100, f: LX(600, 14, 16, 0.14), color: 'peri', style: 'padding:0 76px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: caps(p.who) });
  html += tx({ top: 130, left: 83, width: 300, f: HK(600, 26, 32), style: balance + clamp(2), text: p.question });
  html += tx({ top: 226, f: LX(600, 13, 18, 0.1), color: 'ink-2', html: [p.asked, p.running].filter(Boolean).map((s) => esc(caps(s))).join('<br>') });
  html += capsule({ top: 318, segs: p.options, tone: 'peri', single: false, state: p.capState });
  return base({ ...p, moonTone: 'peri' }, { screen: 'waiting', svg: WAIT_GLYPH + caps1(p.top, 'top'), html });
}

/* ---------- 7.5 Thread and push-to-talk ---------- */

/** Reading a thread (board 05a). p: top ("Atlas · 2:41"), text, buttons [{label, act, data}], thumb {top, h}. */
export function thread(p) {
  const th = p.thumb || { top: 148, h: 46 };
  let svg = caption({ text: p.top, tone: 'rose', op: 1 }, 'top');
  if (p.scrollable !== false) svg += `<rect x="406" y="140" width="4" height="120" rx="2" style="fill:${V('hair')}" fill-opacity=".45"/><rect class="thumb" x="406" y="${th.top}" width="4" height="${th.h}" rx="2" style="fill:${V('ink')}"/>`;
  let html = `<div class="t tscroll" data-scroller="1" style="left:90px;top:92px;width:290px;height:206px;${HK(500, 20, 27)};color:${V('ink')};text-align:left"><div style="padding:8px 0 20px">${p.textHtml || esc(p.text || '')}</div></div>`;
  if (p.empty) html += tx({ top: 200, f: LX(600, 15, 18, 0.14), color: 'ink-2', text: p.empty });
  if ((p.buttons || []).length) html += capsule({ top: 322, segs: p.buttons, single: false, state: p.capState });
  return base(p, { screen: 'thread', svg, html });
}

/** Listening (board 05b). p: transcript, elapsed, placeholder. The rim tab is an 8 px peri arc from 2:30 to 3:30. */
export function listening(p) {
  const svg = `<circle class="br" cx="233" cy="150" r="66" fill="none" style="stroke:${V('peri')}" stroke-opacity=".3" stroke-width="2"/><circle class="br" cx="233" cy="150" r="52" fill="none" style="stroke:${V('peri')}" stroke-opacity=".6" stroke-width="2"/><circle cx="233" cy="150" r="36" style="fill:${V('peri')}"/><g style="stroke:${V('peri-ink')}" stroke-width="3.5" stroke-linecap="round"><path d="M233 134v32"/><path d="M221 141v18"/><path d="M245 141v18"/></g>`;
  let html = tx({ top: 228, f: LX(600, 14, 16, 0.2), color: 'peri', text: 'LISTENING' });
  html += tx({ top: 258, left: 83, width: 300, f: HK(600, 22, 29), color: p.transcript ? 'ink' : 'ink-2', style: balance + clamp(2), text: p.transcript || p.placeholder || '' });
  html += tx({ top: 330, f: LX(200, 28, 32), cls: 'tab', text: p.elapsed || '0:00' });
  html += tx({ top: 366, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: p.release || 'RELEASE TO SEND' });
  const rimExtra = `<path d="${arcD(75, 105, 214)}" fill="none" style="stroke:${V('peri')}" stroke-width="8" stroke-linecap="round"/>`;
  return base(p, { screen: 'listening', rimExtra, svg, html });
}

/** Understood, then answered (board 05c). The check sits left of UNDERSTOOD with an 8 px gap. p: heard, agent, answer, buttons, status. */
export function understood(p) {
  const word = p.status || 'UNDERSTOOD';
  const check = p.ok !== false ? `<svg width="17" height="14" viewBox="192 90 19 16" aria-hidden="true"><path d="M193 98l6 6 11-12" fill="none" style="stroke:${V('ink-2')}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>` : '';
  let html = `<div class="t" style="left:0;top:94px;width:466px;display:flex;justify-content:center;align-items:center;gap:8px;${LX(600, 14, 16, 0.2)};color:${V(p.statusTone || 'ink-2')}">${check}<span>${esc(word)}</span></div>`;
  html += tx({ top: 122, left: 93, width: 280, f: HK(500, 19, 25, true), color: 'ink-2', style: clamp(2), text: `“${p.heard || ''}”` });
  html += `<div class="t" style="left:0;top:190px;width:466px;display:flex;justify-content:center;align-items:center;gap:12px;${LX(600, 14, 20, 0.2)};color:${V('rose')}">${icon('sound', 24, 'rose')}<span>${esc(caps(p.agent || ''))}</span></div>`;
  if (p.answer) html += tx({ top: 218, left: 83, width: 300, f: HK(600, 23, 30), style: balance + clamp(3), text: p.answer });
  else if (p.pending) html += `<svg class="layer" viewBox="0 0 466 466" aria-hidden="true">${pulseDots(250)}</svg>`;
  if ((p.buttons || []).length) html += capsule({ top: 322, segs: p.buttons });
  const svg = `<path d="M178 176h110" style="stroke:${V('hair')}" stroke-opacity=".7" stroke-width="1.5"/>`;
  return base(p, { screen: 'understood', svg, html });
}

/* ---------- 7.6 Capture (true black, no rim, no now dot, no crescent: spec 5.2, 5.3, 7.6) ---------- */

export function recording(p) {
  const rimExtra = `<circle class="br4" cx="233" cy="233" r="224" fill="none" style="stroke:${V('rec')}" stroke-width="16"/>`;
  const svg = `<circle cx="203" cy="108" r="7" style="fill:${V('rec')}"/>`;
  let html = tx({ top: 98, f: LX(700, 20, 22, 0.2), color: 'rec', style: 'padding-left:44px;box-sizing:border-box', text: 'REC' });
  html += tx({ top: 132, f: LX(200, 96, 100, -0.02), cls: 'tab', text: p.elapsed });
  html += tx({ top: 244, f: LX(600, 16, 18, 0.14), text: caps(p.title || 'Conversation') });
  html += tx({ top: 270, f: LX(600, 13, 16, 0.08), color: 'ink-2', text: caps(p.sub) });
  html += pill({ left: 123, top: 312, width: 220, height: 60, label: 'HOLD TO STOP', kind: 'ghost', tone: 'rec', ink: 'rec', act: 'capstop', hold: 'HOLD TO STOP' });
  if (p.alert) html += tx({ top: 384, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: p.alert });
  return { screen: 'recording', ground: 'black', crescent: null, rim: 'none', rimExtra, now: '', svg, html };
}
export function hourIn(p) {
  const rimExtra = `<circle class="bs" cx="233" cy="233" r="226" fill="none" style="stroke:${V('rec')}" stroke-width="5"/><g class="nt" style="transform-origin:233px 233px${p.notch !== undefined ? `;transform:rotate(${p.notch}deg)` : ''}"><path d="M233 7A226 226 0 0 1 292 15" fill="none" style="stroke:${V('rec')}" stroke-width="9" stroke-linecap="round"/></g>`;
  const svg = `<circle cx="213" cy="112" r="5" style="fill:${V('rec')}"/>`;
  let html = tx({ top: 102, f: LX(700, 16, 18, 0.2), color: 'rec', style: 'padding-left:36px;box-sizing:border-box', text: 'REC' });
  html += tx({ top: 140, f: LX(200, 52, 56, -0.02), cls: 'tab', style: 'padding-left:4px;box-sizing:border-box', text: p.elapsed });
  html += tx({ top: 212, f: LX(600, 15, 18, 0.14), color: 'ink-2', text: caps(p.title || 'Conversation') });
  html += tx({ top: 312, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: 'TOUCH TO WAKE' });
  if (p.alert) html += tx({ top: 340, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: p.alert });
  return { screen: 'hourin', ground: 'black', crescent: null, rim: 'none', rimExtra, now: '', svg, html, cls: 'touchwake' };
}
export function saved(p) {
  const prog = p.progress ?? 1;
  const rimExtra = prog >= 1 ? `<circle cx="233" cy="233" r="224" fill="none" style="stroke:${V('ink')}" stroke-width="8"/>` : prog > 0 ? `<path d="${arcD(0, 360 * prog, 224)}" fill="none" style="stroke:${V('ink')}" stroke-width="8"/>` : '';
  const svg = `<circle cx="233" cy="130" r="40" fill="none" style="stroke:${V('rose')}" stroke-width="3.5"/><path d="M214 131L227 144L252 116" fill="none" style="stroke:${V('rose')}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  let html = tx({ top: 190, f: LX(600, 22, 26, 0.2), style: 'padding-left:4px;box-sizing:border-box', text: 'SAVED' });
  html += tx({ top: 226, f: LX(200, 40, 44), color: 'rose', text: p.length });
  html += tx({ top: 284, left: 93, width: 280, f: HK(500, 19, 26), color: 'ink', style: balance + clamp(3), text: p.note });
  html += tx({ top: 358, f: LX(600, 13, 16, 0.14), color: 'ink-2', cls: 'tab', text: `BACK TO NOW IN ${p.back ?? 5} S` });
  return { screen: 'saved', ground: 'black', crescent: null, rim: 'none', rimExtra, now: '', svg, html };
}

/* ---------- 7.7 Rest, quiet hours, offline ---------- */

export function resting(p) {
  let html = tx({ top: 150, f: LX(200, 100, 108, -0.02), color: 'night', cls: 'tab', text: p.clock });
  if (p.until) html += tx({ top: 276, f: LX(600, 15, 18, 0.14), color: 'night', text: caps(p.until) });
  return { screen: 'rest', ground: 'black', crescent: null, rim: 'none', now: '', svg: '', html, cls: 'night' };
}
export function woken(p) {
  let html = '';
  if (p.label) html += tx({ top: 98, f: LX(600, 14, 16, 0.16), color: 'night', text: caps(p.label) });
  html += `<div class="t numrow" style="left:0;top:122px;width:466px;color:${V('night')}"><span class="tab" style="${LX(200, 100, 108, -0.02)}">${esc(p.time)}</span>${p.unit ? `<span style="${LX(600, 16, 18, 0.16)}">${esc(p.unit)}</span>` : ''}</div>`;
  if (p.title) html += tx({ top: 246, f: LX(600, 17, 20, 0.1), color: 'night', style: 'padding:0 60px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: caps(p.title) });
  html += pill({ left: 103, top: 298, width: 260, label: 'END QUIET HOURS', kind: 'ghost', tone: 'night', ink: 'night', act: 'endquiet' });
  html += tx({ top: 372, f: LX(600, 13, 16, 0.14), color: 'night', cls: 'tab', text: `DIMS AGAIN IN ${p.dims ?? 20} S` });
  return { screen: 'woken', ground: 'black', crescent: null, rim: 'night', now: nowDot(p.nowPt, p.moon ?? null, 'night'), svg: '', html, cls: 'night' };
}

/* ---------- 7.8 Pairing and Settings ---------- */

/** Pairing (board 08a). p: label, code [line1, line2], expires, waiting, cancel, lit (rose life dots). */
export function pairing(p) {
  const rimExtra = p.lit ? rimDotsAt(drainDots(p.lit), 'rose', 3) : '';
  const svg = caps1(p.top || 'Pair with your agent', 'top') + (p.waiting ? pulseDots(332) : '');
  let html = tx({ top: 92, f: LX(600, 14, 16, 0.16), color: 'rose', text: caps(p.label || 'TELL IT THIS CODE') });
  html += tx({ top: 114, f: LX(200, 72, 76, 0.06), cls: 'tab', html: (p.code || []).map((s) => esc(s)).join('<br>') });
  if (p.expires) html += tx({ top: 276, f: LX(600, 14, 16, 0.14), color: 'ink-2', cls: 'tab', text: caps(p.expires) });
  if (p.waiting) html += tx({ top: 300, f: LX(600, 14, 16, 0.08), text: caps(p.waiting) });
  if (p.cancel) html += tx({ top: 350, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: caps(p.cancel) });
  return { screen: 'pairing', ground: 'glass', crescent: p.crescent ?? null, rim: 'faint', rimExtra, now: '', svg, html };
}
export function connected(p) {
  const svg = `<circle cx="233" cy="90" r="9" style="fill:${V(p.dot || 'rose')}"/>`;
  let html = tx({ top: 108, f: LX(600, 14, 16, 0.2), color: 'rose', text: caps(p.state || 'CONNECTED') });
  html += tx({ top: 132, f: LX(200, 68, 72, -0.01), style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 50px;box-sizing:border-box', text: caps(p.agent) });
  if (p.account) html += tx({ top: 218, f: LX(600, 14, 16, 0.1), color: 'ink', text: caps(p.account) });
  if (p.line) html += tx({ top: 244, left: 73, width: 320, f: HK(500, 17, 23), color: 'ink-2', text: p.line });
  html += pill({ left: 93, top: 300, width: 280, label: 'HOLD TO DISCONNECT', kind: 'ghost', tone: 'hair', ink: 'ink', size: 14, act: 'disconnect', hold: 'HOLD TO DISCONNECT' });
  return base(p, { screen: 'connected', svg, html });
}
const srow = (top, label, value, act, extra = '') => `<div class="srow" data-act="${act}" role="button" style="top:${top}px${extra}"><b>${esc(label)}</b><i>${esc(value)}</i></div>`;
/** Settings (board 08c): brightness and volume sliders on the rim, three rows, SWIPE UP TO CLOSE. */
export function settings(p) {
  const L = sliderArcs('left', p.brightness ?? 0.7), Rr = sliderArcs('right', p.volume ?? 0.55);
  const sl = (s) => `<path d="${s.track}" fill="none" style="stroke:${V('hair')}" stroke-opacity=".6" stroke-width="10" stroke-linecap="round"/>${s.fill ? `<path d="${s.fill}" fill="none" style="stroke:${V('rose')}" stroke-width="10" stroke-linecap="round"/>` : ''}<circle cx="${s.knob.x.toFixed(1)}" cy="${s.knob.y.toFixed(1)}" r="10" style="fill:${V('ink')}"/>`;
  const rimExtra = sl(L) + sl(Rr);
  const svg = iconAt('light', 78, 346, 24, 'ink-2') + iconAt('sound', 366, 346, 24, 'ink-2');
  let html = srow(94, 'Quiet hours', p.quiet, 'squiet') + srow(160, 'Daylight', p.daylight, 'sdaylight') + srow(226, 'Agent', p.agent, 'sagent');
  html += tx({ top: 316, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: p.hint || 'SWIPE UP TO CLOSE' });
  return { screen: 'settings', ground: 'glass', crescent: p.crescent ?? null, rim: 'none', rimExtra, now: '', svg, html };
}
/** The Daylight city picker: "Use phone location" first, then a short city list. Rows scroll inside the circle. */
export function cityPicker(p) {
  const rows = (p.rows || []).map((r, i) => `<div class="srow inlist${r.on ? ' on' : ''}" data-act="city" data-i="${i}" role="button"><b>${esc(r.label)}</b><i>${esc(r.value || '')}</i></div>`).join('');
  let html = `<div class="t cityscroll" data-scroller="1" style="left:98px;top:84px;width:270px;height:262px">${rows}</div>`;
  html += tx({ top: 360, f: LX(600, 13, 16, 0.14), color: p.note ? 'ink' : 'ink-2', text: caps(p.note || 'SWIPE UP TO GO BACK') });
  return { screen: 'cities', ground: 'glass', crescent: p.crescent ?? null, rim: 'none', now: '', svg: caps1('Daylight', 'top'), html };
}
/** The power menu stub (power held 3 s). */
export function powerMenu(p) {
  let html = srow(126, 'Power', 'SLEEP', 'psleep') + srow(192, 'Page', 'RELOAD', 'preload') + srow(258, 'Back', 'CANCEL', 'pcancel');
  html += tx({ top: 340, f: LX(600, 13, 16, 0.14), color: 'ink-2', text: 'PROTOTYPE MENU' });
  return { screen: 'power', ground: 'glass', crescent: p.crescent ?? null, rim: 'faint', now: '', svg: caps1('Power', 'top'), html };
}
export { pt };
