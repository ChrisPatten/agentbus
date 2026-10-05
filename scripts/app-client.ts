/**
 * Small Node 20+ client for exercising the app channel protocol.
 *
 * APP_TOKEN=... npx tsx scripts/app-client.ts send main "Hello"
 * APP_TOKEN=... npx tsx scripts/app-client.ts watch
 * See docs/APP_ADAPTER.md for the full walkthrough.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const baseUrl = (process.env['APP_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const token = process.env['APP_TOKEN'];
const busToken = process.env['BUS_TOKEN'];
const cursorPath = resolve(process.env['APP_CURSOR_FILE'] ?? '.app-client-cursor.json');
const args = process.argv.slice(2);

function usage(): never {
  console.error(`Usage: APP_TOKEN=<contact token> [BUS_TOKEN=<bus token>] [APP_BASE_URL=http://127.0.0.1:3000] npx tsx scripts/app-client.ts <command>

Commands:
  health                           GET authenticated app health
  commands                         List slash commands
  sessions [state] [before]        List visible sessions (before is a session ID)
  history <session-id> [before]    Page messages (before is a transcript cursor)
  upload <file>                    Upload one file (PDF supported)
  send main <text>                 Send to Main
  send new <text> [title]          Create a topic and send its first message
  send session:<uuid> <text>       Send to an active app session
  send-file <target> <id> [text]   Send a previously uploaded attachment
  watch [cursor]                  Replay from cursor, then follow live events
  create [title]                  Create an empty app topic
  rename <session-id> <title>     Rename an app topic
  read <session-id> <seq>         Mark a session read
  bad-token                       Check that an invalid token gets HTTP 401

Environment: APP_CURSOR_FILE defaults to .app-client-cursor.json. watch and send
save the latest durable event sequence there. Use APP_CURSOR_FILE for separate
test contacts. Ctrl-C disconnects watch; run it again to check replay.`);
  process.exit(2);
}

function headers(overrideToken = token): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${overrideToken ?? ''}` };
  if (busToken) h['X-Bus-Token'] = busToken;
  return h;
}

async function request(path: string, init: RequestInit = {}, overrideToken = token): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/v1/app${path}`, {
    ...init, headers: { ...headers(overrideToken), ...init.headers },
  });
  const body = await response.json().catch(() => ({ error: 'non-JSON response' })) as unknown;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function readCursor(): Promise<number> {
  try {
    const saved = JSON.parse(await readFile(cursorPath, 'utf8')) as { cursor?: unknown };
    return typeof saved.cursor === 'number' && Number.isSafeInteger(saved.cursor) && saved.cursor >= 0 ? saved.cursor : 0;
  } catch { return 0; }
}

let lastSaved = -1;
async function saveCursor(cursor: number): Promise<void> {
  if (cursor <= lastSaved) return;
  lastSaved = cursor;
  await writeFile(cursorPath, JSON.stringify({ cursor }, null, 2) + '\n', { mode: 0o600 });
}

type Frame = Record<string, unknown> & { type: string };

function socketUrl(): string {
  const url = new URL(`${baseUrl}/api/v1/app/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const ws = new WebSocket(socketUrl(), { headers: headers() });
    ws.once('open', () => resolveSocket(ws));
    ws.once('error', reject);
  });
}

function asFrame(raw: WebSocket.RawData): Frame | null {
  try {
    const value = JSON.parse(raw.toString()) as unknown;
    return value && typeof value === 'object' && 'type' in value ? value as Frame : null;
  } catch { return null; }
}

async function socketCommand(outgoing?: Frame, follow = false, requestedCursor?: number): Promise<void> {
  const ws = await openSocket();
  const cursor = requestedCursor ?? await readCursor();
  let latest = cursor;
  let sent = false;
  let finished = false;
  let saveTail = Promise.resolve();
  const close = () => { if (!finished) { finished = true; ws.close(); } };
  const timeout = follow ? undefined : setTimeout(close, Number(process.env['APP_WAIT_MS'] ?? 15000));
  ws.on('message', (raw) => {
    const frame = asFrame(raw);
    if (!frame) { console.error('Invalid JSON frame from server'); return; }
    console.log(JSON.stringify(frame));
    if (frame.type === 'welcome') {
      if (frame.reset === true) {
        // A stale cursor cannot be replayed. Reload sessions/history before
        // trusting the stream, then persist the server's current high water.
        console.error('Cursor expired. Reload with sessions/history; live events continue from latest_seq.');
        latest = Number(frame.latest_seq ?? 0);
        saveTail = saveTail.then(() => saveCursor(latest));
      }
      if (outgoing && !sent) { ws.send(JSON.stringify(outgoing)); sent = true; }
    } else if (frame.type === 'event' && Number.isSafeInteger(frame.seq)) {
      latest = Math.max(latest, Number(frame.seq));
      saveTail = saveTail.then(() => saveCursor(latest));
    } else if (frame.type === 'ack' && !follow) {
      setTimeout(close, Number(process.env['APP_AFTER_ACK_MS'] ?? 3000));
    } else if (frame.type === 'error' && !follow) {
      close();
    }
  });
  ws.send(JSON.stringify({ type: 'hello', cursor }));
  if (follow) process.once('SIGINT', close);
  await new Promise<void>((resolveDone, reject) => {
    ws.once('close', () => resolveDone());
    ws.once('error', reject);
  });
  if (timeout) clearTimeout(timeout);
  await saveTail;
}

function parseTarget(input: string | undefined): Record<string, string> {
  if (input === 'main') return { kind: 'main' };
  if (input === 'new') return { kind: 'new' };
  if (input?.startsWith('session:')) return { kind: 'session', session_id: input.slice('session:'.length) };
  usage();
}

async function main(): Promise<void> {
  const command = args[0];
  if (!command) usage();
  if (command === 'bad-token') {
    const response = await fetch(`${baseUrl}/api/v1/app/health`, { headers: headers(`invalid-${randomUUID()}`) });
    console.log(`HTTP ${response.status}`);
    if (response.status !== 401) throw new Error('Expected HTTP 401 for a bad token');
    return;
  }
  if (!token) throw new Error('Set APP_TOKEN to the contact app token');
  if (command === 'health' || command === 'commands') {
    console.log(JSON.stringify(await request(`/${command}`), null, 2)); return;
  }
  if (command === 'sessions') {
    const state = args[1] ?? 'all';
    if (!['active', 'earlier', 'all'].includes(state)) usage();
    const before = args[2] ? `&before=${encodeURIComponent(args[2])}` : '';
    console.log(JSON.stringify(await request(`/sessions?state=${state}${before}`), null, 2)); return;
  }
  if (command === 'history') {
    if (!args[1]) usage();
    const before = args[2] ? `?before=${encodeURIComponent(args[2])}` : '';
    console.log(JSON.stringify(await request(`/sessions/${encodeURIComponent(args[1])}/messages${before}`), null, 2)); return;
  }
  if (command === 'upload') {
    if (!args[1]) usage();
    const path = resolve(args[1]);
    const file = await readFile(path);
    const name = basename(path);
    const mime = extname(name).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([file], { type: mime }), name);
    console.log(JSON.stringify(await request('/attachments', { method: 'POST', body: form }), null, 2)); return;
  }
  if (command === 'watch') {
    const cursor = args[1] === undefined ? undefined : Number(args[1]);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) usage();
    await socketCommand(undefined, true, cursor); return;
  }
  if (command === 'send' || command === 'send-file') {
    const target = parseTarget(args[1]);
    if (command === 'send' && !args[2]) usage();
    if (command === 'send-file' && !args[2]) usage();
    if (target.kind === 'new' && command === 'send' && args[3]) target.title = args[3];
    const frame: Frame = {
      type: 'send', client_msg_id: randomUUID(), target,
      body: command === 'send' ? args[2] : args[3] ?? '',
      attachment_ids: command === 'send-file' ? [args[2]] : [],
    };
    await socketCommand(frame); return;
  }
  if (command === 'create') {
    await socketCommand({ type: 'create_session', request_id: randomUUID(), title: args[1] ?? '' }); return;
  }
  if (command === 'rename') {
    if (!args[1] || !args[2]) usage();
    await socketCommand({ type: 'rename_session', session_id: args[1], title: args[2] }); return;
  }
  if (command === 'read') {
    if (!args[1] || !args[2]) usage();
    await socketCommand({ type: 'mark_read', session_id: args[1], seq: Number(args[2]) }); return;
  }
  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
