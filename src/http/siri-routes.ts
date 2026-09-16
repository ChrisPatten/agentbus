/**
 * `/api/v1/siri/*` routes (E42 spike). Registered from `createHttpServer`
 * only when `config.adapters.siri.enabled` and a `SiriAdapter` is supplied.
 *
 * POST /api/v1/siri/ask     — submit a question, wait for the agent's first reply
 * GET  /api/v1/siri/health  — reachability + routing check for the app's
 *                             "Test connection" button (finalised in E43)
 *
 * Auth: `Authorization: Bearer <contacts.*.platforms.siri.token>` *is* the
 * sender's identity — it resolves straight to `contact:<id>` (E25 pattern);
 * a missing/unknown token is a hard 401 with no fallback identity. When
 * `bus.auth_token` is set, the global `X-Bus-Token` hook applies as well.
 *
 * The HTTP contract is frozen in
 * _bmad-output/planning-artifacts/siri-bridge/architecture.md §4; the late
 * reply, history, dedup-join, and rate-limit routes are E43.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { SiriAdapter, SiriPendingRequest } from '../adapters/siri.js';
import type { InboundAbort, InboundMessage, InboundResult } from './api.js';
import { channelMatches } from '../pipeline/types.js';
import { VERSION } from '../version.js';

export interface SiriRouteDeps {
  config: AppConfig;
  registry: AdapterRegistry;
  siri: SiriAdapter;
  /** `processInbound()` bound to the server's pipeline/queue deps. */
  submitInbound: (message: InboundMessage) => Promise<InboundResult | InboundAbort>;
}

