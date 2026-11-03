// HTML for each dial screen. All inner content is laid out in the 466 design square.
// Readability: text >= 26px, primary >= 34px, clock >= 110px, buttons >= 72px, <= 4 buttons,
// nothing inside the outer 30px.
import { escapeHtml as e, clockText, dateText, shortTime, allDayLine, glanceOf, needsLayout, isAckLabel, needsMore, tzParts } from './logic.js';
import { dayRingSvg, workingRingSvg, waveRingSvg, statusRingSvg } from './dial.js';
import { ringModel, nextUp, primaryView, contextView, scrubInfo, colorValue, calendarLanes } from './dayv2.js';
import { createStore } from './surface.js';
import { statusModel, bubbleSide } from './statusv2.js';

export const SCREENS = ['idle', 'listening', 'working', 'reply', 'choice', 'needs', 'draft', 'done', 'quiet', 'status', 'event', 'approval', 'carousel', 'convo'];

const btn = (label, cls = '') => `<div class="btn ${cls}">${e(label)}</div>`;

const NO_BTN = () => ({ state: 'idle', label: null, disabled: false });
const BTN_STYLE = { primary: 'ok', destructive: 'danger', success: 'ok', danger: 'danger' };

/** A tappable action button; `bs` is its local state (Sending, Sent, Failed, Expired). `data` are data-* attributes. */
function actionBtn(action, bs, data, extra = '') {
  const st = bs || NO_BTN();
  const cls = `${BTN_STYLE[action.style] ?? ''} ${st.state !== 'idle' ? `st-${st.state}` : ''} ${st.disabled ? 'off' : ''}`.trim();
  return `<div class="btn ${cls}" ${data}${extra}>${e(st.label || action.label)}</div>`;
}

function widgetCell(w) {
  const col = w.color ? ` style="color:${e(w.color)}"` : '';
  if (w.kind === 'gauge') {
    const c = 2 * Math.PI * 15;
    const ring = `<svg class="wg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="none" stroke="#2c2924" stroke-width="5"/><circle cx="20" cy="20" r="15" fill="none" stroke="${e(w.color || '#ffb347')}" stroke-width="5" stroke-dasharray="${(c * w.frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`;
    return `<div class="wcell">${ring}<div class="wv">${e(w.text)}</div>${w.label ? `<div class="wl">${e(w.label)}</div>` : ''}</div>`;
  }
  if (w.kind === 'icon') return `<div class="wcell"><div class="wi"${col}>${e(w.icon)}</div><div class="wv">${e(w.text || w.label)}</div></div>`;
  if (w.kind === 'countdown') return `<div class="wcell"><div class="wi"${col}>${e(w.text)}</div><div class="wv">${e(w.label)}</div></div>`;
  if (w.kind === 'spark') {
    const pts = w.points.map((p, i) => `${((i * 80) / (w.points.length - 1)).toFixed(1)},${(26 - p * 24).toFixed(1)}`).join(' ');
    return `<div class="wcell"><svg class="ws" viewBox="0 0 80 28"><polyline points="${pts}" fill="none" stroke="${e(w.color || '#5fc0b3')}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg><div class="wv">${e(w.label || w.text)}</div></div>`;
  }
  return `<div class="wcell"><div class="wi"${col}>${e(w.text)}</div>${w.label ? `<div class="wv">${e(w.label)}</div>` : ''}</div>`;
}

function contextHtml(items, now, tz) {
  return items.map((it) => {
    if (it.kind === 'leave') {
      const d = it.departure;
      return `<div class="sec datey leavey ${d.dim ? 'dim' : d.pressure}">${e(d.text)}</div>`;
    }
    if (it.kind === 'line') return `<div class="sec ctxline">${e(it.text)}</div>`;
    if (it.kind === 'widgets') return `<div class="wrow">${it.list.map(widgetCell).join('')}</div>`;
    return `<div class="sec datey">${e(dateText(now, tz))}</div>`;
  }).join('');
}

