#!/usr/bin/env node
// Publish demo Events, slots and widgets to a live bus so the phone shows the Surface v2 faces.
//
//   BUS_TOKEN=... node apps/intercom-web/dev/publish-demo.mjs [--surface <id>] [--agent <id>] [--url <bus>] [--dry-run] [--clear]
//
// Environment (the token is never printed or logged):
//   BUS_TOKEN   the bus's shared token (config bus.auth_token), sent as X-Bus-Token. Also read from AGENTBUS_TOKEN / BUS_AUTH_TOKEN.
//               Omit it only when the bus has no auth_token set.
//   BUS_URL     bus base URL, default http://127.0.0.1:3000 (the main port; the publishing routes are not on the TLS listener)
//   SURFACE_ID  surface to publish to; default: the first surface the agent may publish to (GET surface-publish/surfaces)
//   AGENT_ID    publishing agent, default "peggy" (it must be listed in the surface's `publishers`)
//
// What it publishes (routes in docs/SURFACE_API.md, "Agent publishing tools"), all ids prefixed `demo-`:
//   - calendar-style Events across today (the ring is driven by surface Events, not the calendar): busy blocks, lunch, J practice, Celtics
//   - an appointment about 1.5 h from now with a travel wedge (drives "Leave in N min"), detail, and a confirm-draft button
//   - two narrow overlap segments over it, and a deadline tick (bill) 3 h out
//   - the primary slot (text and a button) and the context slot (two lines), for 2 h and 4 h
//   - three widgets (gauge, countdown, icon-with-value); the context slot shows them with --widgets
// Buttons post a harmless "[demo]" message into the followed conversation when tapped (jobs always target it). --clear removes
// every `demo-` Event, slot and widget this script created. --dry-run prints the requests without sending (token never shown).
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = (opt('url', process.env.BUS_URL || 'http://127.0.0.1:3000')).replace(/\/$/, '');
const TOKEN = process.env.BUS_TOKEN || process.env.AGENTBUS_TOKEN || process.env.BUS_AUTH_TOKEN || '';
const AGENT = opt('agent', process.env.AGENT_ID || 'peggy');
const DRY = flag('dry-run');
const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Bus-Token': TOKEN } : {}) };
const P = '/api/v1/surface-publish';

import { pathToFileURL } from 'node:url';

