// HTML for each dial screen. All inner content is laid out in the 466 design square.
// Readability: text >= 26px, primary >= 34px, clock >= 110px, buttons >= 72px, <= 4 buttons,
// nothing inside the outer 30px.
import { escapeHtml as e, daySpans, nextEvent, clockText, dateText, shortTime, allDayLine, glanceOf } from './logic.js';
import { dayRingSvg, workingRingSvg, waveRingSvg } from './dial.js';

export const SCREENS = ['idle', 'listening', 'working', 'reply', 'choice', 'needs', 'draft', 'done', 'quiet'];

const btn = (label, cls = '') => `<div class="btn ${cls}">${e(label)}</div>`;

export function idle({ events, now, tz, calendarKnown = true }) {
  const { timed, allDay } = daySpans(events, now, tz);
  const next = nextEvent(timed, now, tz);
  const ad = allDayLine(allDay);
  let nextHtml;
  if (next) nextHtml = `<div class="next">${e(shortTime(next.startH))} · ${e(next.title)}</div>`;
  else nextHtml = `<div class="sec dim-line">${calendarKnown ? 'Clear for today' : 'Diary unavailable'}</div>`;
  return `${dayRingSvg(events, now, tz)}
    <div class="sec datey">${e(dateText(now, tz))}</div>
    ${ad ? `<div class="sec allday">${e(ad)}</div>` : ''}
    <div class="clock">${e(clockText(now, tz))}</div>${nextHtml}`;
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

export function needs({ title, line, actions }) {
  return `<div class="glow"></div><div class="big" style="font-size:50px">${e(title)}</div>
    <div class="sec" style="color:var(--amber);font-weight:600;margin:8px 0 22px">${e(line)}</div>` +
    actions.slice(0, 2).map((a, i) => `<div class="btn ${i === 0 ? 'ok' : ''}" style="width:260px">${e(a)}</div>`).join('');
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

export function quiet({ now, tz, waiting = 0 }) {
  return `<div class="clock quiet-clock">${e(clockText(now, tz))}</div>
    <div class="quiet-label">QUIET</div>${waiting ? `<div class="quiet-wait">${waiting} waiting</div>` : ''}`;
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

const R = { idle, listening, working, reply, choice, needs, draft, done, quiet, pairing, offline };
export function render(name, props = {}) {
  return R[name](props);
}