const AskBodySchema = z.object({
  text: z.string().min(1).max(2000),
  wait_ms: z.number().int().nonnegative().optional(),
  request_id: z.string().uuid().optional(),
  client: z.record(z.string(), z.unknown()).optional(),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function shortId(id: string): string {
  return id.slice(0, 8);
}

function preview(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Evaluate `pipeline.routes` the way Stage 70 would for a `siri` message from
 * this contact (channel + sender + topic, first match wins; topic assumed
 * `general`). Returns the matched target, or null when no rule matches — the
 * default route would address `envelope.recipient`, which is empty for a
 * Siri ask, so "no rule" means "not routed".
 */
function resolveSiriRoute(
  config: AppConfig,
  contactId: string,
): { adapterId: string; recipientId: string } | null {
  for (const rule of config.pipeline.routes) {
    const { match } = rule;
    if (match.sender && match.sender !== `contact:${contactId}`) continue;
    if (match.channel && !channelMatches(match.channel, 'siri')) continue;
    if (match.topic && match.topic !== 'general') continue;
    return rule.target;
  }
  return null;
}

export function registerSiriRoutes(server: FastifyInstance, deps: SiriRouteDeps): void {
  const { config, registry, siri, submitInbound } = deps;
  const cfg = config.adapters.siri;
  if (!cfg) return;

  const contactIdByToken = new Map<string, string>();
  for (const contact of Object.values(config.contacts)) {
    const token = contact.platforms.siri?.token;
    if (token) contactIdByToken.set(token, contact.id);
  }

  /** Bearer token → contact id, or undefined (caller answers 401). */
  function authenticate(req: FastifyRequest): string | undefined {
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    return token ? contactIdByToken.get(token) : undefined;
  }

  server.post<{ Body: unknown }>('/api/v1/siri/ask', async (req, reply) => {
    const received = new Date();

    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > cfg.max_body_bytes) {
      return reply.status(413).send({ ok: false, error: 'Request body too large' });
    }

    const contactId = authenticate(req);
    if (!contactId) {
      console.log('[siri] rejected — missing or unrecognized bearer token');
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }

    const parsed = AskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: 'text is required (1..2000 chars)' });
    }
    const { text, wait_ms, request_id, client } = parsed.data;

    const requestId = request_id ?? randomUUID();
    const messageId = randomUUID();
    const waitMs = Math.min(wait_ms ?? cfg.reply_timeout_ms, cfg.reply_timeout_ms);
    const receivedAt = received.toISOString();
    console.log(`[siri] ask request_id=${shortId(requestId)} contact=contact:${contactId} text="${preview(text)}"`);

    // Register the waiter before the pipeline runs so a synchronous bus-command
    // response (delivered inside processInbound via sendCommandResponse) lands.
    const pending: SiriPendingRequest = {
      requestId,
      messageId,
      contactId: `contact:${contactId}`,
      text,
      receivedAt,
    };
    siri.register(pending);

    const result = await submitInbound({
      id: messageId,
      channel: 'siri',
      sender: `contact:${contactId}`,
      payload: { type: 'text', body: text },
      metadata: { source: 'siri', request_id: requestId, client: client ?? {}, sent_at: receivedAt },
    });
    const queued = new Date();
    const queuedMs = queued.getTime() - received.getTime();

    if (!result.queued) {
      if (result.reason === 'command_handled') {
        // A bus-scope slash command answered inline; its response already hit send().
        const commandReply = await siri.wait(messageId, 0);
        console.log(`[siri] command_handled request_id=${shortId(requestId)} queued_ms=${queuedMs}`);
        return {
          ok: true,
          request_id: requestId,
          message_id: messageId,
          status: 'answered',
          command_handled: true,
          reply: { message_id: commandReply?.messageId ?? null, body: commandReply?.body ?? '', received_at: commandReply?.receivedAt ?? queued.toISOString() },
          timing: { received_at: receivedAt, queued_at: queued.toISOString(), answered_at: queued.toISOString(), queued_ms: queuedMs, answered_ms: queuedMs },
        };
      }
      siri.cancel(messageId);
      // Stage 30 aborts with `Aborted at stage "dedup"`; surface it as the
      // contract's 409 so the app can say "I just asked Peggy that".
      if (result.reason === 'duplicate' || /\bdedup\b/.test(result.reason)) {
        console.log(`[siri] duplicate request_id=${shortId(requestId)} — same text within the dedup window`);
        return reply.status(409).send({ ok: false, error: 'duplicate', reason: 'duplicate' });
      }
      console.log(`[siri] not queued request_id=${shortId(requestId)} reason=${result.reason}`);
      return reply.status(503).send({ ok: false, error: `Not queued: ${result.reason}`, reason: result.reason });
    }

    console.log(`[siri] queued request_id=${shortId(requestId)} message_id=${shortId(messageId)} queued_ms=${queuedMs}`);

    // E44 device testing only: hold the response to find Siri's wait cutoff.
    // The reply wait still starts at receipt, so with a delay longer than
    // wait_ms the app sees `pending` after the delay.
    if (cfg.debug_delay_ms > 0) await sleep(cfg.debug_delay_ms);

    const agentReply = await siri.wait(messageId, waitMs);
    const now = new Date();

    if (agentReply) {
      const answeredMs = Date.parse(agentReply.receivedAt) - received.getTime();
      console.log(`[siri] answered request_id=${shortId(requestId)} answered_ms=${answeredMs} first=true`);
      return {
        ok: true,
        request_id: requestId,
        message_id: messageId,
        status: 'answered',
        reply: { message_id: agentReply.messageId, body: agentReply.body, received_at: agentReply.receivedAt },
        timing: {
          received_at: receivedAt,
          queued_at: queued.toISOString(),
          answered_at: agentReply.receivedAt,
          queued_ms: queuedMs,
          answered_ms: answeredMs,
        },
      };
    }

    const waitedMs = now.getTime() - received.getTime();
    console.log(`[siri] timeout request_id=${shortId(requestId)} waited_ms=${waitedMs}`);
    return {
      ok: true,
      request_id: requestId,
      message_id: messageId,
      status: 'pending',
      timing: { received_at: receivedAt, queued_at: queued.toISOString(), queued_ms: queuedMs, waited_ms: waitedMs },
    };
  });

  server.get('/api/v1/siri/health', async (req, reply) => {
    const contactId = authenticate(req);
    if (!contactId) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized' });
    }
    const target = resolveSiriRoute(config, contactId);
    // The claude-code MCP connector is a separate process that polls the queue
    // over HTTP and never registers in-process (docs/CC_ADAPTER.md), so its
    // absence from the registry is expected — reported as `external`, not
    // `missing`, which is reserved for an in-process adapter id that is not running.
    const adapters: Record<string, 'online' | 'external' | 'missing'> = {};
    if (target) {
      adapters[target.adapterId] = registry.lookup(target.adapterId)
        ? 'online'
        : target.adapterId === 'claude-code'
          ? 'external'
          : 'missing';
    }
    return {
      ok: true,
      routed: target !== null,
      agent: target?.recipientId ?? null,
      adapters,
      version: VERSION,
      limits: { reply_timeout_ms: cfg.reply_timeout_ms, max_body_bytes: cfg.max_body_bytes },
      pending: siri.pendingCount(),
    };
  });
}
