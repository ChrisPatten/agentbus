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
    Querystring: { agent?: string; limit?: string; topic?: string };
  }>('/api/v1/messages/pending', (req, reply) => {
    const { agent, limit, topic } = req.query;
    if (!agent) {
      return reply.status(400).send({ ok: false, error: '?agent= is required' });
    }
    const recipientId = `agent:${agent}`;
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

  // POST /api/v1/inbound — pipeline entry point for raw inbound messages
  server.post<{ Body: unknown }>('/api/v1/inbound', async (req, reply) => {
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const data = parsed.data;

    const envelope: MessageEnvelope = {
      id: data.id ?? '',
      timestamp: data.timestamp ?? '',
      channel: data.channel,
      topic: data.topic ?? '',
      sender: data.sender,
      recipient: data.recipient ?? '',
      reply_to: data.reply_to ?? null,
      priority: data.priority ?? 'normal',
      payload: data.payload as MessageEnvelope['payload'],
      metadata: (data.metadata as Record<string, unknown>) ?? {},
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
      config,
      db,
    };

    const result = await pipeline.process(ctx);

    if (!result) {
      // ctx.abortReason is set on the original ctx reference by PipelineEngine
      // even though the return value is null, so we can surface it to callers.
      return { ok: true, queued: false, reason: ctx.abortReason ?? 'pipeline_abort' };
    }

    // Fan-out: enqueue one copy per route target produced by Stage 70.
    // Each copy gets independent id/recipient/metadata and a shallow-cloned
    // payload object so that a downstream consumer mutating one copy's payload
    // does not affect the other copies still in the queue.
    let enqueuedCount = 0;
    const primaryId = result.envelope.id;

    for (let i = 0; i < result.routes.length; i++) {
      const route = result.routes[i]!;
      const fanEnvelope: MessageEnvelope = {
        ...result.envelope,
        payload: { ...result.envelope.payload }, // shallow clone — see note above
        id: i === 0 ? primaryId : randomUUID(),
        recipient: route.recipientId,
        metadata: {
          ...result.envelope.metadata,
          adapter_id: route.adapterId,
          conversation_id: result.conversationId ?? undefined,
        },
      };
      try {
        queue.enqueue(fanEnvelope);
        enqueuedCount++;
      } catch (err) {
        console.error(`[inbound] Failed to enqueue route ${route.adapterId}:${route.recipientId}`, err);
      }
    }

    return {
      ok: true,
      id: primaryId,
      queued: true,
      enqueued_count: enqueuedCount,
    };
  });

  return server;
}