/**
 * Day Dial v2. Calendar events are the base layer; `surfaceEvents` (and the primary and context slots in `store`) overlay them.
 * `scrub` ({hours}) puts the centre on that time of day. `btn(object, actionId)` gives a button's local state.
 */
export function idle({ events, now, tz, calendarKnown = true, notes = 0, halo = false, departure = null, surfaceEvents = [], store = createStore(), layout = {}, scrub = null, btn = NO_BTN, v2 = false }) {
  const lay = { ring: layout.ring !== false, primary: layout.primary !== false, context: layout.context || null };
  const { timed, allDay } = calendarLanes(events, now, tz);
  const model = lay.ring ? ringModel(surfaceEvents, now, tz) : { segs: [], ticks: [], nowH: tzParts(now, tz).hours };
  const nowH = model.nowH;
  const nowMs = now.getTime();
  const ad = allDayLine(allDay);
  const ring = dayRingSvg(events, now, tz, halo, departure ? departure.pressure : null, { model, scrub });
  if (scrub) {
    const info = scrubInfo(scrub.hours, model, timed);
    return `${ring}<div class="clock">${e(info.time)}</div><div class="scrubt"${info.color ? ` style="color:${e(info.color)}"` : ''}>${e(info.title)}</div>`;
  }
  const ctx = contextHtml(contextView(store, { departure, layout: lay, nowMs }), now, tz);
  const noteHtml = notes ? `<div class="sec notey" data-act="note"><span class="ndot"></span>${notes} ${notes === 1 ? 'note' : 'notes'}</div>` : '';
  const pv = lay.primary ? primaryView(store, nextUp(timed, model, nowH), nowMs) : null;
  let nextHtml = '';
  if (pv) {
    const col = pv.color ? ` style="color:${e(pv.color)}"` : '';
    nextHtml = `<div class="next"${col}>${e(pv.text)}</div>`;
    if (pv.action) nextHtml += actionBtn(pv.action, btn('slots:primary', pv.action.id), 'data-act="slotaction"', ` data-aid="${e(pv.action.id)}"`).replace('class="btn ', 'class="btn pbtn ');
  } else if (lay.primary && !v2) nextHtml = `<div class="sec dim-line">${calendarKnown ? 'Clear for today' : 'Diary unavailable'}</div>`;
  const trainHtml = departure && departure.train ? `<div class="trainline${departure.train.delayed ? ' delayed' : ''}">${e(departure.train.text)}</div>` : '';
  return `${ring}${ctx}${noteHtml}
    ${ad ? `<div class="sec allday">${e(ad)}</div>` : ''}
    <div class="clock">${e(clockText(now, tz))}</div>${nextHtml}${trainHtml}`;
}

export function listening({ transcript = '' }) {
  return `${waveRingSvg()}<div class="label">Listening</div>
    <div class="peggy" style="font-size:42px;margin:20px 0 22px;max-width:330px">${e(transcript ? `“${transcript}”` : '')}</div>
    <div class="sec">Let go to send</div>`;
}

export function working({ status }) {
  return `${workingRingSvg()}<div class="label">Peggy is</div><div class="big" style="margin-top:16px">${e(status || 'Working')}</div>`;
}

export function reply({ reply: r, expanded }) {
  if (expanded) {
    return `<div class="scroller" data-scroller><div class="label" style="margin-bottom:14px">Peggy</div>` +
      `<div class="peggy long">${e(r.body || glanceOf(r)).replace(/\n/g, '<br>')}</div>` +
      `${r.more_on_telegram ? '<div class="sec" style="margin-top:22px">More on Telegram</div>' : ''}</div>`;
  }
  const g = glanceOf(r);
  const hasMore = r.more_on_telegram || (r.body || '').replace(/\s+/g, ' ').trim().length > g.length + 2;
  const small = g.length > 62;
  return `<div class="label" style="margin-bottom:18px">Peggy</div>
    <div class="peggy clamp" style="${small ? 'font-size:34px;line-height:1.2' : ''}">${e(g)}</div>
    ${r.more_on_telegram ? '<div class="sec" style="margin-top:20px">More on Telegram</div>' : hasMore ? '<div class="sec" style="margin-top:20px">Tap to read</div>' : ''}`;
}

