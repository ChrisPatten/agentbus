/**
 * HTTP API — Fastify server exposing the agentbus REST surface.
 *
 * Routes
 * ──────
 * GET  /api/v1/health                    — Liveness + adapter/queue status.
 *                                          Always open; bypasses auth.
 * GET  /api/v1/messages/pending          — Poll pending messages for an agent.
 * POST /api/v1/messages/:id/ack          — Acknowledge or dead-letter a message.
 * POST /api/v1/messages                  — Direct enqueue (MCP reply tool).
 * GET  /api/v1/messages/:id              — Fetch a single message by ID.
 * POST /api/v1/inbound                   — Inbound pipeline entry point.
 *
 * Authentication
 * ──────────────
 * When config.bus.auth_token is set, an `onRequest` hook rejects any request
 * that does not include a matching `X-Bus-Token` header with HTTP 401.
 * The health endpoint is exempt so uptime monitors do not need credentials.
 *
 * Inbound pipeline (POST /api/v1/inbound)
 * ────────────────────────────────────────
 * 1. Validates the body against InboundSchema (relaxed — pipeline fills defaults).
 *    payload.type is restricted to "text"; slash commands are not submitted
 *    directly by adapters — they are emitted by Stage 40 (slash-command) after
 *    body parsing.
 * 2. Runs the message through PipelineEngine. On abort, returns the pipeline's
 *    ctx.abortReason so the caller knows why the message was dropped.
 * 3. Fan-out: enqueues one MessageEnvelope per route target produced by Stage 70.
 *    Each fan copy gets a fresh payload shallow-clone to prevent stage mutations
 *    on one copy from corrupting another.
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { PipelineContext } from '../pipeline/types.js';
import type Database from 'better-sqlite3';
import type { CommandRegistry, SlashCommandContext } from '../commands/registry.js';
import { createSafeDatabase } from '../db/safe-database.js';

export interface HttpServerDeps {
  queue: MessageQueue;
  registry: AdapterRegistry;
  config: AppConfig;
  pipeline: PipelineEngine;
  db: Database.Database;
  /** Optional — when present, slash commands are dispatched inline */
  commandRegistry?: CommandRegistry;
  /** Optional — set of adapter IDs currently paused; mutated by /pause and /resume */
  pauseSet?: Set<string>;
}

const MessagePayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), body: z.string().min(1) }),
  z.object({
    type: z.literal('slash_command'),
    body: z.string(),
    command: z.string(),
    args_raw: z.string(),
  }),
]);

const MessageSubmitSchema = z.object({
  id: z.string().uuid().optional(),
  timestamp: z.string().optional(),
  channel: z.string().min(1),
  topic: z.string().default('general'),
  sender: z.string().min(1),
  recipient: z.string().min(1),
  reply_to: z.string().nullable().default(null),
  priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
  payload: MessagePayloadSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
  expires_at: z.string().optional().refine(
    (v) => !v || new Date(v) > new Date(),
    { message: 'expires_at must be in the future' }
  ),
});

/**
 * Relaxed schema for POST /api/v1/inbound.
 *
 * Most fields are optional here because Stage 10 (normalize) applies defaults.
 * payload.type is intentionally restricted to "text": inbound adapters submit
 * raw text; Stage 40 (slash-command) re-classifies the payload as
 * slash_command if the body starts with '/'. Accepting slash_command here
 * would let callers bypass Stage 40 detection.
 */
