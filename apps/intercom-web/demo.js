// Scripted, server-free walkthrough of the nine mockup screens (?demo).
import { departureView } from './logic.js';
const TZ = 'America/New_York';
export const DEMO_NOW = new Date('2026-11-02T07:52:00-05:00');
const ev = (id, title, s, e, calendar, color) => ({
  id, title, calendar, color, all_day: false,
  start: `2026-11-02T${s}:00-05:00`, end: `2026-11-02T${e}:00-05:00`,
});
export const DEMO_EVENTS = [
  ev('a', 'Busy', '07:00', '11:00', 'Work', '#6a645c'),
  ev('c', 'Busy', '12:30', '14:30', 'Work', '#6a645c'),
  ev('d', 'Busy', '15:45', '17:00', 'Work', '#6a645c'),
  ev('e', 'Kate dr', '12:00', '12:58', 'Family', '#e39aab'),
  ev('f', 'J practice', '14:10', '14:45', 'J Sports', '#74c978'),
  ev('g', 'ENT', '16:10', '17:00', 'Home', '#ffb347'),
  ev('h', 'Celtics', '20:30', '23:30', 'Boston Celtics', '#5fc0b3'),
];
export const DEMO_CAL = { events: DEMO_EVENTS, tz: TZ };

const ses = (id, title, state, since) => ({ id, title, state, channel: 'telegram:peggy', since });
export const DEMO_DESK = {
  sessions: [
    ses('a', 'Intercom Build', 'waiting', '2026-11-02T07:48:00-05:00'), ses('b', 'Highlander Replacement', 'working', '2026-11-02T07:40:00-05:00'),
    ses('c', 'Main', 'working', '2026-11-02T07:51:00-05:00'), ses('d', 'Paper Inbox', 'working', '2026-11-02T07:30:00-05:00'),
    ses('e', 'Email scan', 'finished', '2026-11-02T07:45:00-05:00'), ses('f', 'Kindle', 'idle', '2026-11-02T06:10:00-05:00'),
  ],
  counts: { working: 3, needs_you: 1 },
};
const dep = (leave, delay = 0) => ({ label: '8:37 train', kind: 'train', leave_at: `2026-11-02T${leave}:00-05:00`, delay_min: delay, train: { number: '824', departs: '2026-11-02T08:37:00-05:00' } });

const PHRASE = 'Look into 1Password for agents';

