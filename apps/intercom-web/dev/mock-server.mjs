// Dev-only mock of the Intercom backend contract (docs/INTERCOM_WEB.md).
// Run: node apps/intercom-web/dev/mock-server.mjs   (PORT=3098, needs `ws` from the repo's node_modules)
// Pair with code "demo-code". Typing "long: ..." returns a long reply; "/revoke" closes with 4401.
// Notifications (E89): a sample one appears ~2.5 s after connect. Type `notify: Title` (attention, 2 actions),
// `notify!: Title` (urgent, 3 actions), `note: Title` (info) to raise more; `clear:` resolves them all.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3098);
const TOKEN = 'mock-token-0123456789abcdef0123456789abcdef';
const GRACE_MS = 5000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function iso(d) {
  const p = (n) => String(n).padStart(2, '0'); const off = -d.getTimezoneOffset(); const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
function calendar() {
  const now = new Date(); const day = new Date(now); day.setHours(0, 0, 0, 0);
  const at = (h) => iso(new Date(day.getTime() + h * 3600e3));
  const ev = (id, title, s, e, calendar, color) => ({ id, title, start: at(s), end: at(e), all_day: false, calendar, color });
  const h = now.getHours() + now.getMinutes() / 60;
  return { date: iso(day).slice(0, 10), tz, generated_at: now.toISOString(), events: [
    ev('1', 'Busy', 9, 11, 'Work', '#8e8e93'), ev('2', 'Busy', 13, 15, 'Work', '#8e8e93'),
    ev('3', 'Dentist', Math.min(23, h + 1.5), Math.min(24, h + 2.25), 'Home', '#ffb347'),
    ev('4', 'J practice', Math.min(22, h + 3), Math.min(23, h + 4), 'J Sports', '#74c978'),
    ev('5', 'Celtics', 19.5, 22, 'Boston Celtics', '#5fc0b3'),
    { id: '6', title: 'Gracie dance recital', all_day: true, start: at(0), end: at(24), calendar: 'Kids', color: '#e39aab' },
  ] };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (u.pathname === '/api/v1/intercom/pair' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      try { const { code } = JSON.parse(b); return code === 'demo-code' ? json(200, { surface_id: 'mock-surface', token: TOKEN }) : json(404, { error: 'not_found' }); } catch { return json(400, { error: 'bad_request' }); }
    }); return;
  }
  if (u.pathname === '/api/v1/intercom/today') return authed ? json(200, calendar()) : json(401, {});
  if (u.pathname === '/api/v1/intercom/health') return authed ? json(200, { surface_id: 'mock-surface', follow: { contact: 'chris', channel: 'telegram:peggy' }, version: 'mock', connected_clients: wss.clients.size }) : json(401, {});
  if (u.pathname === '/intercom') { res.writeHead(301, { Location: '/intercom/' }); return res.end(); }
  if (u.pathname.startsWith('/intercom/')) {
    let rel = decodeURIComponent(u.pathname.slice('/intercom/'.length)) || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/api/v1/intercom/ws') return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
});

