// HTML for each dial screen. All inner content is laid out in the 466 design square.
// Readability: text >= 26px, primary >= 34px, clock >= 110px, buttons >= 72px, <= 4 buttons,
// nothing inside the outer 30px.
import { escapeHtml as e, daySpans, nextEvent, clockText, dateText, shortTime, allDayLine, glanceOf, needsLayout, isAckLabel, needsMore, deskCounts, statusLines, listRows } from './logic.js';
import { dayRingSvg, workingRingSvg, waveRingSvg, statusRingSvg } from './dial.js';

export const SCREENS = ['idle', 'listening', 'working', 'reply', 'choice', 'needs', 'draft', 'done', 'quiet', 'status'];

const btn = (label, cls = '') => `<div class="btn ${cls}">${e(label)}</div>`;

export function idle({ events, now, tz, calendarKnown = true, notes = 0, halo = false, departure = null }) {
  const { timed, allDay } = daySpans(events, now, tz);
  const next = nextEvent(timed, now, tz);
  const ad = allDayLine(allDay);
  let nextHtml;
  if (next) nextHtml = `<div class="next">${e(shortTime(next.startH))} · ${e(next.title)}</div>`;
  else nextHtml = `<div class="sec dim-line">${calendarKnown ? 'Clear for today' : 'Diary unavailable'}</div>`;
  const noteHtml = notes ? `<div class="sec notey" data-act="note"><span class="ndot"></span>${notes} ${notes === 1 ? 'note' : 'notes'}</div>` : '';
  // Desk face 2: the leave line replaces the date while a departure is pending; the train line sits under the next event.
  const dateHtml = departure
    ? `<div class="sec datey leavey ${departure.dim ? 'dim' : departure.pressure}">${e(departure.text)}</div>`
    : `<div class="sec datey">${e(dateText(now, tz))}</div>`;
  const trainHtml = departure && departure.train ? `<div class="trainline${departure.train.delayed ? ' delayed' : ''}">${e(departure.train.text)}</div>` : '';
  return `${dayRingSvg(events, now, tz, halo, departure ? departure.pressure : null)}
    ${dateHtml}${noteHtml}
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

export function draft({ to, text, send = 'Send it', hold = 'Hold' }) {
  return `<div class="label">${e(to)}</div>
    <div style="font-size:36px;font-weight:600;line-height:1.25;margin:16px 0 20px;max-width:330px">“${e(text)}”</div>
    <div class="btn ok" style="width:260px">${e(send)}</div><div class="btn" style="width:260px">${e(hold)}</div>`;
}

export function done({ word = 'Noted, and filed.', detail = '' }) {
  return `<div style="font-size:140px;line-height:1">✅</div>
    <div class="peggy" style="font-size:42px;margin-top:20px">${e(word)}</div>${detail ? `<div class="sec" style="margin-top:10px">${e(detail)}</div>` : ''}`;
}

/** Quiet face (22:00 to 06:30): colour only, no text, slow drifting light. */
export function quiet({ tone = { color: '#5fc0b3', alpha: 0.1 } }) {
  return `<div class="qface" style="--qc:${tone.color};--qa:${tone.alpha}"><i class="q1"></i><i class="q2"></i></div>`;
}

/** Desk face 1: agent status ring. Tap flips to a list of up to five sessions. `noticeFor(session)` says whether a row opens a card. */
export function status({ desk, now, list = false, noticeFor = () => false }) {
  const sessions = (desk && desk.sessions) || [];
  const counts = deskCounts(desk);
  const needs = counts.needs_you > 0;
  if (list) {
    const rows = listRows(sessions, now.getTime ? now.getTime() : now);
    const body = rows.length
      ? rows.map((r, i) => `<div class="srow${r.needs ? ' needs' : ''}"${r.needs && noticeFor(sessions[i]) ? ` data-act="session" data-id="${e(r.id)}"` : ''}>` +
        `<span class="sdot" style="background:${r.color}"></span><div class="st"><div class="stitle">${e(r.title)}</div><div class="ssub">${e(r.sub)}</div></div></div>`).join('')
      : '<div class="sec">No sessions</div>';
    return `${statusRingSvg(sessions, needs)}<div class="slist">${body}</div>`;
  }
  const lines = statusLines(counts).map((l) => `<div class="scount ${l.kind}">${e(l.text)}</div>`).join('');
  return `${statusRingSvg(sessions, needs)}${lines}`;
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

const R = { idle, listening, working, reply, choice, needs, draft, done, quiet, status, pairing, offline };
export function render(name, props = {}) {
  return R[name](props);
}