export function choice({ question, choices }) {
  const styles = { success: 'ok', primary: '', danger: 'danger' };
  return `<div class="peggy" style="font-size:40px;margin-bottom:14px">${e(question)}</div>` +
    choices.slice(0, 3).map((c) => btn(c.label, styles[c.style] ?? '')).join('');
}

export function needs({ item, index = 0, total = 1, expanded = false }) {
  const level = item.level || 'attention';
  const acts = (item.actions || []).slice(0, 3);
  const layout = needsLayout(item, total);
  const styles = { success: 'ok', primary: '', danger: 'danger' };
  // The client adds its own Got it unless the agent already supplied one (that action dismisses the item too).
  const buttons = acts.map((a, i) => ({ label: a.label, cls: styles[a.style] ?? '', act: 'action', i }));
  if (!acts.some((a) => isAckLabel(a.label))) buttons.push({ label: 'Got it', cls: '', act: 'ack' });
  const glow = level === 'info' ? '' : `<div class="glow${level === 'urgent' ? ' urgent' : ''}"></div>`;
  const calm = level === 'info' ? ' calm' : '';
  if (expanded) {
    const full = (t) => e(t).replace(/\n/g, '<br>');
    return `${glow}<div class="scroller" data-scroller><div data-act="collapse">` +
      `<div class="ntitle long">${full(item.title)}</div>` +
      `${item.body ? `<div class="nbody long${calm}">${full(item.body)}</div>` : ''}</div>` +
      buttons.map((b) => `<div class="btn ${b.cls}" data-act="${b.act}" data-i="${b.i ?? ''}">${e(b.label)}</div>`).join('') +
      `<div class="btn back" data-act="collapse">Back</div></div>`;
  }
  const label = layout === 'stack' ? `<div class="label nlabel">${level === 'info' ? 'Note' : 'Needs you'}</div>` : '';
  const more = needsMore(item, total);
  const body = item.body ? `<div class="nbody${calm}">${e(item.body)}</div>` : '';
  const hint = more ? '<div class="nhint">Tap to read</div>' : '';
  const btns = layout === 'stack'
    ? buttons.map((b) => `<div class="btn ${b.cls}" data-act="${b.act}" data-i="${b.i ?? ''}" style="width:260px">${e(b.label)}</div>`).join('')
    : `<div class="ngrid">${buttons.map((b, k) => `<div class="btn ${b.cls}${buttons.length % 2 && k === buttons.length - 1 ? ' span' : ''}" data-act="${b.act}" data-i="${b.i ?? ''}">${e(b.label)}</div>`).join('')}</div>`;
  const count = total > 1 ? `<div class="ncount" data-act="cycle">${index + 1} of ${total}</div>` : '';
  const text = `<div${more ? ' class="ntext" data-act="expand"' : ' class="ntext"'}><div class="ntitle ${layout === 'stack' ? 'l' : 'g'}">${e(item.title)}</div>${body}${hint}</div>`;
  return `${glow}${label}${text}${btns}${count}`;
}

export function done({ word = 'Noted, and filed.', detail = '' }) {
  return `<div style="font-size:140px;line-height:1">✅</div>
    <div class="peggy" style="font-size:42px;margin-top:20px">${e(word)}</div>${detail ? `<div class="sec" style="margin-top:10px">${e(detail)}</div>` : ''}`;
}

/** Quiet face (22:00 to 06:30): colour only, no text, slow drifting light. */
export function quiet({ tone = { color: '#5fc0b3', alpha: 0.1 } }) {
  return `<div class="qface" style="--qc:${tone.color};--qa:${tone.alpha}"><i class="q1"></i><i class="q2"></i></div>`;
}

/**
 * Agent Status v2. A small clock at the top, a scrollable list of sessions (four rows in view), one rim segment per
 * session (eight, then "+N"). A row is the subject (else the title), a state-coloured dot and the age; a session that
 * needs you is amber. Tapping a row with a conversation opens it. No message text on the face.
 */
