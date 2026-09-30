import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { AppConfig } from '../config/schema.js';
import type { MessageQueue } from '../core/queue.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { AppAdapter, AppActivityEvent } from '../adapters/app.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { HeadlessCapacitySnapshot } from '../adapters/cc-headless.js';
import { persistAttachmentBuffer, resolveMediaConfig } from '../media/attachments.js';
import { patchThreadMetadata } from '../pipeline/thread-store.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { channelMatches } from '../pipeline/types.js';
import { createAppSession, eventBounds, history, listSessions, readEvents, recordSessionEvent, routedAgent, sessionInfo, visibleSession } from '../app/store.js';
import { sessionCanResume } from '../app/resume.js';
import { VERSION } from '../version.js';
import type { InboundAbort, InboundMessage, InboundResult } from './api.js';

interface SocketLike { send(data: string): void; close(code?: number): void; on(event: string, listener: (...args: any[]) => void): void; readyState: number; ping(): void }
interface Client { socket: SocketLike; contactId: string; agentId: string; cursor: number; ready: boolean; lastPong: number }
export interface AppRouteDeps {
  config: AppConfig; db: Database.Database; app: AppAdapter;
  queue: MessageQueue;
  commandRegistry?: CommandRegistry;
  getHeadlessSnapshots?: () => HeadlessCapacitySnapshot[];
  submitInbound: (message: InboundMessage) => Promise<InboundResult | InboundAbort>;
}

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('new'), title: z.string().max(120).optional() }),
  z.object({ kind: z.literal('session'), session_id: z.string().uuid() }),
]);
const Send = z.object({ type: z.literal('send'), client_msg_id: z.string().uuid(), target: Target,
  body: z.string().default(''), attachment_ids: z.array(z.string().uuid()).default([]) })
  .refine(v => v.body.trim().length > 0 || v.attachment_ids.length > 0);

interface StoredIntent {
  message_id: string; topic: string; session_id: string | null; body: string;
  original_channel?: string;
  attachments: InboundMessage['attachments']; agent_id: string; adapter_id: string;
}

