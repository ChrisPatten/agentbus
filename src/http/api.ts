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

export interface HttpServerDeps {
  queue: MessageQueue;
  registry: AdapterRegistry;
  config: AppConfig;
  pipeline: PipelineEngine;
  db: Database.Database;
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
  deps: { queue: MessageQueue; pipeline: PipelineEngine; config: AppConfig; db: Database.Database },
): Promise<InboundResult | InboundAbort> {
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
    config: deps.config,
    db: deps.db,
  };

  const result = await deps.pipeline.process(ctx);

  if (!result) {
    return { ok: true, queued: false, reason: ctx.abortReason ?? 'pipeline_abort' };
  }

  // Fan-out: enqueue one copy per route target produced by Stage 70.
  let enqueuedCount = 0;
  const primaryId = result.envelope.id;

  for (let i = 0; i < result.routes.length; i++) {
    const route = result.routes[i]!;
    const fanEnvelope: MessageEnvelope = {
      ...result.envelope,
      payload: { ...result.envelope.payload },
      id: i === 0 ? primaryId : randomUUID(),
      recipient: route.recipientId,
      metadata: {
        ...result.envelope.metadata,
        adapter_id: route.adapterId,
        conversation_id: result.conversationId ?? undefined,
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
      const adapters = registry.lookupByChannel(transcript.channel);
      if (adapters.length === 0) {
        return reply.status(404).send({
          ok: false,
          error: `No adapter registered for channel: ${transcript.channel}`,
        });
      }
      const adapter = adapters[0]!;

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

  // POST /api/v1/inbound — pipeline entry point for raw inbound messages
  server.post<{ Body: unknown }>('/api/v1/inbound', async (req, reply) => {
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    return processInbound(parsed.data, { queue, pipeline, config, db });
  });

  return server;
}