export function status({ sessions = [], now, tz, noticeFor = () => false }) {
  const model = statusModel(sessions, now.getTime ? now.getTime() : now);
  const rows = model.rows.length
    ? model.rows.map((r) => { const tap = r.conversationId || (r.needs && noticeFor(r.id)); return `<div class="srow2${r.needs ? ' needs' : ''}${tap ? ' tap' : ''}"${tap ? ` data-act="session" data-cid="${e(r.conversationId || '')}" data-id="${e(r.id)}"` : ''}>` +
      `<span class="sdot" style="background:${r.color}"></span><span class="sname">${e(r.name)}</span><span class="sage">${e(r.age)}</span></div>`; }).join('')
    : '<div class="sec sempty">All quiet</div>';
  return `${statusRingSvg(model)}<div class="stclock">${e(clockText(now, tz))}</div><div class="slist2" data-scroller>${rows}</div>`;
}

/* ---------- views (take over the centre) ---------- */

const fmtRange = (ev, tz) => {
  const t = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : shortTime(tzParts(d, tz).hours); };
  if (ev.at && ev.end) return `${t(ev.at)} – ${t(ev.end)}`;
  if (ev.at) return `Due ${t(ev.at)}`;
  return '';
};

/** The Event focus content: time, title, place, picture, description and the Event's buttons (no Back). */
function eventBody(ev, tz, btn, image) {
  const d = ev.detail || {};
  const acts = (ev.actions || []).slice(0, 3).map((a) => actionBtn(a, btn(`events:${ev.id}`, a.id), 'data-act="efire"', ` data-aid="${e(a.id)}"`)).join('');
  const col = ev.color ? colorValue(ev.color, null) : null;
  return `<div class="label"${col ? ` style="color:${e(col)}"` : ''}>${e(fmtRange(ev, tz))}</div>` +
    `<div class="ftitle">${e(ev.title)}</div>` +
    `${d.location ? `<div class="floc">${e(d.location)}</div>` : ''}` +
    `${image ? `<img class="fimg" src="${e(image)}" alt="">` : ''}` +
    `${ev.body ? `<div class="fbody">${e(ev.body).replace(/\n/g, '<br>')}</div>` : ''}` +
    `${d.description ? `<div class="fbody dim">${e(d.description).replace(/\n/g, '<br>')}</div>` : ''}` +
    `${ev.travel && ev.travel.minutes > 0 ? `<div class="floc">${e(travelLine(ev))}</div>` : ''}` +
    acts;
}
const travelLine = (ev) => `${ev.travel.minutes} min ${ev.travel.mode ? `by ${ev.travel.mode}` : 'travel'} before`;

/** Event focus: title, time, place, picture, description and the Event's buttons. */
export function event({ ev, tz, btn = NO_BTN, image = null }) {
  return `<div class="scroller" data-scroller>${eventBody(ev, tz, btn, image)}<div class="btn back" data-act="back">Back</div></div>`;
}

/**
 * The Day Dial's Event carousel: one card per ring Event, ordered by start. `index` is 0-based within `total`; a card is
 * the Event focus content under a counter row (previous, "n of N", next). A past Event is greyed. An `opens: conversation`
 * Event offers "Open conversation". Back closes to the Day Dial.
 */
export function carousel({ ev, tz, btn = NO_BTN, image = null, index = 0, total = 1, past = false, dir = '' }) {
  const many = total > 1;
  const nav = `<div class="cnav"><div class="carr${many ? '' : ' off'}" data-act="cprev" aria-label="Previous">‹</div>` +
    `<div class="ccount">${index + 1} of ${total}</div><div class="carr${many ? '' : ' off'}" data-act="cnext" aria-label="Next">›</div></div>`;
  const dots = many && total <= 9 ? `<div class="cdots">${Array.from({ length: total }, (_, i) => `<i${i === index ? ' class="on"' : ''}></i>`).join('')}</div>` : '';
  const conv = ev.opens === 'conversation' && ev.conversation_id ? `<div class="btn ok" data-act="copenconv">Open conversation</div>` : '';
  return `<div class="scroller car${past ? ' past' : ''}${dir ? ` slide-${dir}` : ''}" data-scroller data-card="${e(ev.id)}">${nav}${dots}${eventBody(ev, tz, btn, image)}${conv}<div class="btn back" data-act="back">Back</div></div>`;
}