export const STEPS = [
  { name: 'idle', title: 'Idle: the day-dial', desc: 'The rim is your day, like a clock. Grey is work, rose is Kate’s doctor, green is J’s practice, amber is ENT, teal is the Celtics. The gold dot is now.',
    props: () => ({ events: DEMO_EVENTS, now: DEMO_NOW, tz: TZ }) },
  { name: 'listening', title: 'Push-to-talk', desc: 'Hold to talk. The ring moves with your voice and your words appear as they are heard. (Later phase.)',
    props: (t) => ({ transcript: PHRASE.split(' ').slice(0, Math.min(5, 1 + t)).join(' ') }), ticks: 5 },
  { name: 'working', title: 'Working', desc: 'My status line, as on Telegram, with a slowly turning gold arc.',
    props: () => ({ status: 'Researching 1Password' }) },
  { name: 'reply', title: 'The reply', desc: 'One sentence in my voice. Tap to read the whole answer; double-tap to dismiss.',
    props: () => ({ reply: { glance: 'Two routes. I’d use a service account on a Peggy vault.', body: 'Two routes. A service account on a dedicated Peggy vault keeps the blast radius small, and it works headless. The alternative is the agent SDK with a connect server, which needs a host we do not run.', more_on_telegram: true } }) },
  { name: 'choice', title: 'Choice buttons', desc: 'The same buttons Telegram gets. Green is my recommendation, red the careful option. (Later phase.)',
    props: () => ({ question: 'Merge PR #12?', choices: [{ label: 'Merge only', style: 'success' }, { label: 'Merge + restart', style: 'primary' }, { label: 'Hold', style: 'danger' }] }) },
  { name: 'needs', title: 'Needs you', desc: 'The rim glows amber, a light on the desk rather than a buzz in the pocket. Tap an action and it goes to me as if you had typed it.',
    props: () => ({ item: { title: 'ENT at 4:10', body: 'Leave by 3:45', level: 'attention', actions: [{ label: 'Thanks', style: 'success' }, { label: 'Snooze 10' }] }, index: 0, total: 1 }) },
  { name: 'draft', title: 'Draft, then send', desc: 'Anything that leaves the house shows in full before Send appears. Example text only. (Later phase.)',
    props: () => ({ to: 'Text to Kate', text: 'Heading to ENT. Back by 5:30.' }) },
  { name: 'done', title: 'Done', desc: 'Two seconds of the check mark and a word from me, then back to the day-dial.',
    props: () => ({ word: 'Noted, and filed.', detail: 'Water bill · $166' }) },
  { name: 'quiet', title: 'Night', desc: 'After 10 PM: colour only, no text, slow drifting light. Teal is calm. (Amber needs you, red is stuck, brass is a notice waiting.)',
    props: () => ({ tone: { color: '#5fc0b3', alpha: 0.1 } }) },
  { name: 'quiet', title: 'Night, needs you', desc: 'The same face, amber and a little brighter, when something waits on you.',
    props: () => ({ tone: { color: '#ffb347', alpha: 0.2 } }) },
  { name: 'status', title: 'Agent status ring', desc: 'One segment per session: teal working, amber waiting on you, red stuck, brass just finished, grey idle. The rim breathes amber while anything needs you.',
    props: () => ({ desk: DEMO_DESK, now: DEMO_NOW }) },
  { name: 'status', title: 'Status list', desc: 'Tap the ring for up to five sessions: title, state and age. Titles only, never message text.',
    props: () => ({ desk: DEMO_DESK, now: DEMO_NOW, list: true }) },
  { name: 'idle', title: 'Day ring with leave-by', desc: 'The date line becomes “Leave in N min”; the rim goes green, amber under 30 minutes, red under 10, pulsing under 5. The train sits under the next event.',
    props: () => ({ events: DEMO_EVENTS, now: DEMO_NOW, tz: TZ, departure: departureView(dep('08:06'), DEMO_NOW.getTime(), TZ) }) },
  { name: 'idle', title: 'Train delayed', desc: 'A delay turns the train line amber and moves it to the new time.',
    props: () => ({ events: DEMO_EVENTS, now: DEMO_NOW, tz: TZ, departure: departureView(dep('08:06', 6), DEMO_NOW.getTime(), TZ) }) },
  { name: 'idle', title: 'A quiet note', desc: 'A low-key item adds a brass dot and “1 note” under the date, with no glow. Tap it to read. The amber line on the rim means something else needs you.',
    props: () => ({ events: DEMO_EVENTS, now: DEMO_NOW, tz: TZ, notes: 1, halo: true }) },
  { name: 'needs', title: 'Urgent, several items', desc: 'Urgent items pulse slowly. With more than one, “1 of 3” shows; swipe or tap it to move through them. Up to three actions, plus Got it.',
    props: () => ({ item: { title: 'Leave for the dentist', body: 'Dr. Alvarez at 9:00, 18 min drive', level: 'urgent', actions: [{ label: 'Leaving now', style: 'success' }, { label: 'Snooze 10' }, { label: 'Call office' }] }, index: 0, total: 3 }) },
  { name: 'needs', title: 'Long text', desc: 'When the detail is cut short, “Tap to read” shows; tapping the text opens the whole message with the buttons below. Got it is never doubled.',
    props: () => ({ item: { title: 'Morning test of the dial', body: 'Morning test of the dial to check that long messages can be read in full on the round screen without losing the buttons.', level: 'attention', actions: [{ label: 'Got it', style: 'success' }, { label: 'Dismiss' }] }, index: 0, total: 1 }) },
  { name: 'needs', title: 'A note, no glow', desc: 'Opened from the dot on the day-dial: the same screen, calm, with only Got it.',
    props: () => ({ item: { title: 'Mail Watcher finished', body: '3 bills filed, none due this week', level: 'info', actions: [] }, index: 0, total: 1 }) },
];

export function runDemo({ show, setCaption, dialEl, start = 0, hold = false, stepMs = 4200 }) {
  let i = Math.max(0, Math.min(STEPS.length - 1, start));
  let timer = null;
  let tickTimer = null;
  function go(n) {
    i = (n + STEPS.length) % STEPS.length;
    const s = STEPS[i];
    clearTimeout(timer);
    clearInterval(tickTimer);
    let t = 0;
    show(s.name, s.props(t));
    if (s.ticks) tickTimer = setInterval(() => { t = Math.min(s.ticks, t + 1); show(s.name, s.props(t)); }, 650);
    setCaption(`${i + 1} OF ${STEPS.length}`, s.title, s.desc);
    if (!hold) timer = setTimeout(() => go(i + 1), s.name === 'done' ? 2600 : stepMs);
  }
  dialEl.addEventListener('click', () => go(i + 1));
  go(i);
  return { go };
}
