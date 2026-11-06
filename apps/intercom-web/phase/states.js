// The 28 reference states of the Plum Dusk boards (screens/index.json), with the spec's sample content:
// Boston, Thursday 5 Nov 2026 (sunrise 6:25 AM, sunset 4:37 PM, spec 1 and 5.3). Used by ?demo and ?state=<board>/<id>.
// Times are frozen; the moon sits where the designer placed it (the board's animation offset, in seconds).
import * as S from './screens.js';
import { nowModel, momentFromEvent } from './model.js';
import { clockPoint, moonDeg, clockDeg } from './geom.js';
import { nightShade } from './sun.js';
import { zonedMs } from './time.js';
import { glyph, icon, marks as drawMarks } from './prims.js';

export const TZ = 'America/New_York';
export const RISE = zonedMs(2026, 11, 5, 6, 25, TZ);
export const SET = zonedMs(2026, 11, 5, 16, 37, TZ);
const at = (h, m, s = 0) => zonedMs(2026, 11, 5, h, m, TZ, s);
const iso = (h, m) => new Date(at(h, m)).toISOString();
const ev = (id, title, h, m, end = null, extra = {}) => momentFromEvent({ id, kind: 'event', title, level: 'info', at: iso(h, m), end: end ? iso(end[0], end[1]) : null, ...extra });

/** Sample Moments for the Home quiet day (2:48 PM): lunch ended at 1:00, then 3:30, 4:00, 5:45 and 7:30. */
export const QUIET_DAY = [
  ev('lunch', 'Lunch', 12, 0, [13, 0]),
  ev('design', 'Design review', 15, 30, null, { detail: { location: 'Room 4B' } }),
  ev('call', 'Call with Sam', 16, 0), ev('pickup', 'Pick up Gracie', 17, 45), ev('dinner', 'Dinner', 19, 30),
];
/** Morning with an evening game (8:30 AM): the 24-hour dial puts the now dot at 127.5 degrees and the 7-10 PM arc at 285-330. */
export const MORNING_GAME = [ev('game', 'Celtics @ Hornets', 19, 0, [22, 0], { detail: { location: 'Spectrum Center, Charlotte' } })];
/** Busy day (2:22 PM): standup ended 1:55; Q4 planning 2:30-3:15 overlaps the vendor call 3:00-3:45. */
export const BUSY_DAY = [
  ev('standup', 'Standup', 13, 30, [13, 55]),
  ev('q4', 'Q4 planning with platform + data teams', 14, 30, [15, 15], { detail: { location: 'Room 4B, Boston office' }, travel: { minutes: 10, mode: 'walk' } }),
  ev('vendor', 'Vendor call', 15, 0, [15, 45]),
  ev('board', 'Board prep', 16, 0), ev('pickup', 'Pick up Gracie', 17, 45), ev('dinner', 'Dinner', 19, 30),
];

/** Environment for a frozen state: the now dot, the moon and the crescent at that time. */
function env(h, m, s, moonSec) {
  const t = at(h, m, s);
  return { t, nowPt: clockPoint(h, m, s), moon: moonSec === null ? null : moonDeg(moonSec), crescent: nightShade(RISE, SET, null, TZ) };
}
const arc = (id, h1, m1, h2, m2, lane = 1, extra = {}) => ({ id, type: 'arc', a1: clockDeg(h1, m1), a2: clockDeg(h1, m1) + ((h2 * 60 + m2 - h1 * 60 - m1) / 1440) * 360, lane, amber: lane === 2, ...extra });
const dot = (id, h, m, extra = {}) => ({ id, type: 'dot', deg: clockDeg(h, m), ...extra });

const row26 = (name, tone) => icon(name, 26, tone);

