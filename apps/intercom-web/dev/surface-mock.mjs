// Dev-only mock of the Surface API v2 (docs/SURFACE_API.md) for the Intercom web prototype.
// Used by mock-server.mjs. Holds the seven resources with revs and an op log, serves /state, /conversations,
// /assets, /actions and the v2 hello/resume, and turns typed commands into resource changes.
//
// Typed commands (send them as a message):
//   event: dentist | fail | expired | chat   a ring Event with detail, travel and buttons (or one that fails / expires / opens a conversation)
//   overlap                                   two narrow overlap segments over the dentist
//   tick: bill                                a deadline tick on the rim
//   travel                                    an Event 45 min out with 30 min travel (Leave in 15 min)
//   slot: primary                             primary slot override with a confirm-draft button
//   slot: context lines                       two context lines
//   widgets                                   gauge, countdown and icon widgets in the context slot
//   sessions | needs                          six sessions / one that needs you (with a question and buttons)
//   approval                                  a bus approval Event (approve / deny)
//   convo                                     a new agent message with buttons in conv-main (live append)
//   calendar                                  reseed the calendar-style appointments    clear   remove everything
import crypto from 'node:crypto';

export const RESOURCES = ['faces', 'events', 'slots', 'widgets', 'sessions', 'notices', 'device'];
export const IMG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="140" viewBox="0 0 260 140"><rect width="260" height="140" rx="14" fill="#2a2418"/><rect x="18" y="18" width="224" height="104" rx="10" fill="#3b2f12"/><circle cx="80" cy="70" r="28" fill="#ffb347"/><rect x="124" y="46" width="96" height="14" rx="7" fill="#f6eedb"/><rect x="124" y="74" width="64" height="14" rx="7" fill="#b3aa9a"/></svg>';
export const IMG_HASH = crypto.createHash('sha256').update(IMG_SVG).digest('hex');