const InboundSchema = z.object({
  id: z.string().optional(),
  timestamp: z.string().optional(),
  channel: z.string().min(1),
  topic: z.string().optional(),
  sender: z.string().min(1),
  recipient: z.string().optional(),
  reply_to: z.string().nullable().optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  payload: z.object({ type: z.literal('text'), body: z.string().min(1) }),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Inbound pipeline processing ──────────────────────────────────────────────

export interface InboundMessage {
  id?: string;
  timestamp?: string;
  channel: string;
  topic?: string;
  sender: string;
  recipient?: string;
  reply_to?: string | null;
  priority?: 'normal' | 'high' | 'urgent';
  payload: { type: 'text'; body: string };
  metadata?: Record<string, unknown>;
}

export interface InboundResult {
  ok: true;
  queued: true;
  id: string;
  enqueued_count: number;
}

export interface InboundAbort {
  ok: true;
  queued: false;
  reason: string;
}

/**
 * Process an inbound message through the pipeline and enqueue the results.
 *
 * Extracted from the POST /api/v1/inbound handler so that both the HTTP
 * route and in-process platform adapters can share the same pipeline logic.
 */
export async function processInbound(
  message: InboundMessage,
  deps: {
    queue: MessageQueue;
    pipeline: PipelineEngine;
    config: AppConfig;
    db: Database.Database;
    registry?: AdapterRegistry;
    commandRegistry?: CommandRegistry;
    pauseSet?: Set<string>;
  },
): Promise<InboundResult | InboundAbort> {
  // Validate payload for in-process callers that bypass Zod (e.g. TelegramAdapter).
  // The HTTP route validates via InboundSchema, but processInbound is also called
  // directly. Reject non-text payloads to prevent bypassing Stage 40 detection.
  if (message.payload.type !== 'text' || !message.payload.body) {
    return { ok: true, queued: false, reason: 'invalid_payload' };
  }

  const envelope: MessageEnvelope = {
    id: message.id ?? '',
    timestamp: message.timestamp ?? '',
    channel: message.channel,
    topic: message.topic ?? '',
    sender: message.sender,
    recipient: message.recipient ?? '',
    reply_to: message.reply_to ?? null,
    priority: message.priority ?? 'normal',
    payload: message.payload as MessageEnvelope['payload'],
    metadata: message.metadata ?? {},
  };

  const ctx: PipelineContext = {
    envelope,
    contact: null,
    dedupKey: null,
    isSlashCommand: false,
    slashCommand: null,
    topics: [],
    priorityScore: 0,
    routes: [],
    conversationId: null,
    sessionId: null,
    sessionCreated: false,
    config: deps.config,
    db: deps.db,
  };

  const result = await deps.pipeline.process(ctx);

  if (!result) {
    return { ok: true, queued: false, reason: ctx.abortReason ?? 'pipeline_abort' };
  }

  // ── Slash command dispatch (post-pipeline) ───────────────────────────────
  // Slash commands are handled here, after all pipeline stages have run
  // (including transcript-log at Stage 80). Responses bypass the outbound
  // queue and are sent directly via the originating adapter.
  //
  // Paused adapters can still send slash commands — the pause check below
  // only drops non-command messages, so /resume always works.
  if (result.isSlashCommand && result.slashCommand && deps.commandRegistry) {
    const commandName = result.slashCommand.name;
    const cmd = deps.commandRegistry.lookup(commandName);

    // Determine originating adapter from the channel
    const originAdapter = deps.registry?.lookupPrimaryByChannel(result.envelope.channel);
    const adapterId = originAdapter?.id ?? 'unknown';

    const cmdCtx: SlashCommandContext = {
      channel: result.envelope.channel,
      sender: result.envelope.sender,
      adapterId,
      argsRaw: result.slashCommand.argsRaw,
      envelope: result.envelope,
      db: createSafeDatabase(deps.db),
      config: deps.config,
    };

    let responseBody: string | undefined;

    if (cmd && cmd.scope === 'bus') {
      try {
        const response = await cmd.handler(result.slashCommand.args, cmdCtx);
        responseBody = response.body;
      } catch (err) {
        responseBody = `Command error: ${String(err)}`;
      }
    } else if (!cmd) {
      responseBody = `Unknown command: /${commandName}\nType /help to see available commands.`;
    }
    // scope: 'agent' falls through to normal fan-out enqueue below

    if (responseBody !== undefined) {
      // Send response directly via the originating adapter (bypass queue)
      if (originAdapter) {
        const responseEnvelope: MessageEnvelope = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          channel: result.envelope.channel,
          topic: 'command',
          sender: 'system:bus',
          recipient: result.envelope.sender,
          reply_to: result.envelope.id,
          priority: 'normal',
          payload: { type: 'text', body: responseBody },
          metadata: { command_response: true, command: commandName },
        };

        try {
          await originAdapter.send(responseEnvelope);
        } catch (err) {
          console.error(`[inbound] Failed to send command response via ${adapterId}: ${String(err)}`);
        }

        // Log command response to transcripts for auditability.
        // Marked with command_response:true so E8/E9 can exclude from memory processing.
        if (result.sessionId && result.conversationId) {
          try {
            const now = new Date().toISOString();
            const contactId = result.envelope.sender.startsWith('contact:')
              ? result.envelope.sender.slice('contact:'.length)
              : result.envelope.sender;
            deps.db
              .prepare(
                `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))`,
              )
              .run(
                randomUUID(),
                responseEnvelope.id,
                result.conversationId,
                result.sessionId,
                now,
                result.envelope.channel,
                contactId,
                'outbound',
                responseBody,
                JSON.stringify({ command_response: true, command: commandName }),
              );
          } catch (err) {
            console.error(`[inbound] Failed to log command response transcript: ${String(err)}`);
          }
        }
      } else {
        console.warn(`[inbound] No adapter found for channel "${result.envelope.channel}" — command response not sent`);
      }

      return { ok: true, queued: false, reason: 'command_handled' };
    }
  }

  // ── Pause check (post-pipeline) ──────────────────────────────────────────
  // Non-command messages from paused adapters are dropped here. Slash
  // commands are exempt (handled above) so /resume always gets through.
  if (deps.pauseSet && deps.registry) {
    const originAdapterId = deps.registry.lookupPrimaryByChannel(result.envelope.channel)?.id;
    if (originAdapterId && deps.pauseSet.has(originAdapterId)) {
      return { ok: true, queued: false, reason: 'adapter_paused' };
    }
  }

  // Fan-out: enqueue one copy per route target produced by Stage 70.
  let enqueuedCount = 0;
  const primaryId = result.envelope.id;

  // If the envelope carries a slash_command payload (Stage 40 rewrite), restore
  // it to a plain text payload before enqueuing for agents. Agents should not
  // need to handle the slash_command payload type; the parsed command info is
  // available in metadata.slash_command instead.
  const outboundPayload: MessageEnvelope['payload'] =
    result.isSlashCommand && result.slashCommand && result.envelope.payload.type === 'slash_command'
      ? { type: 'text', body: result.envelope.payload.body }
      : { ...result.envelope.payload };

  for (let i = 0; i < result.routes.length; i++) {
    const route = result.routes[i]!;
    const fanEnvelope: MessageEnvelope = {
      ...result.envelope,
      payload: outboundPayload,
      id: i === 0 ? primaryId : randomUUID(),
      recipient: route.recipientId,
      metadata: {
        ...result.envelope.metadata,
        adapter_id: route.adapterId,
        conversation_id: result.conversationId ?? undefined,
        ...(result.isSlashCommand && result.slashCommand
          ? { slash_command: { command: result.slashCommand.name, args_raw: result.slashCommand.argsRaw } }
          : {}),
      },
    };
    try {
      deps.queue.enqueue(fanEnvelope);
      enqueuedCount++;
    } catch (err) {
      console.error(`[inbound] Failed to enqueue route ${route.adapterId}:${route.recipientId}`, err);
    }
  }

  return { ok: true, id: primaryId, queued: true, enqueued_count: enqueuedCount };
}

// ── HTTP server ──────────────────────────────────────────────────────────────

export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
  const { queue, registry, pipeline, config, db } = deps;
  const server = Fastify({ logger: false });

  // Auth middleware: runs before every route handler.
  // Health is exempt so monitoring probes work without credentials.
  // Constant-time comparison is not used here because auth_token is a shared
  // secret between trusted processes (not a user-facing password), and the
  // bus is expected to run on a private LAN. Upgrade to crypto.timingSafeEqual
  // if this ever becomes internet-facing.
  if (config.bus.auth_token) {
    const expectedToken = config.bus.auth_token;
    server.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/v1/health') return;
      const provided = req.headers['x-bus-token'];
      if (provided !== expectedToken) {
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }
    });
  }

  // GET /api/v1/health
  server.get('/api/v1/health', async (_req, _reply) => {
    const counts = queue.counts();
    const adapters: Record<string, unknown> = {};
    for (const adapter of registry.list()) {
      const health = await adapter.health().catch(() => ({ status: 'unhealthy' as const }));
      const { status: healthStatus, ...healthRest } = health;
      adapters[adapter.id] = {
        status: healthStatus === 'healthy' ? 'online' : healthStatus,
        capabilities: adapter.capabilities,
        ...healthRest,
      };
    }
    const allHealthy = Object.values(adapters).every(
      (a) => (a as { status: string }).status === 'online'
    );
    return {
      ok: true,
      status: allHealthy ? 'healthy' : 'degraded',
      version: '0.1.0',
      adapters,
      queue: {
        pending: counts['pending'] ?? 0,
        processing: counts['processing'] ?? 0,
        delivered: counts['delivered'] ?? 0,
        dead_letter: counts['dead_letter'] ?? 0,
      },
    };
  });

  // GET /api/v1/messages/pending
  server.get<{
    Querystring: { agent?: string; recipient?: string; limit?: string; topic?: string };
  }>('/api/v1/messages/pending', (req, reply) => {
    const { agent, recipient, limit, topic } = req.query;
    if (!agent && !recipient) {
      return reply.status(400).send({ ok: false, error: '?agent= or ?recipient= is required' });
    }
    // ?recipient= takes a raw recipientId (e.g. "contact:alice", "agent:claude").
    // ?agent= is a shorthand that prepends the "agent:" prefix (legacy CC adapter usage).
    const recipientId = recipient ?? `agent:${agent}`;
    const parsedLimit = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 10, 100)) : 10;
    const messages = queue.dequeue(recipientId, topic, parsedLimit);
    return {
      ok: true,
      messages: messages.map((m) => m.envelope),
      count: messages.length,
    };
  });

  // POST /api/v1/messages/:id/ack
  server.post<{ Params: { id: string }; Body: { status: string; error?: string } }>(
    '/api/v1/messages/:id/ack',
    (req, reply) => {
      const { id } = req.params;
      const { status } = req.body ?? {};
      if (status === 'delivered') {
        const acked = queue.ack(id);
        if (!acked) {
          return reply.status(404).send({ ok: false, error: 'Message not found or not in processing state' });
        }
        return { ok: true, id, status: 'delivered' };
      } else if (status === 'failed') {
        const reason = req.body?.error ?? 'failed';
        const moved = queue.deadLetter(id, reason);
        if (!moved) {
          return reply.status(404).send({ ok: false, error: 'Message not found' });
        }
        return { ok: true, id, status: 'dead_lettered' };
      } else {
        return reply.status(400).send({ ok: false, error: 'status must be "delivered" or "failed"' });
      }
    }
  );

  // POST /api/v1/messages — direct enqueue (used by MCP reply tool)
  server.post<{ Body: unknown }>('/api/v1/messages', (req, reply) => {
    const parsed = MessageSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const data = parsed.data;
    const envelope: MessageEnvelope = {
      id: data.id ?? randomUUID(),
      timestamp: data.timestamp ?? new Date().toISOString(),
      channel: data.channel,
      topic: data.topic,
      sender: data.sender,
      recipient: data.recipient,
      reply_to: data.reply_to,
      priority: data.priority,
      payload: data.payload,
      metadata: data.metadata,
    };
    const id = queue.enqueue(envelope, data.expires_at);
    return reply.status(201).send({ ok: true, id, queued: true });
  });

  // GET /api/v1/messages/:id
  server.get<{ Params: { id: string } }>('/api/v1/messages/:id', (req, reply) => {
    const message = queue.getById(req.params.id);
    if (!message) {
      return reply.status(404).send({ ok: false, error: 'Message not found' });
    }
    return { ok: true, message: message.envelope };
  });

  // GET /api/v1/adapters — list registered adapters with capabilities
  server.get('/api/v1/adapters', async (_req, _reply) => {
    const adapters = registry.list().map((a) => ({
      id: a.id,
      name: a.name,
      channels: a.capabilities.channels,
      capabilities: a.capabilities,
    }));
    return { ok: true, adapters };
  });

  // POST /api/v1/adapters/:id/typing — signal that the agent received a message;
  // adapter starts its typing indicator so the user sees activity while Claude works.
  // Fire-and-forget by callers — always returns 200, even when adapter is not found
  // or doesn't support typing (no-op in those cases).
  server.post<{ Params: { id: string }; Body: { contact_id?: string } }>(
    '/api/v1/adapters/:id/typing',
    async (req, _reply) => {
      const adapter = registry.lookup(req.params.id);
      if (adapter?.capabilities.typing && typeof adapter.startTyping === 'function') {
        adapter.startTyping(req.body.contact_id ?? '');
      }
      return { ok: true };
    },
  );

  // GET /api/v1/transcripts/search — FTS5 full-text search over transcripts
  server.get<{
    Querystring: { q?: string; channel?: string; since?: string; limit?: string };
  }>('/api/v1/transcripts/search', (req, reply) => {
    const { q, channel, since, limit: limitStr } = req.query;
    if (!q || q.trim() === '') {
      return reply.status(400).send({ ok: false, error: '?q= query parameter is required' });
    }

    // Graceful degradation: check if FTS table exists
    const ftsExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='transcripts_fts'`)
      .get();
    if (!ftsExists) {
      return { ok: true, available: false, reason: 'Transcript search not available' };
    }

    const parsedLimit = Math.max(1, Math.min(parseInt(limitStr ?? '10', 10) || 10, 100));

    let sql = `
      SELECT t.message_id, t.session_id, t.channel, t.contact_id, t.direction, t.body, t.created_at
      FROM transcripts t
      JOIN transcripts_fts fts ON fts.rowid = t.rowid
      WHERE fts.body MATCH ?
    `;
    const params: unknown[] = [q];

    if (channel) {
      sql += ` AND t.channel = ?`;
      params.push(channel);
    }
    if (since) {
      sql += ` AND t.created_at > ?`;
      params.push(since);
    }
    sql += ` ORDER BY t.created_at DESC LIMIT ?`;
    params.push(parsedLimit);

    try {
      const results = db.prepare(sql).all(...params) as Array<{
        message_id: string;
        session_id: string;
        channel: string;
        contact_id: string;
        direction: string;
        body: string;
        created_at: string;
      }>;
      return { ok: true, results, count: results.length };
    } catch (err) {
      // FTS5 throws on malformed queries (e.g. unmatched quotes)
      return reply.status(400).send({ ok: false, error: `FTS query error: ${String(err)}` });
    }
  });

  // GET /api/v1/sessions — list sessions with optional filters
  server.get<{
    Querystring: { channel?: string; contact_id?: string; since?: string; limit?: string };
  }>('/api/v1/sessions', (req, reply) => {
    const { channel, contact_id, since, limit: limitStr } = req.query;
    const parsedLimit = Math.max(1, Math.min(parseInt(limitStr ?? '20', 10) || 20, 100));

    let sql = `
      SELECT s.id, s.conversation_id, s.channel, s.contact_id,
             s.started_at, s.last_activity, s.ended_at, s.message_count,
             ss.summary, ss.model, ss.token_count, ss.created_at AS summary_created_at
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (channel) {
      sql += ` AND s.channel = ?`;
      params.push(channel);
    }
    if (contact_id) {
      sql += ` AND s.contact_id = ?`;
      params.push(contact_id);
    }
    if (since) {
      sql += ` AND s.started_at > ?`;
      params.push(since);
    }
    sql += ` ORDER BY s.started_at DESC LIMIT ?`;
    params.push(parsedLimit);

    try {
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        conversation_id: string;
        channel: string;
        contact_id: string;
        started_at: string;
        last_activity: string;
        ended_at: string | null;
        message_count: number;
        summary: string | null;
        model: string | null;
        token_count: number | null;
        summary_created_at: string | null;
      }>;

      const sessions = rows.map(({ summary, model, token_count, summary_created_at, ...s }) => ({
        ...s,
        summary: summary
          ? { summary, model, token_count, created_at: summary_created_at }
          : null,
      }));

      return { ok: true, sessions, count: sessions.length };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: `Database error: ${String(err)}` });
    }
  });

  // GET /api/v1/sessions/:id — get a specific session
  server.get<{ Params: { id: string } }>('/api/v1/sessions/:id', (req, reply) => {
    const { id } = req.params;

    const row = db
      .prepare(
        `SELECT s.id, s.conversation_id, s.channel, s.contact_id,
                s.started_at, s.last_activity, s.ended_at, s.message_count,
                ss.summary, ss.model, ss.token_count, ss.created_at AS summary_created_at
         FROM sessions s
         LEFT JOIN session_summaries ss ON ss.session_id = s.id
         WHERE s.id = ?`
      )
      .get(id) as
      | {
          id: string;
          conversation_id: string;
          channel: string;
          contact_id: string;
          started_at: string;
          last_activity: string;
          ended_at: string | null;
          message_count: number;
          summary: string | null;
          model: string | null;
          token_count: number | null;
          summary_created_at: string | null;
        }
      | undefined;

    if (!row) {
      return reply.status(404).send({ ok: false, error: 'Session not found' });
    }

    const { summary, model, token_count, summary_created_at, ...sessionFields } = row;
    const session = {
      ...sessionFields,
      summary: summary
        ? { summary, model, token_count, created_at: summary_created_at }
        : null,
    };

    return { ok: true, session };
  });

  // POST /api/v1/messages/:id/react — send a reaction emoji to a message
  server.post<{ Params: { id: string }; Body: { emoji: string } }>(
    '/api/v1/messages/:id/react',
    async (req, reply) => {
      const { id: messageId } = req.params;
      const { emoji } = req.body ?? {};

      if (!emoji || typeof emoji !== 'string') {
        return reply.status(400).send({ ok: false, error: 'emoji is required' });
      }

      // Look up transcript by message_id
      const transcript = db
        .prepare(`SELECT channel, metadata FROM transcripts WHERE message_id = ? LIMIT 1`)
        .get(messageId) as { channel: string; metadata: string } | undefined;

      if (!transcript) {
        return reply.status(404).send({ ok: false, error: `Message not found in transcripts: ${messageId}` });
      }

      // Resolve adapter from channel
      const adapter = registry.lookupPrimaryByChannel(transcript.channel);
      if (!adapter) {
        return reply.status(404).send({
          ok: false,
          error: `No adapter registered for channel: ${transcript.channel}`,
        });
      }

      // Capability check
      if (!adapter.capabilities.react) {
        return reply.status(400).send({
          ok: false,
          success: false,
          reason: `Reactions not supported on channel: ${transcript.channel}`,
        });
      }

      if (typeof adapter.react !== 'function') {
        return reply.status(400).send({
          ok: false,
          success: false,
          reason: `Adapter "${adapter.id}" does not implement react()`,
        });
      }

      // Extract platform message ID from transcript metadata
      let platformMessageId: string;
      try {
        const meta = JSON.parse(transcript.metadata) as Record<string, unknown>;
        platformMessageId = (meta['platform_message_id'] as string | undefined) ?? messageId;
      } catch {
        platformMessageId = messageId;
      }

      // Call adapter.react()
      try {
        await adapter.react(platformMessageId, emoji);
        return { ok: true, success: true, emoji, message_id: messageId };
      } catch (err) {
        return reply.status(502).send({
          ok: false,
          success: false,
          error: String(err),
        });
      }
    }
  );

  // ── Memory endpoints (E8) ────────────────────────────────────────────────────

  // GET /api/v1/memories/recall — FTS5 search over memories for a contact
  server.get<{ Querystring: { q?: string; contact_id?: string; category?: string; limit?: string } }>(
    '/api/v1/memories/recall',
    async (req, reply) => {
      const { q, contact_id, category } = req.query;
      const limit = Math.min(Math.max(1, parseInt(req.query.limit ?? '10', 10)), 50);

      if (!q || q.trim().length === 0) {
        return reply.status(400).send({ ok: false, error: 'Query parameter "q" is required' });
      }

      // Graceful degradation if memories table doesn't exist
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
        .get();
      if (!tableExists) {
        return { ok: true, available: false, reason: 'Memory system not yet initialized', memories: [] };
      }

      const now = new Date().toISOString();
      try {
        let sql = `
          SELECT m.id, m.session_id, m.contact_id, m.category, m.content,
                 m.confidence, m.source, m.created_at, m.expires_at
          FROM memories m
          JOIN memories_fts fts ON fts.rowid = m.rowid
          WHERE fts.content MATCH ?
            AND m.superseded_by IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > ?)
        `;
        const params: unknown[] = [q, now];

        if (contact_id) {
          sql += ' AND m.contact_id = ?';
          params.push(contact_id);
        }
        if (category) {
          sql += ' AND m.category = ?';
          params.push(category);
        }
        sql += ' ORDER BY m.confidence DESC, m.created_at DESC LIMIT ?';
        params.push(limit);

        const memories = db.prepare(sql).all(...params);
        return { ok: true, memories, count: memories.length };
      } catch (err) {
        return reply.status(500).send({ ok: false, error: String(err) });
      }
    }
  );

  // POST /api/v1/memories — manually log a memory
  const MEMORY_CATEGORIES = [
    'preference', 'fact', 'plan', 'relationship', 'work', 'health', 'general',
  ] as const;
  const MemoryInsertSchema = z.object({
    contact_id: z.string().min(1),
    content: z.string().min(1),
    category: z.enum(MEMORY_CATEGORIES).default('general'),
    confidence: z.number().min(0).max(1).default(0.9),
    source: z.string().default('manual'),
    expires_at: z.string().optional(),
  });

  server.post<{ Body: unknown }>('/api/v1/memories', async (req, reply) => {
    const parsed = MemoryInsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }

    // Graceful degradation
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
      .get();
    if (!tableExists) {
      return reply.status(503).send({ ok: false, error: 'Memory system not yet initialized' });
    }

    const { contact_id, content, category, confidence, source, expires_at } = parsed.data;
    const now = new Date().toISOString();
    const newId = randomUUID();

    // Supersede + insert atomically to prevent two concurrent requests from both
    // believing they are the sole active memory for a given (contact_id, category).
    let supersededId: string | undefined;
    db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT id FROM memories
           WHERE contact_id = ? AND category = ? AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(contact_id, category, now) as { id: string } | undefined;

      if (existing) {
        db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ?`).run(newId, existing.id);
        supersededId = existing.id;
      }

      db.prepare(
        `INSERT INTO memories
           (id, session_id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(newId, contact_id, category, content, confidence, source, now, expires_at ?? null);
    })();

    return reply.status(201).send({
      ok: true,
      id: newId,
      superseded: supersededId ?? null,
    });
  });

  // POST /api/v1/inbound — pipeline entry point for raw inbound messages
  server.post<{ Body: unknown }>('/api/v1/inbound', async (req, reply) => {
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    return processInbound(parsed.data, {
      queue,
      pipeline,
      config,
      db,
      registry,
      commandRegistry: deps.commandRegistry,
      pauseSet: deps.pauseSet,
    });
  });

  return server;
}
