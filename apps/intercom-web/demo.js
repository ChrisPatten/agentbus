// Scripted, server-free walkthrough of the nine mockup screens (?demo).
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
  { name: 'needs', title: 'Needs you', desc: 'The rim glows amber, a light on the desk rather than a buzz in the pocket. (Later phase.)',
    props: () => ({ title: 'ENT at 4:10', line: 'Leave by 3:45', actions: ['Thanks', 'Snooze 10'] }) },
  { name: 'draft', title: 'Draft, then send', desc: 'Anything that leaves the house shows in full before Send appears. Example text only. (Later phase.)',
    props: () => ({ to: 'Text to Kate', text: 'Heading to ENT. Back by 5:30.' }) },
  { name: 'done', title: 'Done', desc: 'Two seconds of the check mark and a word from me, then back to the day-dial.',
    props: () => ({ word: 'Noted, and filed.', detail: 'Water bill · $166' }) },
  { name: 'quiet', title: 'Face-down / night', desc: 'Turned over, or after 10 PM: no glow, dim display, messages wait. (Later phase.)',
    props: () => ({ now: new Date('2026-11-02T22:41:00-05:00'), tz: TZ, waiting: 2 }) },
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