const pad = (n) => String(n).padStart(2, '0');
function iso(d) { const off = -d.getTimezoneOffset(); const a = Math.abs(off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; }
const demoBody = (what) => ({ body: `[demo] ${what} tapped on the Intercom demo (ignore)` });

/** The demo payloads relative to `now` (exported so the tests can run them through the bus's own validators). */
export function buildDemo(now = new Date(), agent = 'peggy') {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const atH = (h) => iso(new Date(day.getTime() + h * 3600e3));
  const inMin = (m) => iso(new Date(Math.round((now.getTime() + m * 60000) / 300000) * 300000));
  const endOfDay = atH(24);
  // The ring holds one primary at a time, so the live appointment starts at the first half hour (at least 90 minutes out)
  // that clears the fixed blocks below.
  const FIXED = [[9, 11], [12, 13], [13.5, 15], [15.5, 16.5], [19.5, 22]];
  let apptMin = 90;
  const nowH = (now.getTime() - day.getTime()) / 3600e3;
  while (apptMin < 600 && FIXED.some(([a, b]) => nowH + apptMin / 60 < b && nowH + apptMin / 60 + 1 > a)) apptMin += 30;
  const ev = (id, title, s, e, extra = {}) => ({ agent_id: agent, id: `demo-${id}`, title, at: s, ...(e ? { end: e } : {}), expires_at: endOfDay, ...extra });
  const EVENTS = [
    ev('busy-am', 'Busy', atH(9), atH(11), { color: 'gray' }),
    ev('lunch', 'Lunch with Kate', atH(12), atH(13), { color: 'pink', detail: { location: 'Sorelle, Mansfield', description: 'Booked under Patten.' } }),
    ev('busy-pm', 'Busy', atH(13.5), atH(15), { color: 'gray' }),
    ev('jprac', 'J practice', atH(15.5), atH(16.5), { color: 'green', detail: { location: 'Qualters Middle School' } }),
    ev('celtics', 'Celtics', atH(19.5), atH(22), { color: 'teal', body: 'Tip at 7:30.' }),
    ev('appt', 'ENT visit', inMin(apptMin), inMin(apptMin + 60), {
      color: 'orange', travel: { minutes: 25, mode: 'drive' }, body: 'Bring the CPAP card.',
      detail: { location: 'ENT Specialists, Plainville', description: 'Follow-up on the CPAP fitting.' },
      actions: [
        { id: 'here', label: "I'm here", style: 'primary', confirm: { draft: "I'm at the ENT now. Back around 5:30.", prompt: 'Text Mrs. Patten?' }, run: demoBody("I'm here") },
        { id: 'late', label: 'Running late', run: demoBody('Running late') },
      ],
    }),
    ev('over1', 'Kate call', inMin(apptMin + 10), inMin(apptMin + 40), { layer: 'overlap', color: 'purple' }),
    ev('over2', 'J pickup', inMin(apptMin + 25), inMin(apptMin + 55), { layer: 'overlap', color: 'green' }),
    ev('bill', 'Water bill due', inMin(apptMin + 90), null, { level: 'attention', body: '$166.00 due today.', detail: { description: 'Autopay is off this month.' }, actions: [{ id: 'paid', label: 'Mark paid', run: demoBody('Mark paid') }] }),
  ];
  const WIDGETS = [
    { id: 'demo-budget', type: 'gauge', data: { value: 62, max: 100, label: 'Budget' } },
    { id: 'demo-kate', type: 'countdown', data: { to: inMin(95), label: 'Kate' } },
    { id: 'demo-rain', type: 'icon-with-value', data: { icon: 'R', value: '40%', label: 'Rain' } },
  ];
  const primary = { agent_id: agent, text: 'Kate lands at 9:10', color: 'orange', until: inMin(120), action: { id: 'ping', label: 'Text Kate', style: 'primary', confirm: { draft: 'Running ten minutes late. See you at the curb.', prompt: 'Text Kate?' }, run: demoBody('Text Kate') } };
  const contextLines = { agent_id: agent, lines: ['Water bill due today', 'Rain after 3'], until: inMin(240) };
  const contextWidgets = { agent_id: agent, widgets: WIDGETS.map((w) => w.id), until: inMin(240) };
  return { events: EVENTS, widgets: WIDGETS, primary, contextLines, contextWidgets };
}

async function call(method, path, body) {
  const url = `${BASE}${path}`;
  if (DRY) { console.log(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`); return { ok: true, status: 0, json: {} }; }
  let r;
  try { r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }); } catch (e) { console.error(`${method} ${path}: cannot reach ${BASE} (${e.cause?.code || e.message})`); process.exit(2); }
  let json = {}; try { json = await r.json(); } catch { /* none */ }
  const tag = r.ok ? 'ok ' : `ERR ${r.status}`;
  console.log(`${tag} ${method} ${path}${r.ok ? '' : ` ${json.error || json.message || ''}`}`);
  return { ok: r.ok, status: r.status, json };
}

async function surfaceId() {
  const want = opt('surface', process.env.SURFACE_ID);
  if (want) return want;
  if (DRY) return 'SURFACE';
  const r = await call('GET', `${P}/surfaces?agent_id=${encodeURIComponent(AGENT)}`);
  const list = r.json.surfaces || r.json || [];
  const first = Array.isArray(list) ? list[0] : null;
  if (!first) { console.error(`No surface this agent may publish to. Add "${AGENT}" to adapters.intercom.surfaces[].publishers.`); process.exit(3); }
  return first.id || first.surface_id || first;
}

const demo = buildDemo(new Date(), AGENT);
async function main() {
  const S = await surfaceId();
  const put = (path, body) => call('PUT', `${P}/${encodeURIComponent(S)}/${path}`, body);
  const del = (path) => call('DELETE', `${P}/${encodeURIComponent(S)}/${path}${path.includes('?') ? '&' : '?'}agent_id=${encodeURIComponent(AGENT)}`);
  if (flag('clear')) {
    for (const e of demo.events) await del(`events/${e.id}`);
    await del('slots/primary'); await del('slots/context');
    for (const w of demo.widgets) await del(`widgets/${w.id}`);
    return;
  }
  for (const w of demo.widgets) await put(`widgets/${w.id}`, { agent_id: AGENT, type: w.type, data: w.data });
  for (const e of demo.events) await put(`events/${e.id}`, e);
  await put('slots/primary', demo.primary);
  await put('slots/context', flag('widgets') ? demo.contextWidgets : demo.contextLines);
  console.log(DRY ? 'dry run: nothing sent' : `published to surface "${S}" as agent "${AGENT}"`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