function asNumber(input: unknown, fallback: number, max: number): number {
  const n = Number(input);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export async function registerAppRoutes(server: FastifyInstance, deps: AppRouteDeps): Promise<{ activity: (event: AppActivityEvent) => void }> {
  const cfg = deps.config.adapters.app;
  if (!cfg?.enabled) return { activity: () => {} };
  await server.register(websocket);
  const byToken = new Map<string, string>();
  for (const contact of Object.values(deps.config.contacts)) {
    const token = contact.platforms.app?.token;
    if (token) byToken.set(token, contact.id);
  }
  const clients = new Set<Client>();
  const sendLocks = new Map<string, Promise<void>>();
  const currentActivity = new Map<string, AppActivityEvent>();
  const send = (socket: SocketLike, frame: Record<string, unknown>) => {
    try { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); }
    catch { /* A disconnected socket catches up from its committed cursor. */ }
  };
  const agentFor = (contactId: string) => routedAgent(deps.config, contactId);
  const authenticate = (req: FastifyRequest): string | null => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return byToken.get(header.slice(7)) ?? null;
  };
  const drain = (client: Client) => {
    if (!client.ready || client.socket.readyState !== 1) return;
    const high = eventBounds(deps.db, client.contactId).latest;
    for (const e of readEvents(deps.db, client.contactId, client.agentId, client.cursor, high, deps.config)) {
      let data = e.data;
      if (e.event === 'session') {
        const row = deps.db.prepare('SELECT conversation_id FROM sessions WHERE id = ?').get(data['session_id']) as {conversation_id:string}|undefined;
        const activity = row && currentActivity.get(`${client.agentId}:${row.conversation_id}`);
        data = { ...data, activity: activity?.state ?? 'idle' };
      }
      send(client.socket, { type: 'event', seq: e.seq, event: e.event, data });
    }
    client.cursor = high;
  };
  const recoverSend = async (contactId: string, clientMsgId: string, intent: StoredIntent): Promise<Record<string, unknown>> => {
    const queued = deps.db.prepare('SELECT 1 FROM message_queue WHERE id = ?').get(intent.message_id);
    const transcript = deps.db.prepare(`SELECT session_id,created_at FROM transcripts
      WHERE message_id = ? AND direction = 'inbound' ORDER BY rowid DESC LIMIT 1`)
      .get(intent.message_id) as {session_id:string;created_at:string}|undefined;
    let status: 'queued' | 'command' | 'rejected'; let reason: string | undefined;
    if (queued) status = 'queued';
    else if (transcript && intent.body.trimStart().startsWith('/')) {
      const response = deps.db.prepare(`SELECT 1 FROM transcripts WHERE session_id = ? AND direction = 'outbound'
        AND json_extract(metadata,'$.command_source_message_id') = ? LIMIT 1`)
        .get(transcript.session_id, intent.message_id);
      status = response ? 'command' : 'rejected';
      if (!response) reason = 'Command outcome is ambiguous after restart; inspect history before retrying with a new ID';
    } else if (transcript) {
      const bound = intent.session_id ? deps.db.prepare(`SELECT s.conversation_id, cr.channel, cr.topic
        FROM sessions s JOIN conversation_registry cr ON cr.id=s.conversation_id WHERE s.id=?`)
        .get(intent.session_id) as {conversation_id:string;channel:string;topic:string}|undefined : undefined;
      const envelope: MessageEnvelope = { id: intent.message_id, timestamp: transcript.created_at,
        channel: 'app', topic: intent.topic, sender: `contact:${contactId}`, recipient: intent.agent_id,
        reply_to: null, priority: 'normal', payload: { type: 'text', body: intent.body },
        metadata: { source: 'app', client_msg_id: clientMsgId, adapter_id: intent.adapter_id,
          ...(intent.session_id ? { bound_session_id: intent.session_id } : {}),
          conversation_id: bound?.conversation_id ?? computeConversationId(contactId, 'app', intent.topic),
          ...(bound ? { session_channel: intent.original_channel ?? bound.channel, session_topic: bound.topic } : {}),
          attachments: intent.attachments ?? [] } };
      deps.queue.enqueue(envelope);
      status = 'queued';
    } else {
      const result = await deps.submitInbound({ id: intent.message_id, channel: 'app', topic: intent.topic,
        sender: `contact:${contactId}`, payload: { type: 'text', body: intent.body },
        attachments: intent.attachments, metadata: { source: 'app', client_msg_id: clientMsgId,
          ...(intent.session_id ? { bound_session_id: intent.session_id } : {}),
          ...(intent.original_channel ? { resumed_from_channel: intent.original_channel } : {}) } });
      status = result.queued && result.enqueued_count > 0 ? 'queued'
        : !result.queued && result.reason === 'command_handled' ? 'command' : 'rejected';
      reason = status === 'rejected' ? result.queued ? 'No route accepted the message' : result.reason : undefined;
    }
    const resolvedSession = intent.session_id ?? transcript?.session_id ?? (deps.db.prepare(`SELECT s.id FROM sessions s
      JOIN conversation_registry cr ON cr.id = s.conversation_id
      WHERE cr.contact_id = ? AND cr.channel = 'app' AND cr.topic = ? AND s.ended_at IS NULL
      ORDER BY s.started_at DESC LIMIT 1`).get(contactId, intent.topic) as {id:string}|undefined)?.id ?? intent.session_id;
    const ack: Record<string, unknown> = { type: 'ack', client_msg_id: clientMsgId,
      message_id: intent.message_id, session_id: resolvedSession,
      status, ...(reason ? { reason } : {}) };
    deps.db.prepare('UPDATE app_sends SET ack_json = ? WHERE contact_id = ? AND client_msg_id = ?')
      .run(JSON.stringify(ack), contactId, clientMsgId);
    return ack;
  };
  // Finish sends interrupted between durable claim, transcript, queue and ack.
  // This runs before the listener accepts requests; client retry uses the same
  // recovery path if a send fails while the process stays up.
  const unfinished = deps.db.prepare(`SELECT contact_id,client_msg_id,intent_json FROM app_sends
    WHERE json_extract(ack_json,'$.status') = 'pending' AND intent_json IS NOT NULL`)
    .all() as {contact_id:string;client_msg_id:string;intent_json:string}[];
  for (const row of unfinished) {
    try { await recoverSend(row.contact_id, row.client_msg_id, JSON.parse(row.intent_json) as StoredIntent); }
    catch (error) { console.error(`[app] pending send recovery failed id=${row.client_msg_id.slice(0, 8)}: ${String(error)}`); }
  }
  const eventTimer = setInterval(() => {
    for (const client of clients) drain(client);
  }, 100);
  eventTimer.unref();
  const sweepRetention = () => {
    const cutoff = new Date(Date.now() - cfg.event_retention_days * 86_400_000).toISOString();
    deps.db.prepare('DELETE FROM app_events WHERE created_at < ?').run(cutoff);
  };
  sweepRetention();
  const retentionTimer = setInterval(sweepRetention, 60 * 60 * 1000);
  retentionTimer.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (Date.now() - client.lastPong > 2 * cfg.ping_interval_ms) client.socket.close(1001);
      else if (client.socket.readyState === 1) client.socket.ping();
    }
  }, cfg.ping_interval_ms);
  heartbeat.unref();
  server.addHook('onClose', async () => { clearInterval(eventTimer); clearInterval(heartbeat); clearInterval(retentionTimer); });

  // One scoped guard covers every app HTTP route and the socket upgrade.
  await server.register(async (routes) => {
    routes.addHook('onRequest', async (req, reply) => {
      if (!authenticate(req)) return reply.code(401).send({ ok: false, error: 'Unauthorized' });
    });

    routes.get('/api/v1/app/health', async (req) => {
      const contact = authenticate(req)!;
      const agent = agentFor(contact);
      return { ok: true, contact: `contact:${contact}`, agent, routed: !!agent,
        adapter: 'online', version: VERSION, concurrency: deps.getHeadlessSnapshots?.() ?? [],
        limits: { max_upload_bytes: cfg.max_upload_bytes, event_retention_days: cfg.event_retention_days } };
    });
    routes.get('/api/v1/app/commands', async () => ({ commands: deps.commandRegistry?.manifests() ?? deps.app.commandManifest() }));
    routes.get('/api/v1/app/sessions', async (req, reply) => {
      const contact = authenticate(req)!; const agent = agentFor(contact);
      if (!agent) return reply.code(422).send({ error: 'No app agent route for this contact' });
      const q = req.query as Record<string, unknown>;
      const state = ['active', 'earlier', 'all'].includes(String(q['state'])) ? String(q['state']) : 'all';
      const sessions = listSessions(deps.db, contact, agent, state, asNumber(q['limit'], 50, 100), typeof q['before'] === 'string' ? q['before'] : undefined, deps.config);
      const projected: Record<string, unknown>[] = sessions.map(item => {
        const row = deps.db.prepare('SELECT conversation_id FROM sessions WHERE id = ?').get(item['session_id']) as {conversation_id:string};
        const activity = currentActivity.get(`${agent}:${row.conversation_id}`);
        return { ...item, activity: activity?.state ?? 'idle' };
      });
      return { sessions: projected, next_before: projected.length ? projected[projected.length - 1]!['session_id'] : null };
    });
    routes.get('/api/v1/app/sessions/:id/messages', async (req, reply) => {
      const contact = authenticate(req)!; const agent = agentFor(contact);
      if (!agent) return reply.code(404).send({ error: 'Session not found' });
      const { id } = req.params as { id: string }; const q = req.query as Record<string, unknown>;
      const messages = history(deps.db, contact, agent, id, asNumber(q['limit'], 50, 100), typeof q['before'] === 'string' ? q['before'] : undefined);
      return messages ? { messages, next_before: messages.length ? messages[0]!['cursor'] : null }
        : reply.code(404).send({ error: 'Session not found' });
    });
    routes.post('/api/v1/app/attachments', async (req, reply) => {
      const contact = authenticate(req)!; const agent = agentFor(contact);
      if (!agent) return reply.code(422).send({ error: 'No app agent route for this contact' });
      const media = resolveMediaConfig(deps.config, 'app');
      if (!media || media.agentId !== agent) return reply.code(422).send({ error: `Configure media.download_path for ${agent} to enable uploads` });
      try {
        const part = await req.file({ limits: { files: 1, fileSize: cfg.max_upload_bytes } });
        if (!part) return reply.code(422).send({ error: 'Upload a file using multipart/form-data' });
        const content = await part.toBuffer();
        if (content.length > cfg.max_upload_bytes) return reply.code(413).send({ error: `File exceeds ${cfg.max_upload_bytes} bytes` });
        const filename = part.filename.replace(/[/\\]/g, '_').slice(0, 255);
        const saved = persistAttachmentBuffer(deps.db, media, content, { mime_type: part.mimetype, original_filename: filename });
        deps.db.prepare(`INSERT INTO app_uploads(attachment_id,contact_id,agent_id,size) VALUES (?,?,?,?)`).run(saved.id, contact, agent, content.length);
        return { id: saved.id, type: part.mimetype.startsWith('image/') ? 'image' : 'file', mime_type: part.mimetype,
          original_filename: filename, size: content.length };
      } catch (err) {
        const code = (err as {code?:string}).code;
        return reply.code(code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' ? 413 : 422)
          .send({ error: code === 'FST_REQ_FILE_TOO_LARGE' ? `File exceeds ${cfg.max_upload_bytes} bytes` : 'Invalid multipart upload' });
      }
    });

    routes.get('/api/v1/app/ws', { websocket: true }, (socket, req) => {
      const contactId = authenticate(req)!;
      const agentId = agentFor(contactId);
      if (!agentId) { socket.close(1008); return; }
      const client: Client = { socket, contactId, agentId, cursor: 0, ready: false, lastPong: Date.now() };
      clients.add(client);
      socket.on('close', () => clients.delete(client));
      socket.on('pong', () => { client.lastPong = Date.now(); });
      socket.on('message', (raw: Buffer) => { void (async () => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(raw.toString()) as Record<string, unknown>; }
        catch { send(socket, { type: 'error', code: 'invalid_json' }); return; }
        if (frame['type'] === 'ping') { send(socket, { type: 'pong' }); return; }
        if (frame['type'] === 'hello') {
          const cursor = Number(frame['cursor'] ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0) { send(socket, { type: 'error', code: 'invalid_cursor' }); return; }
          const bounds = eventBounds(deps.db, contactId);
          const reset = cursor > 0 && (cursor < bounds.first - 1 || cursor > bounds.latest);
          client.cursor = reset ? bounds.latest : cursor;
          client.ready = true;
          send(socket, { type: 'welcome', version: 1, reset, latest_seq: bounds.latest });
          if (!reset) drain(client);
          for (const activity of currentActivity.values()) {
            if (activity.agent_id === agentId && visibleSessionByConversation(deps.db, contactId, agentId, activity.conversation_id))
              send(socket, { type: 'event', event: 'activity', data: activity });
          }
          return;
        }
        if (!client.ready) { send(socket, { type: 'error', code: 'hello_required' }); return; }
        if (frame['type'] === 'send') {
          const parsed = Send.safeParse(frame);
          if (!parsed.success) { send(socket, { type: 'error', code: 'invalid_send' }); return; }
          const f = parsed.data;
          const lockKey = `${contactId}:${f.client_msg_id}`;
          while (sendLocks.has(lockKey)) await sendLocks.get(lockKey);
          let release!: () => void;
          sendLocks.set(lockKey, new Promise<void>(resolve => { release = resolve; }));
          try {
          const existing = deps.db.prepare('SELECT ack_json,intent_json FROM app_sends WHERE contact_id = ? AND client_msg_id = ?')
            .get(contactId, f.client_msg_id) as {ack_json:string;intent_json:string|null}|undefined;
          if (existing) {
            let ack = JSON.parse(existing.ack_json) as Record<string, unknown>;
            if (ack['status'] === 'pending' && existing.intent_json)
              ack = await recoverSend(contactId, f.client_msg_id, JSON.parse(existing.intent_json) as StoredIntent);
            send(socket, ack); drain(client); return;
          }
          let topic = 'general'; let sessionId: string | null = null;
          let earlierTarget: ReturnType<typeof visibleSession> = null;
          if (f.target.kind === 'session') {
            const target = visibleSession(deps.db, contactId, agentId, f.target.session_id);
            if (!target) {
              send(socket, { type: 'ack', client_msg_id: f.client_msg_id, status: 'rejected', reason: 'session_not_found' }); return;
            }
            if (target.ended_at) {
              if (!sessionCanResume(deps.db, deps.config, target.id)) {
                send(socket, { type: 'ack', client_msg_id: f.client_msg_id, status: 'rejected', reason: 'not_resumable' }); return;
              }
              earlierTarget = target;
            } else { topic = target.topic; sessionId = target.id; }
          }
          const attachments: NonNullable<InboundMessage['attachments']> = [];
          for (const id of f.attachment_ids) {
            const row = deps.db.prepare(`SELECT a.* FROM attachments a JOIN app_uploads u ON u.attachment_id = a.id
              WHERE a.id = ? AND u.contact_id = ? AND u.agent_id = ? AND a.expires_at > ?`)
              .get(id, contactId, agentId, Date.now()) as {local_path:string;mime_type:string|null;original_filename:string|null}|undefined;
            if (!row) { send(socket, { type: 'ack', client_msg_id: f.client_msg_id, status: 'rejected', reason: 'Unknown or expired attachment' }); return; }
            attachments.push({ id, type: row.mime_type?.startsWith('image/') ? 'image' as const : 'file' as const,
              local_path: row.local_path, mime_type: row.mime_type ?? undefined, original_filename: row.original_filename ?? undefined });
          }
          const messageId = randomUUID();
          deps.db.transaction(() => {
            if (f.target.kind === 'new') {
              const created = createAppSession(deps.db, contactId, agentId, f.target.title);
              topic = created.topic; sessionId = created.sessionId;
            } else if (earlierTarget) {
              const originalTitle = String(sessionInfo(deps.db, earlierTarget, contactId, deps.config)['title'] ?? 'Conversation');
              const created = createAppSession(deps.db, contactId, agentId, `${originalTitle} (resumed)`);
              const old = deps.db.prepare('SELECT claude_session_id FROM sessions WHERE id = ?')
                .get(earlierTarget.id) as {claude_session_id:string};
              deps.db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(old.claude_session_id, created.sessionId);
              topic = created.topic; sessionId = created.sessionId;
            }
            const route = deps.config.pipeline.routes.find(r =>
              (!r.match.sender || r.match.sender === `contact:${contactId}`) &&
              (!r.match.channel || channelMatches(r.match.channel, 'app')) &&
              (!r.match.topic || r.match.topic === topic));
            const intent: StoredIntent = { message_id: messageId, topic, session_id: sessionId, body: f.body,
              attachments, agent_id: agentId,
              ...(earlierTarget ? { original_channel: earlierTarget.channel } : {}),
              adapter_id: route?.target.adapterId ?? 'cc-headless' };
            const pending = { type: 'ack', client_msg_id: f.client_msg_id, message_id: messageId, session_id: sessionId, status: 'pending' };
            deps.db.prepare(`INSERT INTO app_sends(contact_id,client_msg_id,ack_json,intent_json,created_at)
              VALUES (?,?,?,?,?)`).run(contactId, f.client_msg_id, JSON.stringify(pending), JSON.stringify(intent), new Date().toISOString());
          })();
          const result = await deps.submitInbound({ id: messageId, channel: 'app', topic, sender: `contact:${contactId}`,
            payload: { type: 'text', body: f.body }, attachments, metadata: { source: 'app', client_msg_id: f.client_msg_id,
              ...(sessionId ? { bound_session_id: sessionId } : {}),
              ...(earlierTarget ? { resumed_from_channel: earlierTarget.channel } : {}) } });
          if (!sessionId) {
            sessionId = (deps.db.prepare(`SELECT s.id FROM sessions s JOIN conversation_registry cr ON cr.id=s.conversation_id
              WHERE cr.contact_id=? AND cr.channel='app' AND cr.topic=? AND s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`)
              .get(contactId, topic) as {id:string}|undefined)?.id ?? null;
          }
          const ack = { type: 'ack', client_msg_id: f.client_msg_id, message_id: messageId, session_id: sessionId,
            status: result.queued && result.enqueued_count > 0 ? 'queued' : !result.queued && result.reason === 'command_handled' ? 'command' : 'rejected',
            ...(!result.queued && result.reason !== 'command_handled' ? { reason: result.reason } :
              result.queued && result.enqueued_count === 0 ? { reason: 'No route accepted the message' } : {}) };
          deps.db.prepare('UPDATE app_sends SET ack_json = ? WHERE contact_id = ? AND client_msg_id = ?')
            .run(JSON.stringify(ack), contactId, f.client_msg_id);
          send(socket, ack); drain(client); return;
          } finally { sendLocks.delete(lockKey); release(); }
        }
        if (frame['type'] === 'create_session') {
          const created = createAppSession(deps.db, contactId, agentId, typeof frame['title'] === 'string' ? frame['title'] : undefined);
          send(socket, { type: 'ack', status: 'created', session_id: created.sessionId, request_id: frame['request_id'] }); drain(client); return;
        }
        if (frame['type'] === 'rename_session') {
          const id = String(frame['session_id'] ?? ''); const title = String(frame['title'] ?? '').trim().slice(0,120);
          const row = visibleSession(deps.db, contactId, agentId, id);
          if (!row || row.channel !== 'app' || row.topic === 'general' || !title) { send(socket, { type: 'error', code: 'session_not_found' }); return; }
          deps.db.transaction(() => {
            patchThreadMetadata(deps.db, 'app', row.topic, { title });
            recordSessionEvent(deps.db, contactId, id);
          })();
          drain(client);
          send(socket, { type: 'ack', status: 'renamed', session_id: id, request_id: frame['request_id'] }); return;
        }
        if (frame['type'] === 'mark_read') {
          const id = String(frame['session_id'] ?? ''); const seq = Number(frame['seq']);
          const event = deps.db.prepare(`SELECT 1 FROM app_events WHERE contact_id = ? AND session_id = ? AND seq = ?`)
            .get(contactId, id, seq);
          if (!visibleSession(deps.db, contactId, agentId, id) || !Number.isSafeInteger(seq) || seq < 0 || (seq !== 0 && !event)) {
            send(socket, { type: 'error', code: 'invalid_read_marker' }); return;
          }
          deps.db.transaction(() => {
            deps.db.prepare(`INSERT INTO app_read_markers(contact_id,session_id,seq) VALUES (?,?,?)
              ON CONFLICT(contact_id,session_id) DO UPDATE SET seq = max(seq,excluded.seq)`).run(contactId, id, seq);
            recordSessionEvent(deps.db, contactId, id);
          })();
          drain(client);
          send(socket, { type: 'ack', status: 'read', session_id: id, seq, request_id: frame['request_id'] }); return;
        }
        send(socket, { type: 'error', code: 'unknown_frame' });
      })().catch(() => send(socket, { type: 'error', code: 'internal_error' })); });
    });
  });

  return { activity: (event) => {
    const key = `${event.agent_id}:${event.conversation_id}`;
    if (event.state === 'idle') currentActivity.delete(key); else currentActivity.set(key, event);
    for (const client of clients) {
      if (client.ready && client.agentId === event.agent_id &&
          visibleSessionByConversation(deps.db, client.contactId, client.agentId, event.conversation_id)) {
        send(client.socket, { type: 'event', event: 'activity', data: event });
      }
    }
  } };
}

function visibleSessionByConversation(db: Database.Database, contactId: string, agentId: string, conversationId: string): boolean {
  const ids = db.prepare(`SELECT id FROM sessions WHERE conversation_id = ? AND contact_id = ? AND agent_id = ? ORDER BY started_at DESC LIMIT 3`)
    .all(conversationId, contactId, agentId) as {id:string}[];
  return ids.some(({id}) => !!visibleSession(db, contactId, agentId, id));
}