let seq = 0; const durable = []; const seen = new Map();
const out = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const bcast = (event, data, isDurable = false) => {
  const f = { type: 'event', event, data }; if (isDurable) { f.seq = ++seq; durable.push(f); }
  wss.clients.forEach((c) => c.authed && out(c, f));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const notes = new Map(); let nseq = 0;
const nowIso = () => new Date().toISOString();
function attention() {
  const act = [...notes.values()].filter((n) => n.state === 'active');
  const rank = { info: 1, attention: 2, urgent: 3 };
  const level = act.reduce((m, n) => (rank[n.level] > (rank[m] || 0) ? n.level : m), 'none');
  return { level, count: act.length };
}
const sendAttention = (ws) => (ws ? out(ws, { type: 'event', event: 'attention', data: attention() }) : bcast('attention', attention()));
function raise(title, { body = '', level = 'attention', actions = [{ label: 'Leaving now', style: 'success' }, { label: 'Snooze 10' }], source = 'Mock' } = {}) {
  const id = `n-${++nseq}`; const t = nowIso();
  const n = { id, key: null, title: title.slice(0, 60), body, level, state: 'active', actions, source, created_at: t, updated_at: t, expires_at: null };
  notes.set(id, n); bcast('notification', n, true); sendAttention(); return n;
}
function setState(n, state) { n.state = state; n.updated_at = nowIso(); bcast('notification', n, true); if (state === 'resolved') notes.delete(n.id); sendAttention(); }
function typedNotify(body) {
  const m = body.match(/^(notify!|notify|note):\s*(.*)$/i); if (!m) return false;
  const kind = m[1].toLowerCase(); const title = m[2] || 'Something needs you';
  if (kind === 'notify!') raise(title, { level: 'urgent', body: 'Please look at this now', actions: [{ label: 'On it', style: 'success' }, { label: 'Snooze 10' }, { label: 'Not today', style: 'danger' }] });
  else if (kind === 'note') raise(title, { level: 'info', body: 'For your information', actions: [] });
  else raise(title, { body: 'Leave by 3:45', actions: [{ label: 'Thanks', style: 'success' }, { label: 'Snooze 10' }] });
  return true;
}

async function handleSend(body, iid = `int-${Date.now()}`) {
  bcast('interaction', { interaction_id: iid, state: 'open' });
  bcast('activity', { state: 'running', status_text: null, interaction_id: iid });
  await wait(1200); bcast('activity', { state: 'running', status_text: 'Checking the calendar', interaction_id: iid });
  await wait(1800); bcast('activity', { state: 'running', status_text: 'Drafting a reply', interaction_id: iid });
  await wait(1500);
  const long = /^long:/i.test(body);
  const text = long
    ? 'Three things in the book today.\n\n- 9:00 Busy (work)\n- 1:00 Busy (work)\n- Dentist at 4:10, leave by 3:45\n\n' + 'Mrs. Patten also rang about the weekend plans, and the water bill of $166 comes due Friday. '.repeat(14)
    : 'You have a dentist appointment at 4:10. Shall I put a note on your desk for 3:45?';
  bcast('reply', { message_id: `m-${seq + 1}`, interaction_id: iid, glance: long ? 'Three things in the book today.' : 'Dentist at 4:10. Note on your desk for 3:45?', body: text.slice(0, 1200), has_attachments: false, more_on_telegram: long, created_at: new Date().toISOString() }, true);
  bcast('activity', { state: 'idle', status_text: null, interaction_id: null });
  await wait(GRACE_MS); bcast('interaction', { interaction_id: iid, state: 'closed' });
}

wss.on('connection', (ws) => {
  const t = setTimeout(() => ws.close(4401), 5000);
  const ping = setInterval(() => out(ws, { type: 'ping' }), 30000);
  ws.on('close', () => { clearTimeout(t); clearInterval(ping); });
  ws.on('message', (raw) => {
    let f; try { f = JSON.parse(raw); } catch { return out(ws, { type: 'error', code: 'invalid_frame' }); }
    if (f.type === 'hello') {
      if (f.token !== TOKEN) return ws.close(4401);
      clearTimeout(t); ws.authed = true;
      const reset = f.cursor > seq;
      out(ws, { type: 'welcome', version: 1, surface_id: 'mock-surface', follow: { contact: 'chris', channel: 'telegram:peggy' }, latest_seq: seq, reset, server_time: new Date().toISOString() });
      if (!reset) durable.filter((e) => e.seq > f.cursor).forEach((e) => out(ws, e));
      out(ws, { type: 'event', event: 'activity', data: { state: 'idle', status_text: null, interaction_id: null } });
      out(ws, { type: 'event', event: 'calendar', data: calendar() });
      for (const n of notes.values()) if (n.state !== 'resolved' && n.state !== 'expired') out(ws, { type: 'event', event: 'notification', data: n });
      sendAttention(ws);
      setTimeout(() => { if (![...notes.values()].length) raise('Leave for the dentist', { body: 'Dr. Alvarez at 9:00, 18 min drive', actions: [{ label: 'Leaving now', style: 'success' }, { label: 'Snooze 10' }] }); }, 2500);
    } else if (!ws.authed) { out(ws, { type: 'error', code: 'unauthorized' }); }
    else if (f.type === 'notification_ack') {
      const n = notes.get(f.id);
      if (!n || n.state === 'resolved') return out(ws, { type: 'error', code: 'notification_not_found' });
      if (n.state === 'active') setState(n, 'acknowledged');
    } else if (f.type === 'notification_action') {
      if (seen.has(f.client_msg_id)) return out(ws, seen.get(f.client_msg_id));
      const n = notes.get(f.id); const a = n && n.actions[f.index];
      if (!n || !a) return out(ws, { type: 'error', code: 'notification_not_found' });
      const iid = `int-${Date.now()}`;
      const ack = { type: 'ack', client_msg_id: f.client_msg_id, status: 'queued', message_id: `in-${Date.now()}`, interaction_id: iid };
      seen.set(f.client_msg_id, ack); out(ws, ack);
      if (n.state === 'active') setState(n, 'acknowledged');
      handleSend(`[tapped] ${a.label}`, iid);
    } else if (f.type === 'send') {
      if (f.body === '/revoke') return ws.close(4401);
      if (/^clear:/i.test(f.body || '')) { out(ws, { type: 'ack', client_msg_id: f.client_msg_id, status: 'queued', message_id: `in-${Date.now()}`, interaction_id: 'x' }); for (const n of [...notes.values()]) setState(n, 'resolved'); return; }
      if (typedNotify(f.body || '')) return out(ws, { type: 'ack', client_msg_id: f.client_msg_id, status: 'queued', message_id: `in-${Date.now()}`, interaction_id: 'x' });
      if (seen.has(f.client_msg_id)) return out(ws, seen.get(f.client_msg_id));
      const iid = `int-${Date.now()}`;
      const ack = !f.body || f.body.length > 4000 ? { type: 'ack', client_msg_id: f.client_msg_id, status: 'rejected', reason: 'invalid_body' } : { type: 'ack', client_msg_id: f.client_msg_id, status: 'queued', message_id: `in-${Date.now()}`, interaction_id: iid };
      seen.set(f.client_msg_id, ack); out(ws, ack);
      if (ack.status === 'queued') handleSend(f.body, iid);
    } else if (f.type === 'ping') out(ws, { type: 'pong' });
  });
});
setInterval(() => wss.clients.forEach((c) => c.authed && out(c, { type: 'event', event: 'calendar', data: calendar() })), 300000);
server.listen(PORT, () => console.log(`intercom mock on http://localhost:${PORT}/intercom/  (pair code: demo-code)`));
