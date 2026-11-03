// Scripted, server-free walkthrough of the nine mockup screens (?demo).
import { departureView } from './logic.js';
import { createStore } from './surface.js';
import { sessionsFromDesk } from './statusv2.js';
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
// Surface v2 demo data: what an agent would publish for the same day.
const sev = (id, title, s, e, extra = {}) => ({ id, kind: 'event', title, level: 'info', at: s ? `2026-11-02T${s}:00-05:00` : undefined, end: e ? `2026-11-02T${e}:00-05:00` : undefined, actions: [], ...extra });
export const DEMO_SURFACE_EVENTS = [
  sev('busy', 'Busy', '07:00', '11:00', { color: 'gray' }),
  sev('ent', 'ENT', '16:10', '17:00', { color: 'orange', travel: { minutes: 25, mode: 'drive' }, body: 'Bring the CPAP card.', detail: { location: 'ENT Specialists, Plainville', description: 'Follow-up on the CPAP fitting.' }, actions: [{ id: 'here', label: 'I am here', style: 'primary', confirm: { draft: 'Arrived at the ENT. Back by 5:30.' } }] }),
  sev('kate', 'Kate dr', '16:30', '17:30', { layer: 'overlap', color: 'pink' }),
  sev('jprac', 'J practice', '16:20', '17:10', { layer: 'overlap', color: 'green' }),
  sev('bill', 'Water bill due', '12:00', null, { level: 'attention', color: 'red', detail: { description: '$166.00 due today.' } }),
];
export const demoStore = (slots = {}) => { const st = createStore(); for (const e of DEMO_SURFACE_EVENTS) st.items.events[e.id] = e; Object.assign(st.items.slots, slots); return st; };
const demoUntil = '2026-11-02T20:00:00-05:00';
const DEMO_CONVO = [
  { id: 'm1', role: 'user', text: 'Which train gets me in by 9?', created_at: '2026-11-02T07:30:00-05:00' },
  { id: 'm2', role: 'agent', text: 'The 6008 gets you in at 6:48. The 7:01 gets you in at 7:52, which is a little late for your 8:30.', created_at: '2026-11-02T07:31:00-05:00' },
  { id: 'm3', role: 'agent', text: 'Shall I put the 6008 in the plan for Thursday?', created_at: '2026-11-02T07:44:00-05:00', answer_needed: true, buttons: [{ index: 0, label: 'Yes, 6008' }, { index: 1, label: 'Keep 7:01' }] },
];

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
  { name: 'status', title: 'Agent status', desc: 'Four sessions in view, scroll for more. One rim segment per session (eight, then +N). The subject if the agent set one, else the title. Amber means it needs you; the rim breathes. Tap a row for the conversation.',
    props: () => ({ sessions: sessionsFromDesk(DEMO_DESK).map((x, i) => ({ ...x, subject: i === 1 ? 'Choosing a Highlander' : null, needs_you: x.state === 'waiting', conversation_id: `c${i}` })), now: DEMO_NOW, tz: TZ }) },
  { name: 'idle', title: 'Day Dial v2', desc: 'The agent chooses what the ring shows. Orange is the ENT with a dashed travel wedge before it; the narrow pink and green arcs are overlaps; the red tick at noon is a deadline. Drag the gold ball to scrub the day.',
    props: () => ({ events: [], v2: true, surfaceEvents: DEMO_SURFACE_EVENTS, store: demoStore({ context: { id: 'context', lines: ['Water bill due today', 'Rain after 3'], until: demoUntil } }), now: DEMO_NOW, tz: TZ }) },
  { name: 'idle', title: 'Scrubbing', desc: 'While you drag the ball the centre shows what is at that time, or Free. Let go and it snaps back to now after about four seconds.',
    props: () => ({ events: [], v2: true, surfaceEvents: DEMO_SURFACE_EVENTS, store: demoStore(), now: DEMO_NOW, tz: TZ, scrub: { hours: 16.5 } }) },
  { name: 'idle', title: 'Primary slot with a button', desc: 'An agent override replaces the next-event line and can carry a button. A button that sends something first shows the exact text.',
    props: () => ({ events: [], v2: true, surfaceEvents: DEMO_SURFACE_EVENTS, store: demoStore({ primary: { id: 'primary', text: 'Kate lands at 9:10', until: demoUntil, action: { id: 'ping', label: 'Text Kate', confirm: { draft: 'Running ten minutes late.' } } } }), now: DEMO_NOW, tz: TZ }) },
  { name: 'event', title: 'Event focus', desc: 'Tap a segment or tick: title, time, place, picture and the Event’s buttons.',
    props: () => ({ ev: DEMO_SURFACE_EVENTS[1], tz: TZ }) },
  { name: 'approval', title: 'Approval', desc: 'A bus approval shows exactly what is being approved; Deny is red.',
    props: () => ({ ev: { id: 'approval-1', kind: 'approval', title: 'Bash: git push', approval: { detail: 'git push origin feat/surface-web-v2' }, actions: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'deny', label: 'Deny', style: 'destructive' }] } }) },
  { name: 'convo', title: 'Conversation', desc: 'Tapped from a session row. Older messages load as you scroll up; the agent’s buttons are tappable and show Sent or Failed.',
    props: () => ({ title: 'Commute plan', messages: DEMO_CONVO, convId: 'c1' }) },
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
