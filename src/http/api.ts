import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

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

export async function createHttpServer(
  queue: MessageQueue,
  registry: AdapterRegistry,
  config: AppConfig
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

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

  // POST /api/v1/messages
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

  return server;
}