const pad = (n) => String(n).padStart(2, '0');
export function isoLocal(d) {
  const off = -d.getTimezoneOffset(); const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const round5 = (ms) => Math.round(ms / 300000) * 300000;

export function createSurfaceMock({ token, noticeAction = () => ({ status: 'failed', reason: 'not_found' }), wssClients }) {
  const revs = {}; const items = {}; const logs = {};
  for (const r of RESOURCES) { revs[r] = 0; items[r] = {}; logs[r] = []; }
  const convs = new Map();
  const keys = new Map(); const fired = new Set();
  let n = 0;
  const nowIso = () => new Date().toISOString();
  const v2clients = () => [...wssClients()].filter((c) => c.authed && c.v2 && c.readyState === 1);
  const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  function mutate(resource, ops) {
    if (!ops.length) return;
    const base = revs[resource]; const rev = base + 1;
    for (const o of ops) {
      if (o.op === 'set') items[resource][o.id] = o.value;
      else if (o.op === 'remove') delete items[resource][o.id];
      else if (o.op === 'patch') { const cur = { ...items[resource][o.id], ...o.value }; for (const [k, v] of Object.entries(o.value)) if (v === null) delete cur[k]; items[resource][o.id] = cur; }
    }
    revs[resource] = rev; logs[resource].push({ rev, ops });
    for (const c of v2clients()) send(c, { type: 'delta', resource, base_rev: base, rev, ops });
  }
  const setItem = (r, id, value) => mutate(r, [{ op: 'set', id, value }]);
  const removeAll = (r) => mutate(r, Object.keys(items[r]).map((id) => ({ op: 'remove', id })));

  /* ---------- seed ---------- */
  mutate('faces', ['day', 'status', 'desk'].map((id, i) => ({ op: 'set', id, value: { id, order: i, enabled: true } })));
  function seedCalendar() {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const at = (h) => isoLocal(new Date(day.getTime() + h * 3600e3));
    const mk = (id, title, s, e, color, extra = {}) => ({ id, kind: 'event', title, level: 'info', at: at(s), end: at(e), color, source: 'agent:peggy', created_at: nowIso(), updated_at: nowIso(), expires_at: at(24), actions: [], ...extra });
    mutate('events', [
      mk('cal-busy-am', 'Busy', 9, 11, 'gray'),
      mk('cal-lunch', 'Lunch with Kate', 12, 13, 'pink', { detail: { location: 'Sorelle, Mansfield', description: 'Booked under Patten.' } }),
      mk('cal-busy-pm', 'Busy', 13.5, 15, 'gray'),
      mk('cal-jprac', 'J practice', 15.5, 16.5, 'green', { detail: { location: 'Qualters Middle School' } }),
      mk('cal-celtics', 'Celtics', 19.5, 22, 'teal', { body: 'Tip at 7:30 on NBC Sports Boston.' }),
    ].map((v) => ({ op: 'set', id: v.id, value: v })));
  }
  seedCalendar();

  /* ---------- conversations ---------- */
  function conv(id, title) {
    if (!convs.has(id)) {
      const c = { id, title: title || 'Conversation', messages: [] };
      const base = Date.now() - 3 * 3600e3;
      const lines = ['Morning. Anything on the train?', 'The 6008 is on time. The 7:01 is running six minutes late.', 'Shall I move the plan to the 6008?', 'Yes please.', 'Done. It is in the book.'];
      const count = id === 'conv-main' ? 44 : 5;
      for (let i = 0; i < count; i++) c.messages.push({ id: `${id}-m${i + 1}`, role: i % 2 ? 'agent' : 'user', text: `${lines[i % lines.length]}${id === 'conv-main' ? ` (${i + 1})` : ''}`, created_at: new Date(base + i * 240000).toISOString() });
      convs.set(id, c);
    }
    return convs.get(id);
  }
  conv('conv-main', 'Main');
  const pageOf = (c, before, limit) => {
    let end = c.messages.length;
    if (before) { const i = c.messages.findIndex((m) => m.id === before); end = i < 0 ? 0 : i; }
    const start = Math.max(0, end - limit);
    const msgs = c.messages.slice(start, end).map((m) => ({ id: m.id, role: m.role, text: m.text, created_at: m.created_at, ...(m.buttons && !m.answered ? { buttons: m.buttons.map((b, index) => ({ index, label: b.label })) } : {}), ...(m.answer_needed && !m.answered ? { answer_needed: true } : {}) }));
    return { conversation_id: c.id, title: c.title, messages: msgs, next_before: start > 0 ? c.messages[start].id : null };
  };
  function appendConv(c, m) {
    const msg = { id: `${c.id}-m${c.messages.length + 1}-${Date.now() % 1000}`, created_at: nowIso(), ...m };
    c.messages.push(msg);
    for (const ws of v2clients()) if (ws.view === `conversation:${c.id}`) send(ws, { type: 'event', event: 'conversation_append', data: { conversation_id: c.id, message: pageOf({ id: c.id, title: c.title, messages: [msg] }, null, 1).messages[0] } });
    return msg;
  }

  /* ---------- typed commands ---------- */
  const until = (h) => isoLocal(new Date(Date.now() + h * 3600e3));
  function sessionsSet(needs = false) {
    const mkS = (id, title, state, subject, mins, extra = {}) => ({ id, title, subject, state, channel: 'telegram:peggy', conversation_id: `conv-${id}`, since: new Date(Date.now() - mins * 60000).toISOString(), last_activity_at: new Date(Date.now() - Math.min(mins, 3) * 60000).toISOString(), needs_you: false, needs_you_message_id: null, system: false, ...extra });
    const list = [
      ...(needs ? [mkS('intercom', 'Intercom Build', 'waiting', 'Which train for Thursday?', 6, { needs_you: true, conversation_id: 'conv-main', needs_you_message_id: 'q' })] : []),
      mkS('hl', 'Highlander Replacement', 'working', 'Comparing trims', 22), mkS('main', 'Main', 'working', null, 3), mkS('paper', 'Paper Inbox', 'finished', 'Filed 3 bills', 9),
      mkS('mail', 'Email scan', 'idle', null, 41), mkS('kindle', 'Kindle', 'idle', 'Dashboard refresh', 55),
    ];
    mutate('sessions', [...Object.keys(items.sessions).map((id) => ({ op: 'remove', id })), ...list.map((v) => ({ op: 'set', id: v.id, value: v }))]);
    if (needs) {
      const c = conv('conv-main', 'Main');
      appendConv(c, { role: 'agent', text: 'Which train should I plan for Thursday?', answer_needed: true, buttons: [{ label: 'The 6008' }, { label: 'The 7:01' }, { label: 'WFH' }] });
    }
  }
  function typed(body) {
    const m = String(body || '').trim().match(/^(event|overlap|tick|travel|slot|widgets|sessions|needs|approval|convo|calendar|clear)\b\s*:?\s*(.*)$/i);
    if (!m) return false;
    const cmd = m[1].toLowerCase(); const arg = m[2].trim().toLowerCase();
    const base = round5(Date.now() + 90 * 60000);
    const iso = (ms) => isoLocal(new Date(ms));
    const ev = (id, v) => setItem('events', id, { id, kind: 'event', level: 'info', source: 'agent:peggy', created_at: nowIso(), updated_at: nowIso(), expires_at: until(10), actions: [], ...v });
    if (cmd === 'event') {
      if (arg === 'fail') ev('failing', { title: 'Button that fails', at: iso(base), end: iso(base + 3600e3), color: 'red', actions: [{ id: 'x', label: 'Try it' }] });
      else if (arg === 'expired') ev('stale', { title: 'Button that expired', at: iso(base), end: iso(base + 3600e3), color: 'purple', actions: [{ id: 'x', label: 'Too late' }] });
      else if (arg === 'chat') ev('chat', { title: 'Train question', at: iso(base), end: iso(base + 1800e3), color: 'blue', opens: 'conversation', conversation_id: 'conv-main' });
      else ev('dentist', { title: 'Dentist', body: 'Dr. Alvarez, second floor.', at: iso(base), end: iso(base + 3600e3), color: 'orange', layer: 'primary', travel: { minutes: 20, mode: 'drive' }, detail: { location: '12 Main St, Mansfield', description: 'Crown fitting. Bring the insurance card.', image: IMG_HASH }, actions: [{ id: 'here', label: "I'm here", style: 'primary', confirm: { draft: "I'm at the dentist now. Back around 5:30.", prompt: 'Text Kate?' } }, { id: 'late', label: 'Running late' }] });
    } else if (cmd === 'overlap') {
      const d = items.events.dentist; const s = d ? Date.parse(d.at) : base;
      ev('ov1', { title: 'Kate call', at: iso(s + 600e3), end: iso(s + 2400e3), layer: 'overlap', color: 'pink' });
      ev('ov2', { title: 'J pickup', at: iso(s + 1200e3), end: iso(s + 3300e3), layer: 'overlap', color: 'green' });
    } else if (cmd === 'tick') {
      ev('bill', { title: 'Water bill due', level: 'attention', at: iso(round5(Date.now() + 3 * 3600e3)), body: '$166.00 due today.', detail: { description: 'Autopay is off this month.' }, actions: [{ id: 'paid', label: 'Mark paid' }] });
    } else if (cmd === 'travel') {
      ev('airport', { title: 'Airport pickup', at: iso(round5(Date.now() + 45 * 60000)), end: iso(round5(Date.now() + 120 * 60000)), color: 'teal', travel: { minutes: 30, mode: 'drive' } });
    } else if (cmd === 'slot' && arg.startsWith('primary')) {
      setItem('slots', 'primary', { id: 'primary', text: 'Kate lands at 9:10', color: 'orange', until: until(2), source: 'agent:peggy', updated_at: nowIso(), action: { id: 'ping', label: 'Text Kate', style: 'primary', confirm: { draft: 'Running ten minutes late. See you at the curb.', prompt: 'Text Kate?' }, once: true } });
    } else if (cmd === 'slot') {
      setItem('slots', 'context', { id: 'context', lines: ['Water bill due today', 'Rain after 3'], until: until(4), source: 'agent:peggy', updated_at: nowIso() });
    } else if (cmd === 'widgets') {
      const w = (id, type, data) => ({ id, type, data, source: 'agent:peggy', updated_at: nowIso() });
      mutate('widgets', [w('budget', 'gauge', { value: 62, max: 100, label: 'Budget' }), w('kate', 'countdown', { to: iso(Date.now() + 95 * 60000), label: 'Kate' }), w('rain', 'icon-with-value', { icon: 'R', value: '40%', label: 'Rain' }), w('steps', 'sparkline-lite', { points: [3, 5, 4, 8, 6, 9, 7], label: 'Steps' })].map((v) => ({ op: 'set', id: v.id, value: v })));
      setItem('slots', 'context', { id: 'context', widgets: ['budget', 'kate', 'rain'], until: until(4), source: 'agent:peggy', updated_at: nowIso() });
    } else if (cmd === 'sessions') sessionsSet(false);
    else if (cmd === 'needs') sessionsSet(true);
    else if (cmd === 'approval') {
      ev('approval-7', { kind: 'approval', title: 'Bash: git push', level: 'attention', source: 'bus', body: 'Agent peggy asks to use Bash.', approval: { approval_id: 7, tool: 'Bash', detail: 'git push origin feat/surface-web-v2\n\nPushes 6 commits to origin.' }, actions: [{ id: 'approve', label: 'Approve', style: 'primary' }, { id: 'deny', label: 'Deny', style: 'destructive' }] });
    } else if (cmd === 'convo') {
      appendConv(conv('conv-main', 'Main'), { role: 'agent', text: 'Which restaurant for Saturday?', answer_needed: true, buttons: [{ label: 'Sorelle' }, { label: 'Taverna' }] });
    } else if (cmd === 'calendar') seedCalendar();
    else if (cmd === 'clear') { removeAll('events'); removeAll('slots'); removeAll('widgets'); removeAll('sessions'); }
    return true;
  }

  /* ---------- actions ---------- */
  function act(b) {
    const fail = (reason) => ({ status: 'failed', reason });
    if (!b || typeof b.object !== 'string' || !b.action_id || !b.idempotency_key) return fail('invalid');
    if (keys.has(b.idempotency_key)) { const r = keys.get(b.idempotency_key); return r.status === 'done' ? { ...r, status: 'already_done' } : r; }
    const [kind, ...rest] = b.object.split(':'); const id = rest.join(':');
    let res;
    if (kind === 'events' || kind === 'slots') {
      const holder = kind === 'events' ? items.events[id] : items.slots[id];
      const action = holder && (kind === 'events' ? holder.actions : [holder.action]).find((a) => a && a.id === b.action_id);
      if (!action) res = fail('not_found');
      else if (action.confirm && !b.draft) res = fail('confirm_required');
      else if (action.confirm && b.draft !== action.confirm.draft) res = fail('draft_mismatch');
      else if (id === 'stale') res = { status: 'expired' };
      else if (id === 'failing') res = fail('no_route');
      else if (action.once !== false && fired.has(`${b.object}:${b.action_id}`)) res = { status: 'already_done' };
      else { fired.add(`${b.object}:${b.action_id}`); res = { status: 'done', message_id: `in-${++n}` }; if (kind === 'events' && id.startsWith('approval-')) mutate('events', [{ op: 'remove', id }]); }
    } else if (kind === 'notices') res = noticeAction(id, Number(b.action_id));
    else if (kind === 'conversations') {
      const c = convs.get(id); const idx = Number(b.action_id);
      const msg = c && (b.message_id ? c.messages.find((m) => m.id === b.message_id) : [...c.messages].reverse().find((m) => m.buttons && !m.answered));
      if (!c || !msg || !msg.buttons) res = fail('not_found');
      else if (!msg.buttons[idx]) res = fail('invalid');
      else if (msg.answered) res = { status: 'already_done' };
      else {
        msg.answered = true;
        appendConv(c, { role: 'user', text: `[tapped] ${msg.buttons[idx].label}` });
        setTimeout(() => appendConv(c, { role: 'agent', text: `Noted: ${msg.buttons[idx].label}.` }), 1200);
        if (items.sessions[id.replace(/^conv-/, '')]?.needs_you) mutate('sessions', [{ op: 'patch', id: id.replace(/^conv-/, ''), value: { needs_you: false, state: 'working' } }]);
        res = { status: 'done', message_id: `in-${++n}` };
      }
    } else res = fail('invalid');
    if (res.reason !== 'internal_error') keys.set(b.idempotency_key, res);
    return { type: 'action_result', idempotency_key: b.idempotency_key, ...res };
  }

  /* ---------- http ---------- */
  function http(req, res, u, json, readBody) {
    const p = u.pathname;
    if (p === '/api/v1/surface/pair') return false; // pairing stays on the shared mock handler
    if (!p.startsWith('/api/v1/surface/')) return false;
    if (req.headers.authorization !== `Bearer ${token}`) { json(401, { ok: false, error: 'unauthorized' }); return true; }
    const sub = p.slice('/api/v1/surface/'.length);
    if (sub === 'health') { json(200, { ok: true, surface_id: 'mock-surface', device_id: 'mock-surface-legacy', scope: 'interactive', protocol: 2, version: 'mock', connected_clients: wssClients().size }); return true; }
    if (sub === 'state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ surface_id: 'mock-surface', device_id: 'mock-surface-legacy', server_time: nowIso(), revs: { ...revs }, resources: JSON.parse(JSON.stringify(items)) })); return true;
    }
    if (sub.startsWith('conversations/')) {
      const id = decodeURIComponent(sub.slice('conversations/'.length));
      if (!/^[A-Za-z0-9_:-]{1,128}$/.test(id)) { json(400, { ok: false, error: 'invalid_query' }); return true; }
      const known = id === 'conv-main' || Object.values(items.sessions).some((s) => s.conversation_id === id) || convs.has(id) || Object.values(items.events).some((e) => e.conversation_id === id);
      if (!known) { json(404, { ok: false, error: 'not_found' }); return true; }
      const title = Object.values(items.sessions).find((s) => s.conversation_id === id)?.title;
      json(200, pageOf(conv(id, title), u.searchParams.get('before'), Math.min(100, Number(u.searchParams.get('limit')) || 30))); return true;
    }
    if (sub.startsWith('assets/')) {
      if (sub.slice(7) !== IMG_HASH) { json(404, { ok: false, error: 'not_found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000, immutable' }); res.end(IMG_SVG); return true;
    }
    if (sub === 'actions' && req.method === 'POST') {
      readBody().then((raw) => { let b; try { b = JSON.parse(raw); } catch { return json(400, { type: 'action_result', status: 'failed', reason: 'invalid' }); }
        const r = act(b); json(r.reason === 'invalid' ? 400 : 200, r); });
      return true;
    }
    json(404, { ok: false, error: 'not_found' }); return true;
  }

  /* ---------- websocket ---------- */
  function welcome(ws, hello) {
    ws.v2 = true;
    send(ws, { type: 'welcome', version: 2, surface_id: 'mock-surface', follow: { contact: 'chris', channel: 'telegram:peggy' }, latest_seq: 0, reset: false, server_time: nowIso(), device_id: 'mock-surface-legacy', scope: 'interactive', revs: { ...revs } });
  }
  /** Resume frames after the v1 durable replay: delta from the device's rev, a reset when it has none or is ahead. */
  function resume(ws, held = {}) {
    for (const r of RESOURCES) {
      const have = held[r];
      if (have === revs[r]) continue;
      if (typeof have !== 'number') { if (revs[r] > 0) send(ws, { type: 'delta', resource: r, rev: revs[r], reset: true, items: items[r] }); continue; }
      if (have > revs[r]) { send(ws, { type: 'delta', resource: r, rev: revs[r], reset: true, items: items[r] }); continue; }
      const gap = logs[r].filter((l) => l.rev > have);
      if (gap.length && gap[0].rev === have + 1) send(ws, { type: 'delta', resource: r, base_rev: have, rev: revs[r], ops: gap.flatMap((l) => l.ops) });
      else send(ws, { type: 'delta', resource: r, rev: revs[r], reset: true, items: items[r] });
    }
  }
  function frame(ws, f) {
    if (f.type === 'view') { ws.view = typeof f.view === 'string' ? f.view : null; return true; }
    return false;
  }
  return { http, typed, welcome, resume, frame, mutate, state: () => ({ revs, items }) };
}