export const STATES = [
  { id: '01-home/a-quiet-day', time: [14, 48, 20], moon: 20, build(e) {
    const m = nowModel(QUIET_DAY, e.t, TZ);
    return S.nowFace({ ...e, ...m, marks: m.marks });
  } },
  { id: '01-home/b-busy-day', time: [14, 22, 41], moon: 41, build(e) {
    const m = nowModel(BUSY_DAY, e.t, TZ, { missed: 2 });
    return S.nowFace({ ...e, ...m, marks: m.marks, count: 2 });
  } },
  { id: '01-home/c-something-needs-me-now', time: [15, 6, 12], moon: 12, build(e) {
    return S.nowAlert({ ...e, top: 'Time to go · 3:06 PM', bottom: 'Design review at 3:30', verdict: ['LEAVE', 'NOW'], sub: '24 min drive', lit: 36, pills: [{ label: 'On my way', act: 'alert' }, { label: 'Snooze 5', act: 'alert' }] });
  } },
  { id: '02-day-and-events/a-day-list', time: [14, 22, 8], moon: 8, build(e) {
    return S.dayList({ ...e, top: 'Thursday · 5 Nov', bottom: 'Sunset 4:37 PM', more: '+2 LATER TODAY',
      items: [{ kind: 'row', time: '2:30', title: 'Q4 planning with platform + data teams', next: true }, { kind: 'note', text: '◆ OVERLAPS 15 MIN' }, { kind: 'row', time: '3:00', title: 'Vendor call' }, { kind: 'gap', text: '45 MIN FREE' }, { kind: 'row', time: '4:00', title: 'Board prep' }],
      marks: [arc('q4', 14, 30, 15, 15), arc('v', 15, 0, 15, 45, 2), arc('b', 16, 0, 16, 45), dot('p', 17, 45), dot('d', 19, 30)] });
  } },
  { id: '02-day-and-events/b-event-detail', time: [14, 22, 33], moon: 33, build(e) {
    return S.eventDetail({ ...e, top: 'In 8 min', title: 'Q4 planning with platform + data teams', range: '2:30–3:15', sub: 'PM · 45 MIN', place: 'Room 4B, Boston office', travel: 'LEAVE 2:20 · 10 MIN WALK', conflict: '◆ OVERLAPS VENDOR CALL, 3:00',
      actions: [{ id: 'omw', label: 'On my way' }, { id: 'snooze', label: 'Snooze' }, { id: 'call', label: 'Call' }], selected: 'q4', marks: [arc('q4', 14, 30, 15, 15)] });
  } },
  { id: '02-day-and-events/c-stepping-mid-swipe', time: [14, 22, 52], moon: 52, build(e) {
    return S.stepping({ ...e, out: { label: 'IN 8 MIN', title: 'Q4 planning with platform + data teams', time: '2:30' }, in: { label: 'IN 38 MIN', title: 'Vendor call: contract renewal, security questionnaire and the SSO rollout plan', time: '3:00', ampm: 'PM' }, rail: { count: 4, index: 1 },
      marksSvg: drawMarks([arc('q4', 14, 30, 15, 15, 1, { op: 0.35, width: 3 }), arc('v', 15, 0, 15, 45, 2, { amber: false, width: 4 })]) });
  } },
  { id: '02-day-and-events/d-sparse-event', time: [14, 22, 5], moon: 5, build(e) {
    return S.eventDetail({ ...e, sparse: true, top: 'In 38 min', title: 'Vendor call: contract renewal, security questionnaire and the SSO rollout plan', range: '3:00', sub: 'PM', note: 'Bring last year’s quote and the security questionnaire.', actions: [{ id: 'join', label: 'Join call' }], selected: 'v', marks: [dot('v', 15, 0)] });
  } },
  { id: '03a-alerts-act/a-urgent', time: [6, 20, 27], moon: 27, build(e) {
    return S.urgent({ ...e, title: 'Train delayed', changed: { field: 'departs', old: '6:42', new: '6:58' }, detail: '16 min late · Providence line', consequence: 'Misses your 7:15 transfer', lit: 48, pills: [{ label: 'New route', act: 'alert' }, { label: 'Dismiss', act: 'alert' }] });
  } },
  { id: '03a-alerts-act/b-needs-a-decision', time: [14, 55, 47], moon: 47, build(e) {
    return S.decision({ ...e, who: 'Needs you · Dana', headline: 'Approve this draft?', preview: 'Thursday works for me. I’ll send the revised numbers before noon.', meta: 'Draft by Atlas · Email', actions: [{ label: 'Review', act: 'review' }, { label: 'Later', act: 'later' }], window: { a1: clockDeg(14, 55), a2: clockDeg(15, 25) } });
  } },
  { id: '03a-alerts-act/c-confirm-what-is-sent', time: [14, 55, 19], moon: 19, build(e) {
    return S.confirm({ ...e, to: 'To Dana · Email', text: 'Thursday works for me. I’ll send the revised numbers before noon, and loop in Priya so the vendor sees the same version.', hold: 0.6, left: { label: 'Edit', act: 'cedit' }, right: { label: 'Cancel', act: 'ccancel' } });
  } },
  { id: '03b-alerts-clear/a-inform', time: [14, 14, 38], moon: 38, build(e) {
    return S.inform({ ...e, icon: 'package', title: 'Package delivered', detail: 'Front porch · 2:14 PM', clears: 12, remaining: 0.6 });
  } },
  { id: '03b-alerts-clear/b-sent-the-tap-landed', time: [15, 7, 7], moon: 7, build(e) {
    return S.sent({ ...e, words: 'Atlas told Dana you’re on the way.', beats: 2 });
  } },
  { id: '03b-alerts-clear/c-earlier-tray', time: [15, 20, 50], moon: 50, build(e) {
    return S.earlier({ ...e, rows: [
      { id: 'pkg', glyph: row26('package', 'ink'), name: 'Package', detail: '2:14 PM · cleared' },
      { id: 'train', glyph: row26('urgent', 'rose'), name: 'Train delayed', detail: '6:42 · expired' },
      { id: 'dana', glyph: glyph('waiting', 26), name: 'Draft to Dana', detail: 'open · tap to act', open: true },
    ] });
  } },
  { id: '04-agent-activity/a-nothing-running', time: [14, 44, 44], moon: 44, build(e) {
    return S.agentsNone({ ...e, last: 'Last: Weekly report, 2:41 PM' });
  } },
  { id: '04-agent-activity/b-several-running', time: [14, 44, 14], moon: 14, build(e) {
    return S.agentsList({ ...e, top: '1 failed · 2 working', more: '+1 WORKING', rows: [
      { id: 'cal', state: 'failed', name: 'Calendar sync', detail: 'failed' },
      { id: 'inbox', state: 'working', name: 'Inbox triage', detail: 'working · 12m' },
      { id: 'weekly', state: 'done', name: 'Weekly report', detail: 'done · 2m ago' },
    ] });
  } },
  { id: '04-agent-activity/c-one-waiting-on-me', time: [14, 44, 31], moon: 31, build(e) {
    return S.agentWaiting({ ...e, who: 'Trip booking · Needs you', question: 'Aloft or Hyatt for the two nights?', asked: 'Asked 4 min ago', running: 'Running 21 min', options: [{ label: 'Aloft', act: 'qopt' }, { label: 'Hyatt', act: 'qopt' }, { label: 'Open', act: 'qopen' }] });
  } },
  { id: '05-conversation-and-talk/a-reading-a-thread', time: [14, 41, 22], moon: 22, build(e) {
    return S.thread({ ...e, top: 'Atlas · 2:41', text: 'I found two hotels near the venue. Aloft is $189 with free cancellation until Friday. Hyatt is $214 with breakfast included. The venue shuttle stops at both. I can also check the Marriott if you want a third option. Which should I hold for the 12th?', buttons: [{ label: 'Aloft', act: 'tbtn' }, { label: 'Hyatt', act: 'tbtn' }] });
  } },
  { id: '05-conversation-and-talk/b-push-to-talk-listening', time: [14, 41, 0], moon: 'park', build(e) {
    return S.listening({ ...e, transcript: 'Book the Aloft, two nights …', elapsed: '0:04' });
  } },
  { id: '05-conversation-and-talk/c-understood-then-answered', time: [14, 41, 3], moon: 3, build(e) {
    return S.understood({ ...e, heard: 'Book the Aloft, two nights', agent: 'Atlas', answer: 'Holding the Aloft, Nov 12 to 14. I’ll confirm by 5.', buttons: [{ label: 'Undo', act: 'undo' }, { label: 'Open', act: 'uopen' }] });
  } },
  { id: '06-capture/a-recording', time: [14, 30, 3], moon: null, build(e) {
    return S.recording({ ...e, elapsed: '00:03', title: 'Conversation', sub: 'Saving to Atlas as you go' });
  } },
  { id: '06-capture/b-an-hour-in', time: [15, 17, 12], moon: null, build(e) {
    return S.hourIn({ ...e, elapsed: '00:47:12', title: 'Conversation', notch: 0 });
  } },
  { id: '06-capture/c-saved', time: [15, 17, 20], moon: null, build(e) {
    return S.saved({ ...e, length: '47 MIN 12 S', note: 'Sending for transcription. It will show up in your thread.', progress: 1 });
  } },
  { id: '07-rest-wake-offline/a-resting', time: [23, 42, 0], moon: null, build(e) {
    return S.resting({ ...e, clock: '11:42', until: 'Quiet until 7:00 AM' });
  } },
  { id: '07-rest-wake-offline/b-woken-in-quiet-hours', time: [23, 42, 35], moon: 35, build(e) {
    return S.woken({ ...e, label: 'Tomorrow', time: '7:30', unit: 'AM', title: 'Flight to Chicago', dims: 20 });
  } },
  { id: '07-rest-wake-offline/c-offline', time: [14, 52, 52], moon: 52, build(e) {
    const m = nowModel(QUIET_DAY, e.t, TZ, { offline: true, offlineSince: at(14, 41) });
    return S.nowFace({ ...e, ...m, bottom: 'Design review', offline: true });
  } },
  { id: '08-pairing-and-settings/a-pairing', time: [14, 48, 0], moon: null, build(e) {
    return S.pairing({ ...e, code: ['7KQ', '42M'], expires: 'Expires in 4:48', waiting: 'Waiting for your agent', cancel: 'Click power to cancel', lit: 58 });
  } },
  { id: '08-pairing-and-settings/b-connected', time: [14, 48, 45], moon: 45, build(e) {
    return S.connected({ ...e, agent: 'Atlas', account: 'Personal account', line: 'Paired Oct 12 · synced 12 s ago' });
  } },
  { id: '08-pairing-and-settings/c-settings', time: [14, 48, 0], moon: null, build(e) {
    return S.settings({ ...e, brightness: 0.7, volume: 0.55, quiet: '10P–7A', daylight: 'BOSTON', agent: 'ATLAS' });
  } },
];

export const STATE_IDS = STATES.map((s) => s.id);
/** Extra ?state= fixtures with no board (not in the demo cycle or the board comparison): the 24-hour dial check. */
export const EXTRA_STATES = [
  { id: 'extra/24h-morning-game', time: [8, 30, 0], moon: 0, build(e) {
    const m = nowModel(MORNING_GAME, e.t, TZ);
    return S.nowFace({ ...e, ...m, marks: m.marks });
  } },
];
/** Build the view model of one state, frozen at its reference time. */
export function buildState(id) {
  const s = STATES.find((x) => x.id === id) || EXTRA_STATES.find((x) => x.id === id);
  if (!s) return null;
  const [h, m, sec] = s.time;
  const e = env(h, m, sec, s.moon === 'park' ? 0 : s.moon);
  if (s.moon === null) e.moon = null;
  return { ...s.build(e), t: e.t };
}