/** Approval view for a bus approval Event: exactly what is being approved, with its approve and deny buttons. */
export function approval({ ev, btn = NO_BTN }) {
  const detail = (ev.approval && ev.approval.detail) || ev.body || '';
  const acts = (ev.actions || []).slice(0, 3).map((a) => actionBtn(a, btn(`events:${ev.id}`, a.id), 'data-act="efire"', ` data-aid="${e(a.id)}"`)).join('');
  return `<div class="scroller" data-scroller>` +
    `<div class="label">Approval</div><div class="ftitle">${e(ev.title)}</div>` +
    `<div class="fcode">${e(detail)}</div>${acts}<div class="btn back" data-act="back">Back</div></div>`;
}

/** The draft step: the exact text that will go out, then Send or Hold. Sending echoes the draft back to the bus. */
export function draft({ to, text, send = 'Send', hold = 'Hold', btn = NO_BTN }) {
  const bs = btn();
  return `<div class="scroller" data-scroller><div class="label">${e(to || 'Send this?')}</div>` +
    `<div class="fdraft">“${e(text)}”</div>` +
    `<div class="btn ok ${bs.state !== 'idle' ? `st-${bs.state}` : ''} ${bs.disabled ? 'off' : ''}" data-act="dsend">${e(bs.label || send)}</div>` +
    `<div class="btn" data-act="dhold">${e(hold)}</div></div>`;
}

/** Conversation view: transcript bubbles (older ones load on scroll up), live appends, tappable choice buttons. */
export function convo({ title = 'Conversation', messages = [], loading = false, hasMore = false, error = '', btn = NO_BTN, convId = '' }) {
  const msgs = messages.map((m) => {
    const side = bubbleSide(m);
    const btns = (m.buttons || []).map((b) => {
      const bs = btn(`conversations:${convId}`, String(b.index), m.id);
      return `<div class="cbtn ${bs.state !== 'idle' ? `st-${bs.state}` : ''} ${bs.disabled ? 'off' : ''}" data-act="cbtn" data-mid="${e(m.id)}" data-i="${b.index}">${e(bs.label || b.label)}</div>`;
    }).join('');
    return `<div class="msg ${side}"><div class="mtext">${e(m.text).replace(/\n/g, '<br>')}</div>` +
      `${m.answer_needed ? '<div class="mneed">Needs your answer</div>' : ''}${btns ? `<div class="mbtns">${btns}</div>` : ''}</div>`;
  }).join('');
  const top = loading ? '<div class="sec cnote">Loading…</div>' : error ? `<div class="sec cnote">${e(error)}</div>` : hasMore ? '<div class="sec cnote">Scroll for earlier</div>' : '';
  return `<div class="chead">${e(title)}</div><div class="cscroll" data-scroller>${top}${msgs || (loading ? '' : '<div class="sec cnote">No messages</div>')}</div><div class="cvback" data-act="back">Back</div>`;
}

export function pairing({ error = '' }) {
  return `<div class="label">Not paired</div>
    <div class="big" style="font-size:40px;margin-top:14px">Open your pairing link</div>
    <div class="sec" style="margin-top:14px;max-width:330px">${error ? e(error) : 'or paste the code below'}</div>`;
}

export function offline({ connecting }) {
  return `<div class="label">${connecting ? 'Connecting' : 'Offline'}</div>
    <div class="big" style="font-size:40px;margin-top:14px">${connecting ? 'One moment' : 'Reconnecting'}</div>`;
}

const R = { idle, listening, working, reply, choice, needs, draft, done, quiet, status, pairing, offline, event, approval, carousel, convo };
export function render(name, props = {}) {
  return R[name](props);
}
