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
 * POST /api/v1/pool/:agentId/turn-ended  — Pool pane activity signal (Stop hook).
 * POST /api/v1/approvals                 — Raise an interactive-approval request (E51).
 * GET  /api/v1/approvals                 — List approval requests (?status=).
 * GET  /api/v1/approvals/:id             — Fetch one approval request.
 * POST /api/v1/approvals/:id/resolve     — Answer an approval request.
 * POST /api/v1/webhooks/pebble           — Pebble Ring voice-memo webhook (E25).
 *                                          Only registered when adapters.pebble.enabled.
 * POST /api/v1/siri/ask                  — Siri channel ask (E42, src/http/siri-routes.ts).
 * GET  /api/v1/siri/health                 Only registered when adapters.siri.enabled.
 *
 * Authentication
 * ──────────────
 * When config.bus.auth_token is set, an `onRequest` hook rejects any request
 * that does not include a matching `X-Bus-Token` header with HTTP 401.
 * The health endpoint is exempt so uptime monitors do not need credentials.
 * If both config.bus.auth_token and adapters.pebble are configured, the
 * pebble webhook requires *both* the shared X-Bus-Token header (this hook)
 * and its own per-contact Bearer token (see below) — layered, not either/or.
 *
 * Pebble webhook (POST /api/v1/webhooks/pebble)
 * ────────────────────────────────────────────────
 * The `Authorization: Bearer <token>` header IS the sender's identity, not a
 * shared secret: it is looked up against contacts[*].platforms.pebble.token
 * and resolves straight to `contact:<id>`. An unrecognized/missing token is
 * always a hard 401 — there is no anonymous fallback identity.
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
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MessageQueue } from '../core/queue.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import type { PipelineEngine } from '../pipeline/engine.js';
import type { PipelineContext, RouteTarget } from '../pipeline/types.js';
import { SYSTEM_BLOCKS_KEY, SYSTEM_ONLY_KEY, attachSystemBlock, stripSystemMetadata, systemBlocksFor } from '../core/system-block.js';
import type Database from 'better-sqlite3';
import type { CommandImage, CommandRegistry, SlashCommandContext } from '../commands/registry.js';
import {
  PROVIDER_COMMAND_NAME_RE,
  providerCommandLine,
  type ProviderForwardResult,
} from '../commands/provider-forward.js';
import { createSafeDatabase } from '../db/safe-database.js';
import { logOutboundTranscript } from '../pipeline/outbound-transcript.js';
import { validateAppDestination } from '../app/outbound.js';
import { boundAppReply } from '../app/binding.js';
import { routedAgent, VISIBLE_TRANSCRIPT } from '../app/store.js';
import { journalingHealth, runForApi, type JournalStatusDeps } from '../journaling/status.js';
import { logWebhookRequest } from './webhook-log.js';
import { registerSiriRoutes } from './siri-routes.js';
import type { SiriAdapter } from '../adapters/siri.js';
import type { AppAdapter } from '../adapters/app.js';
import type { HeadlessCapacitySnapshot } from '../adapters/cc-headless.js';
import { registerAppRoutes } from './app-routes.js';
import { VERSION } from '../version.js';
import { recordAgentPoll, getLastPollAt } from './agent-liveness.js';
import type { RuntimeResolver } from '../core/runtime-resolver.js';
import { toBareAgentId, toPrefixedAgentId } from '../pool/types.js';
import { LeaseStore } from '../pool/lease-store.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { ApprovalStore } from '../approvals/store.js';
import { defaultScheduleTopic } from '../scheduler/default-topic.js';
import { resolveApprovalTarget } from '../approvals/resolve-target.js';
import { dispatchApproval } from '../approvals/dispatch.js';
import { resolveApproval, type ApprovalResolveHooks } from '../approvals/resolve.js';
import type { ProposalService, ProposalStatus } from '../learning/proposals.js';
import { APPROVAL_TIMEOUT_MS, type ApprovalStatus } from '../approvals/types.js';
import { parseFreshnessQuery, type RecentFreshness } from '../memory/recent-freshness.js';
import { parseHarnessEvent, type HarnessEvents } from '../journaling/events.js';
import type { AdvisoryService } from '../advisories/service.js';
import type { AdvisoryState } from '../advisories/types.js';
import { writeKnowledge, getKnowledge, forgetKnowledge, searchKnowledge } from '../knowledge/store.js';

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
  /**
   * Optional — the registered Siri channel adapter (E42). When present and
   * `config.adapters.siri.enabled`, the `/api/v1/siri/*` routes are mounted.
   */
  siri?: SiriAdapter;
  app?: AppAdapter;
  getHeadlessSnapshots?: () => HeadlessCapacitySnapshot[];
  /**
   * Optional — one PoolManager per configured `cc-pool` instance (E48),
   * keyed by the pool's prefixed logical agent id (e.g. "agent:peggy").
   * Empty/absent when no `cc-pool` adapters are configured. Consumed by the
   * `GET /api/v1/pool` observability route.
   */
  poolManagers?: Map<string, PoolManager>;
  /** E64 — when present, /api/v1/health lists each agent's runtime and capabilities. */
  runtimeResolver?: Pick<RuntimeResolver, 'list'>;
  /** E65 — when present, the /api/v1/advisories routes are mounted. */
  advisories?: AdvisoryService;
  /** E66 — when present, POST /api/v1/journal/events is mounted (harness hook events). */
  journalEvents?: Pick<HarnessEvents, 'handle'>;
  /**
   * E66 — System Message journal runs: held messages are skipped by the
   * pending poll, the agent's outbound sends get 409, and
   * POST /api/v1/journal/complete is mounted.
   */
  journalGate?: JournalGateLike;
  /** E66 — when present, GET /api/v1/journal/runs is mounted and /api/v1/health includes a journaling summary. */
  journalStatus?: JournalStatusDeps;
  /** E67 — when present, GET /api/v1/memory/recent is mounted (the recent.md freshness hook). */
  memoryRecent?: Pick<RecentFreshness, 'check'>;
  /** E68 — hooks for POST /api/v1/approvals/:id/resolve (denied-approval feedback, self-edit proposals). */
  approvalHooks?: ApprovalResolveHooks;
  /** E68 — when present, the /api/v1/proposals routes are mounted (the propose_change MCP tool). */
  proposals?: Pick<ProposalService, 'submit' | 'list' | 'get'>;
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
/**
 * An inbound attachment recorded by a platform adapter. The `local_path` is
 * an absolute filesystem path that the agent can read; the TTL sweeper deletes
 * the file on expiry.
 */
export interface Attachment {
  id?: string;
  type: 'image' | 'file';
  local_path: string;
  mime_type?: string;
  original_filename?: string;
}

const AttachmentSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(['image', 'file']),
  local_path: z.string().min(1),
  mime_type: z.string().optional(),
  original_filename: z.string().optional(),
});

/**
 * Relaxed schema for POST /api/v1/inbound.
 *
 * Most fields are optional here because Stage 10 (normalize) applies defaults.
 * payload.type is intentionally restricted to "text": inbound adapters submit
 * raw text; Stage 40 (slash-command) re-classifies the payload as
 * slash_command if the body starts with '/'. Accepting slash_command here
 * would let callers bypass Stage 40 detection.
 *
 * `payload.body` may be empty when `attachments` is non-empty — this supports
 * image-only inbound messages from Telegram (E17).
 */
const InboundSchemaObject = z.object({
  id: z.string().optional(),
  timestamp: z.string().optional(),
  channel: z.string().min(1),
  topic: z.string().optional(),
  sender: z.string().min(1),
  recipient: z.string().optional(),
  reply_to: z.string().nullable().optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), body: z.string() }),
    z.object({
      type: z.literal('reaction'),
      emoji: z.string().min(1),
      removed: z.boolean(),
      target_message_id: z.string().min(1),
    }),
  ]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

const InboundSchema = InboundSchemaObject.refine(
  (m) =>
    m.payload.type === 'reaction' ||
    m.payload.body.length > 0 ||
    (m.attachments && m.attachments.length > 0),
  { message: 'payload.body must be non-empty unless attachments are provided' },
);

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
  payload:
    | { type: 'text'; body: string }
    | { type: 'reaction'; emoji: string; removed: boolean; target_message_id: string };
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface InboundResult {
  ok: true;
  queued: true;
  id: string;
  enqueued_count: number;
}

/**
 * Options only in-process bus code can pass to `processInbound` (E65). An
 * HTTP or adapter caller can't reach these: they are not part of
 * `InboundMessage`, and the matching metadata keys are stripped from it.
 */
export interface InboundSystemOptions {
  /**
   * A bus-originated turn with no human message (`metadata.system_only`).
   * The body is logged but not shown to the agent; only the system blocks
   * added by pipeline stages are. Skips follow-up capture.
   */
  systemOnly?: boolean;
  /** Keep only the fan-out targets this returns true for (e.g. the one agent a system turn is for). */
  routeFilter?: (route: RouteTarget) => boolean;
  /**
   * E66 — system blocks to attach after the pipeline (so they are never
   * stored in the transcript), for every fan-out copy that survives
   * `routeFilter`. Used for journaling instructions.
   */
  blocks?: string[];
  /** E66 — reserved metadata to set after ingress stripping (e.g. `journal_run_id`). */
  metadata?: Record<string, unknown>;
}

/** E66 — the System Message journaler's state, as the HTTP layer uses it. */
export interface JournalGateLike {
  isHeld(envelope: Pick<MessageEnvelope, 'recipient' | 'metadata'>): boolean;
  blockedSend(sender: string): { runId: string } | null;
  complete(input: { runId: string; agentId: string; filesChanged?: string[]; notes?: string; nothingNew?: boolean }):
    | { ok: true; runId: string }
    | { ok: false; reason: 'unknown_run' | 'stale_run' | 'wrong_agent' | 'already_completed' };
}

export interface InboundAbort {
  ok: true;
  queued: false;
  reason: string;
}

/**
 * Send a bus-command response directly via the originating adapter (bypassing
 * the outbound queue) and log it to transcripts. Shared by the normal
 * slash-command dispatch path, the follow-up-capture path (E36), and
 * `/torrent`'s out-of-band completion notification (E36, `src/index.ts`) —
 * a later, detached send using the same mechanics but a different trigger —
 * so the send+log logic can't drift between call sites.
 */
export async function sendCommandResponse(
  deps: { db: Database.Database; registry?: AdapterRegistry },
  result: { envelope: MessageEnvelope; sessionId: string | null; conversationId: string | null },
  commandName: string,
  responseBody: string,
  extraMetadata: Record<string, unknown> = {},
  images: CommandImage[] = [],
): Promise<void> {
  const originAdapter = deps.registry?.lookupPrimaryByChannel(result.envelope.channel);
  const adapterId = originAdapter?.id ?? 'unknown';

  if (!originAdapter) {
    console.warn(`[inbound] No adapter found for channel "${result.envelope.channel}" — command response not sent`);
    return;
  }

  const metadata = { command_response: true, command: commandName,
    command_source_message_id: result.envelope.id, ...extraMetadata };

  const buildEnvelope = (body: string): MessageEnvelope => ({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: result.envelope.channel,
    topic: result.envelope.topic,
    sender: 'system:bus',
    recipient: result.envelope.sender,
    reply_to: result.envelope.id,
    priority: 'normal',
    payload: { type: 'text', body },
    metadata,
  });

  const sendText = async (body: string, envelope: MessageEnvelope = buildEnvelope(body)): Promise<void> => {
    try {
      if (originAdapter.id === 'app' && 'sendCommandResponse' in originAdapter) {
        await (originAdapter as typeof originAdapter & {sendCommandResponse: (e: MessageEnvelope) => Promise<unknown>}).sendCommandResponse(envelope);
      } else {
        await originAdapter.send(envelope);
      }
    } catch (err) {
      console.error(`[inbound] Failed to send command response via ${adapterId}: ${String(err)}`);
    }
  };

  const responseEnvelope = buildEnvelope(responseBody);
  if (responseBody.length > 0 || images.length === 0) {
    await sendText(responseBody, responseEnvelope);
  }

  // Image replies (e.g. /pane). An adapter without sendImage, or a failed
  // image send, gets the image's plain-text fallback instead — the reply is
  // never silently dropped. Image bytes and fallback text are deliberately
  // not logged or written to the transcript.
  for (const [i, image] of images.entries()) {
    let sent = false;
    if (originAdapter.sendImage) {
      try {
        const res = await originAdapter.sendImage(buildEnvelope(image.caption), {
          png: image.png,
          caption: image.caption,
          filename: `${commandName}-${i + 1}.png`,
        });
        sent = res.success;
        if (!res.success) console.error(`[inbound] Image reply via ${adapterId} failed: ${res.error ?? 'unknown error'}`);
      } catch (err) {
        console.error(`[inbound] Failed to send image reply via ${adapterId}: ${String(err)}`);
      }
    }
    if (!sent) await sendText(image.fallbackText);
  }

  // Log command response to transcripts for auditability.
  // Marked with command_response:true so E8/E9 can exclude from memory processing.
  if (result.sessionId && result.conversationId) {
    try {
      const contactId = result.envelope.sender.startsWith('contact:')
        ? result.envelope.sender.slice('contact:'.length)
        : result.envelope.sender;
      logOutboundTranscript(deps.db, {
        messageId: responseEnvelope.id,
        conversationId: result.conversationId,
        sessionId: result.sessionId,
        channel: result.envelope.channel,
        contactId,
        body: responseBody.length > 0 || images.length === 0 ? responseBody : `[${images.length} image reply(s) sent]`,
        metadata,
      });
    } catch (err) {
      console.error(`[inbound] Failed to log command response transcript: ${String(err)}`);
    }
  }
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
  system: InboundSystemOptions = {},
): Promise<InboundResult | InboundAbort> {
  // Validate payload for in-process callers that bypass Zod (e.g. TelegramAdapter).
  // The HTTP route validates via InboundSchema, but processInbound is also called
  // directly. Reject unknown payload types. Stage 40 (slash-command) only fires on
  // text payloads; reactions are passed through as-is. An empty text body is allowed
  // only when attachments are present (E17 image-only messages).
  if (message.payload.type === 'text') {
    if (!message.payload.body && !(message.attachments && message.attachments.length > 0)) {
      return { ok: true, queued: false, reason: 'invalid_payload' };
    }
  } else if (message.payload.type !== 'reaction') {
    return { ok: true, queued: false, reason: 'invalid_payload' };
  }

  // Attachments travel through the envelope inside `metadata.attachments` so
  // they survive enqueue/dequeue (metadata is persisted as JSON on the queue
  // row; the envelope itself is rehydrated from that row).
  // E65 — system blocks and the system-only flag are bus-originated: a caller
  // can't supply them, only pipeline stages and `system` (below) add them.
  const metadata: Record<string, unknown> = stripSystemMetadata(message.metadata);
  if (system.systemOnly) metadata[SYSTEM_ONLY_KEY] = true;
  if (system.metadata) Object.assign(metadata, system.metadata);
  if (message.attachments && message.attachments.length > 0) {
    metadata['attachments'] = message.attachments;
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
    metadata,
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
  for (const block of system.blocks ?? []) attachSystemBlock(result.envelope.metadata, block);

  // ── Follow-up capture check (post-pipeline, pre slash-command dispatch) ──
  // A plain-text, non-slash-command message is checked against any pending
  // follow-up capture registered for this sender (E36, e.g. /torrent asking
  // "What's the magnet link?"). If one is pending and the message validates,
  // it's routed straight to the target command's handler — short-circuiting
  // before agent fan-out — exactly like a normal bus-command invocation.
  // consumeFollowUp always deletes on read (single-shot), so whether or not
  // it matches, the capture is gone after this check either way.
  if (!system.systemOnly && !result.isSlashCommand && result.envelope.payload.type === 'text' && deps.commandRegistry) {
    const followUp = deps.commandRegistry.consumeFollowUp(result.envelope.channel, result.envelope.sender);
    if (followUp) {
      const body = result.envelope.payload.body;
      if (followUp.validate(body)) {
        const cmd = deps.commandRegistry.lookup(followUp.command);
        if (cmd && cmd.scope === 'bus') {
          const originAdapter = deps.registry?.lookupPrimaryByChannel(result.envelope.channel);
          const cmdCtx: SlashCommandContext = {
            channel: result.envelope.channel,
            sender: result.envelope.sender,
            adapterId: originAdapter?.id ?? 'unknown',
            argsRaw: body.trim(),
            envelope: result.envelope,
            db: createSafeDatabase(deps.db),
            config: deps.config,
          };

          let responseBody: string | undefined;
          let responseImages: CommandImage[] | undefined;
          try {
            const response = await cmd.handler([body.trim()], cmdCtx);
            responseBody = response.body;
            responseImages = response.images;
          } catch (err) {
            responseBody = `Command error: ${String(err)}`;
          }

          if (responseImages?.length) responseBody ??= '';
          if (responseBody !== undefined) {
            await sendCommandResponse(deps, result, followUp.command, responseBody, {}, responseImages);
          }

          return { ok: true, queued: false, reason: 'command_handled' };
        }
      }
      // No match (validate() failed, or the target command is missing/not
      // bus-scope) — fall through to normal pipeline processing below,
      // exactly as if no follow-up had ever been registered.
    }
  }

  // ── Slash command dispatch (post-pipeline) ───────────────────────────────
  // Slash commands are handled here, after all pipeline stages have run
  // (including transcript-log at Stage 80). Responses bypass the outbound
  // queue and are sent directly via the originating adapter.
  //
  // Paused adapters can still send slash commands — the pause check below
  // only drops non-command messages, so /resume always works.
  // Set when a provider forwarder asked for the command to be enqueued (E71).
  let providerCommand: { command: string; args_raw: string } | null = null;

  if (result.isSlashCommand && result.slashCommand && deps.commandRegistry) {
    const commandName = result.slashCommand.name;
    const forced = result.slashCommand.forceProvider === true;
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
    let responseImages: CommandImage[] | undefined;

    if (cmd && cmd.scope === 'bus' && !forced) {
      try {
        const response = await cmd.handler(result.slashCommand.args, cmdCtx);
        responseBody = response.body;
        responseImages = response.images;
      } catch (err) {
        responseBody = `Command error: ${String(err)}`;
      }
    } else if (!cmd || forced) {
      // ── Provider forwarding (E71) ──────────────────────────────────────
      // `//name`, or a `/name` no bus command claims, goes to the provider
      // behind the primary route — if that provider registered a forwarder.
      const unknown = `Unknown command: /${commandName}\nType /help to see available commands.`;
      const route = result.routes[0];
      const forwarder = route ? deps.commandRegistry.provider(route.adapterId) : undefined;
      const line = providerCommandLine(commandName, result.slashCommand.argsRaw);

      if (!PROVIDER_COMMAND_NAME_RE.test(commandName)) {
        responseBody = unknown;
      } else if (!route || !forwarder) {
        responseBody = forced
          ? `${line} was not forwarded: ${route ? `the ${route.adapterId} provider doesn't accept slash commands` : 'no route for this conversation'}.`
          : unknown;
      } else if (deps.pauseSet?.has(adapterId)) {
        responseBody = `Adapter "${adapterId}" is paused; ${line} was not forwarded.`;
      } else {
        let forwarded: ProviderForwardResult;
        try {
          forwarded = await forwarder.forward({
            route,
            command: commandName,
            argsRaw: result.slashCommand.argsRaw,
            line,
            ctx: cmdCtx,
          });
        } catch (err) {
          forwarded = { kind: 'unsupported', reason: `Command error: ${String(err)}` };
        }
        if (forwarded.kind === 'reply') {
          responseBody = forwarded.response.body;
          responseImages = forwarded.response.images;
          // Forwarded and nothing to say: still handled, never fanned out.
          if (responseBody === undefined && !responseImages?.length) {
            return { ok: true, queued: false, reason: 'command_handled' };
          }
        } else if (forwarded.kind === 'unsupported') {
          responseBody = forwarded.reason;
        } else {
          providerCommand = { command: commandName, args_raw: result.slashCommand.argsRaw };
        }
      }
    }
    // scope: 'agent' falls through to normal fan-out enqueue below

    if (responseImages?.length) responseBody ??= '';
    if (responseBody !== undefined) {
      await sendCommandResponse(deps, result, commandName, responseBody, {}, responseImages);
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
  // A provider command carries the exact line the provider should run
  // ("//clear" → "/clear") and goes to the primary route only — also_notify
  // targets never receive it.
  const outboundPayload: MessageEnvelope['payload'] = providerCommand
    ? { type: 'text', body: providerCommandLine(providerCommand.command, providerCommand.args_raw) }
    : result.isSlashCommand && result.slashCommand && result.envelope.payload.type === 'slash_command'
      ? { type: 'text', body: result.envelope.payload.body }
      : { ...result.envelope.payload };

  const filteredRoutes = system.routeFilter ? result.routes.filter(system.routeFilter) : result.routes;
  if (filteredRoutes.length === 0 && result.routes.length > 0) {
    return { ok: true, queued: false, reason: 'no_matching_route' };
  }
  const routes = providerCommand ? filteredRoutes.slice(0, 1) : filteredRoutes;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    // E65 — each fan-out copy carries only the system blocks meant for its
    // recipient (an advisory for agent A must not reach also_notify agent B).
    const blocks = systemBlocksFor(result.envelope.metadata, route.recipientId);
    const { [SYSTEM_BLOCKS_KEY]: _pending, ...baseMetadata } = result.envelope.metadata;
    const fanEnvelope: MessageEnvelope = {
      ...result.envelope,
      payload: outboundPayload,
      id: i === 0 ? primaryId : randomUUID(),
      recipient: route.recipientId,
      metadata: {
        ...baseMetadata,
        ...(blocks.length > 0 ? { [SYSTEM_BLOCKS_KEY]: blocks } : {}),
        adapter_id: route.adapterId,
        conversation_id: result.conversationId ?? undefined,
        ...(result.isSlashCommand && result.slashCommand
          ? { slash_command: { command: result.slashCommand.name, args_raw: result.slashCommand.argsRaw } }
          : {}),
        ...(providerCommand ? { provider_command: providerCommand } : {}),
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

/** Health must answer even if the journaling summary can't be computed. */
function safeJournalingHealth(deps: JournalStatusDeps): ReturnType<typeof journalingHealth> | { status: 'unknown'; error: string } {
  try {
    return journalingHealth(deps);
  } catch (err) {
    return { status: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────

export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
  const { queue, registry, pipeline, config, db, poolManagers } = deps;
  const server = Fastify({ logger: false });

  // Pebble webhook fields are plain text (transcription/recordedAt/client) — no
  // file uploads are expected, so files:0 rejects any file part with a 413
  // (FST_FILES_LIMIT) rather than silently accepting binary attachments.
  await server.register(multipart, { limits: { files: 0 } });

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

  server.addHook('onRequest', async (req) => {
    const skip = req.url === '/api/v1/health' || req.url.startsWith('/api/v1/messages/pending');
    if (!skip) {
      console.log(`[http] ${req.method} ${req.url} from ${req.ip}`);
    }
  });

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
    const journaling = deps.journalStatus ? safeJournalingHealth(deps.journalStatus) : null;
    // Post-E66: critical journaling (3 exhausted runs in a row, or a day of backlog) degrades the bus.
    const journalingCritical = journaling?.status === 'critical';
    return {
      ok: true,
      status: allHealthy && !journalingCritical ? 'healthy' : 'degraded',
      version: VERSION,
      adapters,
      ...(deps.runtimeResolver
        ? { runtimes: Object.fromEntries(deps.runtimeResolver.list().map((r) =>
            [r.agentId, { runtime: r.kind, capabilities: r.capabilities }])) }
        : {}),
      queue: {
        pending: counts['pending'] ?? 0,
        processing: counts['processing'] ?? 0,
        delivered: counts['delivered'] ?? 0,
        dead_letter: counts['dead_letter'] ?? 0,
      },
      ...(journaling ? { journaling } : {}),
    };
  });

  // GET /api/v1/pool?pool=<name> — cc-pool pane leases + parked-queue depth
  // (E48 S48.8). `conversation_id` is the raw hash here — a human-readable
  // contact/channel/topic per pane would require joining against
  // sessions/transcripts by conversation_id, which is out of scope for this
  // route (the /pool command is where that lookup would be cheap to add
  // per-row, if ever wanted).
  server.get<{ Querystring: { pool?: string } }>('/api/v1/pool', async (req, reply) => {
    if (!poolManagers || poolManagers.size === 0) {
      return { ok: true, pools: [] };
    }
    const filter = req.query.pool; // e.g. "agent:peggy" — matches a poolManagers key
    const entries = filter
      ? [...poolManagers.entries()].filter(([key]) => key === filter)
      : [...poolManagers.entries()];
    if (filter && entries.length === 0) {
      return reply.status(404).send({ ok: false, error: `No cc-pool instance for "${filter}"` });
    }
    const pools = entries.map(([key, manager]) => {
      const panes = manager.leaseStore.list(manager.poolId);
      const parked = manager.parkedStatus();
      return {
        pool_id: manager.poolId,
        agent_id: key,
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          agent_id: p.agent_id,
          state: p.state,
          conversation_id: p.conversation_id,
          claude_session_id: p.claude_session_id,
          // E53 — model this pane's current Claude session was launched
          // with; null when free, or launched with no --model (CLI default).
          model: p.model,
          leased_at: p.leased_at,
          last_activity_at: p.last_activity_at,
        })),
        parked: { count: parked.count, oldest_parked_at: parked.oldestParkedAt },
      };
    });
    return { ok: true, pools };
  });

  // POST /api/v1/pool/:agentId/turn-ended — real-time pane activity signal,
  // fed by a native Claude Code `Stop` hook (fires after every assistant
  // turn). `leaseStore.touch()` otherwise has no caller: last_activity_at is
  // today only bumped by acquire()'s message-routing path (a message routed
  // IN to a pane), never by the pane's own turn actually finishing — so a
  // long turn or extended thinking time looks idle prematurely against
  // idle_evict_ms/hard_idle_ms. This is a foundation a future pool-journaling
  // trigger could build on, but it does not itself decide journal-worthiness
  // or run any journaling turn.
  // `:agentId` is bare (e.g. "peggy"), matching the Stop hook's config-side
  // agent_id. Fire-and-forget like /typing and /tool-status above: always
  // 200, no-op silently when the pool, or a pane with a matching
  // claude_session_id, isn't found.
  server.post<{ Params: { agentId: string }; Body: { session_id?: string } }>(
    '/api/v1/pool/:agentId/turn-ended',
    async (req, _reply) => {
      const manager = poolManagers?.get(toPrefixedAgentId(req.params.agentId));
      const sessionId = req.body?.session_id;
      if (manager && sessionId) {
        const pane = manager.leaseStore.list(manager.poolId).find((p) => p.claude_session_id === sessionId);
        if (pane) {
          manager.leaseStore.markTurnEnded(manager.poolId, pane.pane_id);
        }
      }
      return { ok: true };
    },
  );

  // ── Journal events (E66) ───────────────────────────────────────────────────
  // POST /api/v1/journal/events — posted by scripts/hooks/agentbus_journal_hook.sh.
  // Body: { harness_session_id, event: turn-ended|pre-compact|session-end|clear,
  //         snapshot_path?, transcript_path? }. The bus resolves agent and
  // conversation from the harness session id. 404 when it knows no session
  // for that id; a rejected snapshot path is reported in `snapshot_error`
  // while the event itself still counts. See docs/JOURNALING.md.
  if (deps.journalEvents) {
    const journalEvents = deps.journalEvents;
    server.post<{ Body: unknown }>('/api/v1/journal/events', async (req, reply) => {
      const parsed = parseHarnessEvent(req.body);
      if ('error' in parsed) return reply.status(400).send({ ok: false, error: parsed.error });
      const result = journalEvents.handle(parsed);
      if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
      return result;
    });
  }

  // ── Recent memory freshness (E67) ──────────────────────────────────────────
  // GET /api/v1/memory/recent?harness_session_id=&event=prompt|session-start&agent=
  // — called by scripts/hooks/agentbus_recent_memory_hook.sh. Resolves the
  // agent from the Claude session id (agent= is only a fallback), regenerates
  // the agent's recent.md and returns it in `context` only when its hash
  // differs from what that session last saw. session-start (and a session's
  // first check) records a baseline. 404 when no agent resolves. See
  // docs/AGENT_MEMORY.md#freshness-hook.
  if (deps.memoryRecent) {
    const memoryRecent = deps.memoryRecent;
    server.get<{ Querystring: Record<string, unknown> }>('/api/v1/memory/recent', async (req, reply) => {
      const parsed = parseFreshnessQuery(req.query ?? {});
      if ('error' in parsed) return reply.status(400).send({ ok: false, error: parsed.error });
      const result = memoryRecent.check(parsed);
      if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
      return result;
    });
  }

  // GET /api/v1/journal/runs?agent=&conversation=&session=&limit= — journal_runs
  // rows, newest first (E66 S66.10). `agent` accepts a bare or prefixed id; a
  // pool pane id maps to its pool. limit: 1–500, default 50.
  if (deps.journalStatus) {
    const status = deps.journalStatus;
    server.get<{ Querystring: { agent?: string; conversation?: string; session?: string; limit?: string } }>(
      '/api/v1/journal/runs',
      async (req) => {
        const { agent, conversation, session } = req.query;
        const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 500));
        let agentId: string | undefined;
        if (agent) {
          const prefixed = agent.startsWith('agent:') ? agent : `agent:${agent}`;
          const runtime = status.resolver.resolve(prefixed);
          agentId = runtime?.kind === 'cc-pool' ? runtime.poolAgentId : prefixed;
        }
        const runs = status.engine.store.listRuns({
          ...(agentId ? { agentId } : {}),
          ...(conversation ? { conversationId: conversation } : {}),
          ...(session ? { sessionId: session } : {}),
          limit,
        });
        return { ok: true, count: runs.length, runs: runs.map(runForApi) };
      },
    );
  }

  // POST /api/v1/journal/complete — the journal_complete MCP tool (E66 S66.8).
  // Body: { run_id, agent_id, files_changed?, notes?, nothing_new? }. 404 for an
  // unknown run, 409 for a stale one (already ended) or a repeat, 403 when the
  // caller is not the run's agent.
  if (deps.journalGate) {
    const gate = deps.journalGate;
    const CompleteSchema = z.object({
      run_id: z.string().min(1),
      agent_id: z.string().min(1),
      files_changed: z.array(z.string()).max(500).optional(),
      notes: z.string().max(10_000).optional(),
      nothing_new: z.boolean().optional(),
    });
    server.post<{ Body: unknown }>('/api/v1/journal/complete', async (req, reply) => {
      const parsed = CompleteSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ ok: false, error: parsed.error.message });
      const b = parsed.data;
      const result = gate.complete({
        runId: b.run_id, agentId: b.agent_id,
        ...(b.files_changed ? { filesChanged: b.files_changed } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
        ...(b.nothing_new !== undefined ? { nothingNew: b.nothing_new } : {}),
      });
      if (!result.ok) {
        const status = result.reason === 'unknown_run' ? 404 : result.reason === 'wrong_agent' ? 403 : 409;
        return reply.status(status).send({ ok: false, error: result.reason });
      }
      return { ok: true, run_id: result.runId };
    });
  }

  // ── Self-edit proposals (E68 S68.3) ──────────────────────────────────────
  // POST /api/v1/proposals — the propose_change MCP tool. `agent_id` is the
  //   caller (bare, prefixed or a pool pane id). One of new_content / diff.
  // GET  /api/v1/proposals?agent=&status=&limit= — newest first, without content.
  // GET  /api/v1/proposals/:id — one proposal, with its content and diff.
  const proposals = deps.proposals;
  if (proposals) {
    const ProposalSchema = z.object({
      agent_id: z.string().min(1),
      path: z.string().min(1).max(1000),
      new_content: z.string().max(512 * 1024).optional(),
      diff: z.string().max(512 * 1024).optional(),
      rationale: z.string().min(1).max(10_000),
      evidence: z.union([z.string().max(10_000), z.array(z.string().max(2_000)).max(50)]).optional(),
      run_id: z.string().min(1).optional(),
    });
    const PROPOSAL_STATUS: Record<string, number> = {
      unknown_agent: 404, no_protected_paths: 422, not_protected: 400, invalid: 400, diff_failed: 409, no_change: 400,
      too_large: 413, rate_limited: 429, no_owners: 422, not_delivered: 422,
    };
    const summaryOf = (p: ReturnType<typeof proposals.list>[number]) => {
      const { new_content: _content, ...rest } = p;
      return rest;
    };
    server.post<{ Body: unknown }>('/api/v1/proposals', async (req, reply) => {
      const parsed = ProposalSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ ok: false, error: 'invalid', message: parsed.error.message });
      const b = parsed.data;
      const result = await proposals.submit({
        agentId: b.agent_id, path: b.path, rationale: b.rationale, source: 'mcp',
        ...(b.new_content !== undefined ? { newContent: b.new_content } : {}),
        ...(b.diff !== undefined ? { diff: b.diff } : {}),
        ...(b.evidence !== undefined ? { evidence: b.evidence } : {}),
        ...(b.run_id ? { runId: b.run_id } : {}),
      });
      if (!result.ok) return reply.status(PROPOSAL_STATUS[result.error] ?? 400).send({ ok: false, error: result.error, message: result.message });
      return {
        ok: true, id: result.proposal.id, status: result.proposal.status, path: result.proposal.path,
        notified: result.notified, expires_at: result.proposal.expires_at, ...(result.duplicate ? { duplicate: true } : {}),
      };
    });
    server.get<{ Querystring: { agent?: string; status?: string; limit?: string } }>('/api/v1/proposals', async (req, reply) => {
      const valid: ProposalStatus[] = ['pending', 'applied', 'denied', 'stale', 'expired', 'failed'];
      const status = req.query.status as ProposalStatus | undefined;
      if (status && !valid.includes(status)) return reply.status(400).send({ ok: false, error: `status must be one of ${valid.join(', ')}` });
      const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200));
      const list = proposals.list({ ...(req.query.agent ? { agentId: req.query.agent } : {}), ...(status ? { status } : {}), limit });
      return { ok: true, count: list.length, proposals: list.map(summaryOf) };
    });
    server.get<{ Params: { id: string } }>('/api/v1/proposals/:id', async (req, reply) => {
      const p = proposals.get(req.params.id);
      if (!p) return reply.status(404).send({ ok: false, error: 'not_found' });
      return { ok: true, proposal: p };
    });
  }

  // ── Approval requests (E51) ────────────────────────────────────────────────
  // See docs/APPROVALS.md. Reception (POST), observability (GET), resolution
  // (POST :id/resolve). The Telegram callback_query handler resolves through
  // the same resolveApproval() as the route below, not by calling it over HTTP.
  const approvalStore = new ApprovalStore(db);
  const ApprovalRequestSchema = z
    .object({
      adapterId: z.string().min(1),
      agentId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      conversationId: z.string().min(1).optional(),
      toolName: z.string().min(1),
      summary: z.string().min(1).max(1000),
      context: z.unknown().optional(),
    })
    .refine((b) => b.agentId || b.sessionId, { message: 'agentId or sessionId is required' });

  // ── Advisories (E65) ─────────────────────────────────────────────────────
  //
  // POST /api/v1/advisories/:id/ack — the advisory_ack MCP tool. `agent_id`
  //   is the caller (bare or prefixed; a pool pane maps to its pool); an
  //   agent can only acknowledge its own advisories.
  //
  // There is deliberately no HTTP route to raise an advisory: its text is
  // rendered into a bus-originated system block, so producers are in-process
  // bus code only (see docs/ADVISORIES.md).
  const advisories = deps.advisories;
  if (advisories) {
    // GET /api/v1/advisories?agent=<id>&state=<active|all|open|delivered|acknowledged|resolved>
    // Default state: active (everything not resolved). Most severe first.
    server.get<{ Querystring: { agent?: string; state?: string } }>('/api/v1/advisories', async (req, reply) => {
      const state = req.query.state ?? 'active';
      const states: Record<string, AdvisoryState[] | undefined> = {
        active: ['open', 'delivered', 'acknowledged'], all: undefined,
        open: ['open'], delivered: ['delivered'], acknowledged: ['acknowledged'], resolved: ['resolved'],
      };
      if (!(state in states)) {
        return reply.status(400).send({ ok: false, error: `state must be one of ${Object.keys(states).join(', ')}` });
      }
      const list = advisories.list({ ...(req.query.agent ? { agentId: req.query.agent } : {}), states: states[state] });
      return { ok: true, count: list.length, advisories: list };
    });

    server.get<{ Params: { id: string } }>('/api/v1/advisories/:id', async (req, reply) => {
      const advisory = advisories.get(req.params.id);
      if (!advisory) return reply.status(404).send({ ok: false, error: 'not_found' });
      return { ok: true, advisory };
    });

    server.post<{ Params: { id: string }; Body: { agent_id?: unknown } }>(
      '/api/v1/advisories/:id/ack',
      async (req, reply) => {
        const agentId = req.body?.agent_id;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          return reply.status(400).send({ ok: false, error: 'agent_id is required' });
        }
        const result = advisories.ack(req.params.id, agentId);
        if (!result.ok) {
          const status = result.reason === 'not_found' ? 404 : result.reason === 'wrong_agent' ? 403 : 409;
          return reply.status(status).send({ ok: false, error: result.reason });
        }
        return {
          ok: true,
          already_acknowledged: result.alreadyAcknowledged,
          advisory: { id: result.advisory.id, state: result.advisory.state, condition_key: result.advisory.condition_key },
        };
      },
    );
  }

  server.post<{ Body: unknown }>('/api/v1/approvals', async (req, reply) => {
    const parsed = ApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const body = parsed.data;

    // The PermissionRequest hook can't see its pane's agent id (only the MCP
    // server's env carries AGENTBUS_AGENT_ID), so it identifies itself by
    // Claude session id — same as the turn-ended hook — and the pane's own
    // agent id is recovered from the lease row that recorded that session.
    let agentId = body.agentId;
    if (!agentId && body.adapterId === 'cc-pool' && poolManagers) {
      for (const manager of poolManagers.values()) {
        const pane = manager.leaseStore.list(manager.poolId).find((p) => p.claude_session_id === body.sessionId);
        if (pane) {
          agentId = toBareAgentId(pane.agent_id);
          break;
        }
      }
    }
    if (!agentId) {
      return reply.status(422).send({ ok: false, error: 'could not determine the requesting agent' });
    }

    const target = resolveApprovalTarget(db, body.adapterId, agentId, body.conversationId);
    if (!target) {
      console.error(`[approvals] no target for ${body.adapterId}/${agentId} — request dropped (${body.toolName})`);
      return reply.status(422).send({ ok: false, error: 'could not resolve who to ask for this request' });
    }

    const duplicate = approvalStore.findPendingDuplicate(body.adapterId, agentId, body.toolName, body.summary);
    if (duplicate) return { ok: true, id: duplicate.id, status: duplicate.status, duplicate: true };

    const request = approvalStore.insert(
      {
        adapterId: body.adapterId,
        agentId,
        conversationId: target.conversationId,
        contactId: target.contactId,
        toolName: body.toolName,
        summary: body.summary,
        context: body.context,
      },
      APPROVAL_TIMEOUT_MS,
    );
    await dispatchApproval({ registry, store: approvalStore }, request, target.channel);
    return { ok: true, id: request.id, status: approvalStore.getById(request.id)!.status };
  });

  server.get<{ Querystring: { status?: string } }>('/api/v1/approvals', async (req, reply) => {
    const status = req.query.status;
    const valid: ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired', 'stale'];
    if (status && !valid.includes(status as ApprovalStatus)) {
      return reply.status(400).send({ ok: false, error: `status must be one of ${valid.join(', ')}` });
    }
    return { ok: true, approvals: approvalStore.list(status as ApprovalStatus | undefined) };
  });

  server.get<{ Params: { id: string } }>('/api/v1/approvals/:id', async (req, reply) => {
    const row = approvalStore.getById(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Approval request not found' });
    return { ok: true, approval: row };
  });

  server.post<{ Params: { id: string }; Body: { decision?: string; resolvedBy?: string } }>(
    '/api/v1/approvals/:id/resolve',
    async (req, reply) => {
      const { decision, resolvedBy } = req.body ?? {};
      if (decision !== 'approve' && decision !== 'deny') {
        return reply.status(400).send({ ok: false, error: 'decision must be "approve" or "deny"' });
      }
      const result = await resolveApproval(
        { store: approvalStore, poolManagers: poolManagers ?? new Map(), ...deps.approvalHooks },
        req.params.id,
        decision,
        resolvedBy ?? 'api',
      );
      if (result.outcome === 'not_found' || result.outcome === 'forbidden') {
        return reply.status(404).send({ ok: false, error: 'Approval request not found' });
      }
      return { ok: true, outcome: result.outcome, approval: result.request };
    },
  );

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
    // E48 (S48.4) — record this poll so cc-pool's pane-launch readiness gate
    // can tell a pane's cc.ts has come up (see src/http/agent-liveness.ts).
    recordAgentPoll(agent ?? toBareAgentId(recipient!));
    // E66 — messages for a conversation with an open System Message journal
    // run wait in the queue until the run ends.
    const gate = deps.journalGate;
    const messages = queue.dequeue(recipientId, topic, parsedLimit, gate ? (env) => gate.isHeld(env) : undefined);
    return {
      ok: true,
      messages: messages.map((m) => m.envelope),
      count: messages.length,
    };
  });

  // GET /api/v1/agents/:agentId/last-poll — E48 (S48.4): last time this bare
  // agent id was seen polling /api/v1/messages/pending, or null if never seen.
  server.get<{ Params: { agentId: string } }>('/api/v1/agents/:agentId/last-poll', async (req, _reply) => {
    return { ok: true, agentId: req.params.agentId, lastPollAt: getLastPollAt(req.params.agentId) };
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

    // E66 — during a System Message journal run the agent may not message
    // anyone. journal_complete and advisory_ack use their own endpoints.
    const blockedBy = deps.journalGate?.blockedSend(data.sender);
    if (blockedBy) {
      return reply.status(409).send({
        ok: false,
        error: 'journal_run_in_progress',
        reason: `Outbound messages are blocked while journal run ${blockedBy.runId} is open. Finish journaling and call journal_complete; do not reply during the run.`,
      });
    }

    // reply_to (bus message ID) resolves to the referenced transcript's
    // platform_message_id (E28) — the same lookup react_to_message already
    // does — so an adapter can turn it into a native platform reply without
    // ever needing to know platform-specific ID formats itself. A missing or
    // malformed transcript is silently a no-op: the send still proceeds, just
    // without a reply quote. If the referenced message is the *latest* inbound
    // message in its conversation, the quote would be visually redundant — it's
    // already obvious what a reply is responding to — so it's sent as a plain
    // message instead of a native reply in that case.
    // E65 — only the bus adds system blocks; an agent or HTTP caller can't.
    const metadata: Record<string, unknown> = stripSystemMetadata(data.metadata);
    // Captured alongside the reply_to lookup below so the E48 (S48.6)
    // stale-pane guard further down can reuse this same query result instead
    // of re-running it.
    let replyToConversationId: string | null = null;
    if (data.reply_to) {
      const transcript = db
        .prepare(`SELECT conversation_id, metadata FROM transcripts WHERE message_id = ? LIMIT 1`)
        .get(data.reply_to) as { conversation_id: string; metadata: string } | undefined;
      if (transcript) {
        replyToConversationId = transcript.conversation_id;
        const latestInbound = db
          .prepare(
            `SELECT t.message_id FROM transcripts t WHERE t.conversation_id = ? AND t.direction = 'inbound' AND ${VISIBLE_TRANSCRIPT} ORDER BY t.created_at DESC LIMIT 1`,
          )
          .get(transcript.conversation_id) as { message_id: string } | undefined;
        const isLatestInbound = latestInbound?.message_id === data.reply_to;

        if (!isLatestInbound) {
          try {
            const meta = JSON.parse(transcript.metadata) as Record<string, unknown>;
            if (typeof meta['platform_message_id'] === 'string') {
              metadata['reply_to_platform_message_id'] = meta['platform_message_id'];
            }
          } catch {
            // malformed transcript metadata — leave reply_to_platform_message_id unset
          }
        }
      }
    }

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
      metadata,
    };

    if (data.channel === 'app') {
      const contactId = data.recipient.replace(/^contact:/, '');
      const agentId = routedAgent(config, contactId);
      if (!agentId) return reply.status(400).send({ ok: false, error: 'App channel is not routed for this contact' });
      const bound = boundAppReply(db, data.reply_to, contactId, agentId);
      if (bound) {
        envelope.metadata['bound_session_id'] = bound.sessionId;
        envelope.metadata['conversation_id'] = bound.conversationId;
      } else {
        delete envelope.metadata['bound_session_id'];
        const target = validateAppDestination(db, contactId, agentId, data.topic);
        if (!target.ok) return reply.status(400).send({ ok: false, error: target.error });
      }
    }

    // E48 (S48.6) — stale-pane guard. A pool pane (e.g. "agent:peggy-pool-3")
    // can be evicted (its pool_leases row reassigned to a different
    // conversation) while a reply it generated for its PREVIOUS conversation
    // is still in flight. Reject a reply whose conversation no longer matches
    // the sending pane's lease — before the message is ever enqueued.
    //
    // Only reply-linked sends are guarded. The conversation comes from:
    //   1. The reply_to -> transcripts.conversation_id lookup above.
    //   2. Else data.metadata.conversation_id, when a non-empty string (set
    //      by the `reply` MCP tool — see src/mcp/tools/index.ts).
    // Proactive sends (send_message/send_email: no reply_to, no
    // conversation_id) are deliberately NOT guarded. The agent addresses
    // them explicitly, and a pane leased to one conversation routinely
    // messages another — e.g. a scheduled-topic pane notifying the user's
    // DM. Deriving a conversation id for those rejected every such send as
    // a "stale sender" (docs/bugs/2026-09-26-scheduled-scans-invisible-and-stale-sender).
    let conversationId: string | null = null;
    if (replyToConversationId) {
      conversationId = replyToConversationId;
    } else if (
      typeof data.metadata?.['conversation_id'] === 'string' &&
      data.metadata['conversation_id'].length > 0
    ) {
      conversationId = data.metadata['conversation_id'];
    }

    if (conversationId) {
      const leaseStore = new LeaseStore(db);
      const leaseRow = leaseStore.findByAgentAnyPool(data.sender);
      if (leaseRow && leaseRow.state === 'leased' && leaseRow.conversation_id !== conversationId) {
        console.error(
          `[pool-guard] stale sender: sender=${data.sender} reply_conversation_id=${conversationId} ` +
            `lease_conversation_id=${leaseRow.conversation_id} — rejecting`,
        );
        return reply.status(409).send({
          ok: false,
          error: `stale sender: pane ${data.sender} is no longer leased to this conversation`,
        });
      }
      // No matching lease row (not a pool-tracked sender — the common case),
      // or conversation_id matches, or the row isn't currently 'leased':
      // nothing to guard against, proceed normally.
    }

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

  // GET /api/v1/adapters/resolve?channel=... — does any adapter handle this
  // channel? Backed by the same lookupPrimaryByChannel real delivery uses
  // (including a dynamically-derived channel via ownsChannel, E28), so tool-side
  // channel-exists validation (e.g. send_message) can't drift out of sync with it.
  server.get<{ Querystring: { channel?: string } }>('/api/v1/adapters/resolve', async (req, reply) => {
    const { channel } = req.query;
    if (!channel) {
      return reply.status(400).send({ ok: false, error: 'channel is required' });
    }
    const adapter = registry.lookupPrimaryByChannel(channel);
    return { ok: true, exists: adapter != null };
  });

  // POST /api/v1/adapters/:id/typing — signal that the agent received a message;
  // adapter starts its typing indicator so the user sees activity while Claude works.
  // `:id` is a channel (matched via lookupPrimaryByChannel, which also covers a
  // dynamically-derived channel via ownsChannel, E28) — for every channel that
  // predates E28, adapter id === channel, so this is unchanged for them. `topic`
  // (E28) further targets a specific forum topic within a group channel.
  // Fire-and-forget by callers — always returns 200, even when adapter is not found
  // or doesn't support typing (no-op in those cases).
  server.post<{ Params: { id: string }; Body: { contact_id?: string; topic?: string; conversation_id?: string } }>(
    '/api/v1/adapters/:id/typing',
    async (req, _reply) => {
      const adapter = registry.lookupPrimaryByChannel(req.params.id);
      if (adapter?.capabilities.typing && typeof adapter.startTyping === 'function') {
        adapter.startTyping(req.body.contact_id ?? '', req.params.id, req.body.topic, req.body.conversation_id);
      }
      return { ok: true };
    },
  );

  // POST /api/v1/adapters/:id/tool-status — live tool-call status line for an
  // in-flight turn (E29). `:id` is a channel, resolved the same way as `/typing`
  // above; `topic` (E28) further targets a specific forum topic. `placeholder`
  // (cc-pool cold-start line) is passed through unchanged — see
  // AdapterInstance.reportToolCall's doc comment in src/core/registry.ts for
  // what an implementing adapter should do with it. Fire-and-forget by
  // callers — always returns 200, even when the adapter is not found or
  // doesn't support the capability (no-op in those cases).
  server.post<{
    Params: { id: string };
    Body: { contact_id?: string; text?: string; topic?: string; placeholder?: boolean; conversation_id?: string };
  }>('/api/v1/adapters/:id/tool-status', async (req, _reply) => {
    const adapter = registry.lookupPrimaryByChannel(req.params.id);
    if (adapter?.capabilities.toolStatus && typeof adapter.reportToolCall === 'function' && req.body.text) {
      adapter.reportToolCall(req.body.contact_id ?? '', req.body.text, req.params.id, req.body.topic, req.body.placeholder, req.body.conversation_id);
    }
    return { ok: true };
  });

  // POST /api/v1/adapters/:id/topics — create a new forum topic (E28,
  // Telegram groups only). `:id` is a channel, resolved the same way as
  // `/typing`/`/tool-status` above. Unlike those, this is a real
  // request/response (the agent needs the created topic's id back), so it
  // 404s/400s on resolution failure rather than silently no-opping.
  server.post<{ Params: { id: string }; Body: { name?: string; context?: string } }>(
    '/api/v1/adapters/:id/topics',
    async (req, reply) => {
      const { name, context } = req.body ?? {};
      if (!name || typeof name !== 'string') {
        return reply.status(400).send({ ok: false, error: 'name is required' });
      }

      const adapter = registry.lookupPrimaryByChannel(req.params.id);
      if (!adapter) {
        return reply.status(404).send({ ok: false, error: `No adapter registered for channel: ${req.params.id}` });
      }
      if (typeof adapter.createTopic !== 'function') {
        return reply.status(400).send({
          ok: false,
          error: `Topic creation not supported on channel: ${req.params.id}`,
        });
      }

      const result = await adapter.createTopic(req.params.id, name, context);
      return result;
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
      WHERE fts.body MATCH ? AND ${VISIBLE_TRANSCRIPT}
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
             cr.topic,
             CASE WHEN s.channel = 'app' AND cr.topic = 'general' THEN 'Main'
                  WHEN s.channel = 'app' THEN json_extract(
                    (SELECT t.metadata FROM threads t WHERE t.channel = 'app' AND t.topic = cr.topic), '$.title')
                  ELSE NULL END AS title
      FROM sessions s
      LEFT JOIN conversation_registry cr ON cr.id = s.conversation_id
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
        topic: string | null;
        title: string | null;
      }>;

      const sessions = rows;

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
                cr.topic,
                CASE WHEN s.channel = 'app' AND cr.topic = 'general' THEN 'Main'
                     WHEN s.channel = 'app' THEN json_extract(
                       (SELECT t.metadata FROM threads t WHERE t.channel = 'app' AND t.topic = cr.topic), '$.title')
                     ELSE NULL END AS title
         FROM sessions s
         LEFT JOIN conversation_registry cr ON cr.id = s.conversation_id
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
          topic: string | null;
          title: string | null;
        }
      | undefined;

    if (!row) {
      return reply.status(404).send({ ok: false, error: 'Session not found' });
    }

    return { ok: true, session: row };
  });

  // GET /api/v1/sessions/:id/transcript — full ordered message history for a
  // session (E35). Unlike /api/v1/transcripts/search (FTS5, cross-session,
  // relevance-ranked, DESC), this returns everything that happened in one
  // specific session, oldest first — the natural reading order for a transcript.
  server.get<{
    Params: { id: string };
    Querystring: { limit?: string; since?: string; before?: string };
  }>('/api/v1/sessions/:id/transcript', (req, reply) => {
    const { id } = req.params;
    const { limit: limitStr, since, before } = req.query;

    const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(id);
    if (!session) {
      return reply.status(404).send({ ok: false, error: 'Session not found' });
    }

    const parsedLimit = Math.max(1, Math.min(parseInt(limitStr ?? '200', 10) || 200, 1000));

    let sql = `
      SELECT message_id, session_id, channel, contact_id, direction, body, created_at
      FROM transcripts t
      WHERE session_id = ? AND ${VISIBLE_TRANSCRIPT}
    `;
    const params: unknown[] = [id];

    if (since) {
      sql += ` AND created_at > ?`;
      params.push(since);
    }
    if (before) {
      sql += ` AND created_at < ?`;
      params.push(before);
    }
    sql += ` ORDER BY created_at ASC LIMIT ?`;
    params.push(parsedLimit);

    const transcript = db.prepare(sql).all(...params) as Array<{
      message_id: string;
      session_id: string;
      channel: string;
      contact_id: string;
      direction: string;
      body: string;
      created_at: string;
    }>;

    return { ok: true, transcript, count: transcript.length };
  });

  // GET /api/v1/attachments/:id — resolve a stored attachment by id.
  // Used by the fetch_attachment MCP tool to pull in inline email images on
  // demand. Returns the on-disk path so the (co-located) agent can read it.
  server.get<{ Params: { id: string } }>('/api/v1/attachments/:id', async (req, reply) => {
    const { id } = req.params;
    const row = db
      .prepare(
        `SELECT local_path, mime_type, original_filename, expires_at FROM attachments WHERE id = ?`,
      )
      .get(id) as
      | {
          local_path: string;
          mime_type: string | null;
          original_filename: string | null;
          expires_at: number;
        }
      | undefined;

    if (!row || row.expires_at <= Date.now()) {
      return reply.status(404).send({ ok: false, error: `Attachment not found: ${id}` });
    }

    return {
      ok: true,
      attachment: {
        id,
        local_path: row.local_path,
        mime_type: row.mime_type,
        original_filename: row.original_filename,
      },
    };
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

  // ── Knowledge store endpoints (agent-managed structured knowledge, Phase 1) ──
  //
  // Always-on (no config flag gates it, no `available: false` degradation —
  // ordinary 400/404/500 is correct here). See src/knowledge/store.ts and
  // docs/KNOWLEDGE_STORE.md.

  const KnowledgeWriteSchema = z.object({
    agent_id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    payload: z.string().min(1),
    index_note: z.string().optional(),
    tags: z.array(z.string()).optional(),
    facets: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    event_at: z.string().optional(),
    valid_from: z.string().optional(),
    relevant_until: z.string().optional(),
    expires_at: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
    session_id: z.string().optional(),
    contact_id: z.string().optional(),
    channel: z.string().optional(),
    supersedes: z.string().optional(),
  });

  // POST /api/v1/knowledge — write a new knowledge row
  server.post<{ Body: unknown }>('/api/v1/knowledge', async (req, reply) => {
    const parsed = KnowledgeWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }

    try {
      const result = writeKnowledge(db, parsed.data);
      return reply.status(201).send({
        ok: true,
        id: result.id,
        content_hash: result.contentHash,
        superseded_id: result.supersededId,
      });
    } catch (err) {
      return reply.status(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/v1/knowledge/search — FTS5 + filter search over knowledge rows
  server.get<{
    Querystring: {
      q?: string;
      agent_id?: string;
      kind?: string;
      tags?: string;
      facets?: string;
      event_from?: string;
      event_to?: string;
      limit?: string;
    };
  }>('/api/v1/knowledge/search', async (req, reply) => {
    const { q, agent_id, kind, tags, facets, event_from, event_to, limit } = req.query;

    if (!agent_id || agent_id.trim().length === 0) {
      return reply.status(400).send({ ok: false, error: 'Query parameter "agent_id" is required' });
    }

    let facetsObj: Record<string, string | number | boolean> | undefined;
    if (facets !== undefined) {
      try {
        facetsObj = JSON.parse(facets) as Record<string, string | number | boolean>;
      } catch {
        return reply.status(400).send({ ok: false, error: 'Query parameter "facets" must be valid JSON' });
      }
    }

    try {
      const result = searchKnowledge(db, {
        agent_id,
        q,
        kind,
        tags: tags ? tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0) : undefined,
        facets: facetsObj,
        event_from,
        event_to,
        limit: limit !== undefined ? parseInt(limit, 10) : undefined,
      });
      return { ok: true, results: result.results, count: result.count };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/v1/knowledge/:id — fetch one row (bumps recall bookkeeping)
  server.get<{ Params: { id: string } }>('/api/v1/knowledge/:id', async (req, reply) => {
    const row = getKnowledge(db, req.params.id);
    if (!row) {
      return reply.status(404).send({ ok: false, error: `Knowledge row not found: ${req.params.id}` });
    }
    return { ok: true, knowledge: row };
  });

  // POST /api/v1/knowledge/:id/forget — supersede, expire, or hard-delete a row
  const KnowledgeForgetSchema = z.object({
    mode: z.enum(['supersede', 'expire', 'delete']),
    superseded_by: z.string().optional(),
  });

  server.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/knowledge/:id/forget',
    async (req, reply) => {
      const parsed = KnowledgeForgetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.message });
      }

      try {
        forgetKnowledge(db, req.params.id, parsed.data.mode, { supersededBy: parsed.data.superseded_by });
        return { ok: true };
      } catch (err) {
        return reply.status(400).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ── Schedule endpoints (E18) ─────────────────────────────────────────────────

  const ScheduleCreateSchema = z
    .object({
      type: z.enum(['once', 'cron']),
      cron_expr: z.string().optional(),
      fire_at: z.string().optional(),
      timezone: z.string().default('UTC'),
      channel: z.string().min(1),
      sender: z.string().min(1),
      payload_body: z.string().min(1),
      // No default here (E53 D1) — omitted means "the scheduler decides":
      // sched:<label-slug> for a cron schedule, general for a one-shot.
      topic: z.string().min(1).optional(),
      priority: z.enum(['normal', 'high', 'urgent']).default('normal'),
      label: z.string().optional(),
      created_by: z.string().default('http'),
      max_fires: z.number().int().positive().optional(),
      stale_after_ms: z.number().int().positive().optional(),
      model: z.string().min(1).max(100).optional(),
    })
    .refine(
      (d) => {
        if (d.type === 'cron') return !!d.cron_expr;
        if (d.type === 'once') return !!d.fire_at;
        return false;
      },
      { message: 'cron schedules require cron_expr; once schedules require fire_at' },
    )
    .refine((d) => !(d.type === 'cron' && d.stale_after_ms !== undefined), {
      message: 'stale_after_ms is only valid on type: once schedules',
    });

  const SchedulePatchSchema = z.object({
    label: z.string().optional(),
    max_fires: z.number().int().positive().nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
    topic: z.string().min(1).optional(),
    /** null clears the job's model, falling back to the agent/global override or the pool's model. */
    model: z.string().min(1).max(100).nullable().optional(),
  });

  // POST /api/v1/schedules — create a schedule
  server.post<{ Body: unknown }>('/api/v1/schedules', async (req, reply) => {
    const parsed = ScheduleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const data = parsed.data;

    // Validate cron expression and calculate fire_at
    let fireAt: string;
    if (data.type === 'cron') {
      let nextFire: string | null = null;
      try {
        const { Cron } = await import('croner');
        const job = new Cron(data.cron_expr!, { timezone: data.timezone, paused: true });
        const next = job.nextRun();
        job.stop();
        nextFire = next ? next.toISOString() : null;
      } catch (err) {
        return reply.status(400).send({ ok: false, error: `Invalid cron expression: ${String(err)}` });
      }
      if (!nextFire) {
        return reply.status(400).send({ ok: false, error: 'Cron expression has no future occurrences' });
      }
      fireAt = nextFire;
    } else {
      const ts = new Date(data.fire_at!);
      if (isNaN(ts.getTime())) {
        return reply.status(400).send({ ok: false, error: 'fire_at is not a valid ISO 8601 timestamp' });
      }
      if (ts <= new Date()) {
        return reply.status(400).send({ ok: false, error: 'fire_at must be in the future' });
      }
      fireAt = ts.toISOString();
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    // E53 D1: a recurring schedule with no explicit topic gets its own
    // sched:<slug> conversation; one-shots stay in general.
    const topic = data.topic ?? defaultScheduleTopic(data.type, data.label ?? null, id);

    db.prepare(
      `INSERT INTO scheduled_items
         (id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
          topic, priority, label, model, created_at, created_by, fire_count, max_fires,
          stale_after_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active')`,
    ).run(
      id,
      data.type,
      data.cron_expr ?? null,
      data.timezone,
      fireAt,
      data.channel,
      data.sender,
      data.payload_body,
      topic,
      data.priority,
      data.label ?? null,
      data.model ?? null,
      now,
      data.created_by,
      data.max_fires ?? null,
      data.stale_after_ms ?? null,
    );

    return reply.status(201).send({ ok: true, id, fire_at: fireAt, topic });
  });

  // GET /api/v1/schedules — list schedules
  server.get<{
    Querystring: { status?: string; channel?: string; created_by?: string; limit?: string };
  }>('/api/v1/schedules', (req, _reply) => {
    const { status: statusFilter, channel, created_by, limit: limitStr } = req.query;
    const limit = Math.max(1, Math.min(parseInt(limitStr ?? '50', 10) || 50, 200));

    let sql = `SELECT * FROM scheduled_items WHERE 1=1`;
    const params: unknown[] = [];

    if (statusFilter) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }
    if (channel) {
      sql += ` AND channel = ?`;
      params.push(channel);
    }
    if (created_by) {
      sql += ` AND created_by = ?`;
      params.push(created_by);
    }
    sql += ` ORDER BY fire_at ASC LIMIT ?`;
    params.push(limit);

    const schedules = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return { ok: true, schedules, count: schedules.length };
  });

  // GET /api/v1/schedules/:id — fetch a single schedule
  server.get<{ Params: { id: string } }>('/api/v1/schedules/:id', (req, reply) => {
    const row = db
      .prepare(`SELECT * FROM scheduled_items WHERE id = ?`)
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) {
      return reply.status(404).send({ ok: false, error: 'Schedule not found' });
    }
    return { ok: true, schedule: row };
  });

  // DELETE /api/v1/schedules/:id — cancel a schedule
  server.delete<{ Params: { id: string } }>('/api/v1/schedules/:id', (req, reply) => {
    const result = db
      .prepare(
        `UPDATE scheduled_items SET status = 'cancelled'
         WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
      )
      .run(req.params.id);
    if (result.changes === 0) {
      return reply.status(404).send({
        ok: false,
        error: 'Schedule not found or already cancelled/completed',
      });
    }
    return { ok: true, id: req.params.id };
  });

  // PATCH /api/v1/schedules/:id — update label, max_fires, or status (pause↔active)
  server.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/schedules/:id', (req, reply) => {
    const parsed = SchedulePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const { label, max_fires, status: newStatus, topic, model } = parsed.data;

    const existing = db
      .prepare(`SELECT status, fire_count FROM scheduled_items WHERE id = ?`)
      .get(req.params.id) as { status: string; fire_count: number } | undefined;

    if (!existing) {
      return reply.status(404).send({ ok: false, error: 'Schedule not found' });
    }
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return reply.status(400).send({
        ok: false,
        error: `Cannot update a ${existing.status} schedule`,
      });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (label !== undefined) { updates.push('label = ?'); values.push(label); }
    if (topic !== undefined) { updates.push('topic = ?'); values.push(topic); }
    if (model !== undefined) { updates.push('model = ?'); values.push(model); }
    if (max_fires !== undefined) {
      updates.push('max_fires = ?');
      values.push(max_fires);
      // If max_fires is now at or below the current fire_count, complete immediately
      // rather than leaving an active schedule that can never advance.
      if (max_fires !== null && max_fires <= existing.fire_count) {
        updates.push('status = ?');
        values.push('completed');
      }
    }
    if (newStatus !== undefined && !values.includes('completed')) {
      updates.push('status = ?');
      values.push(newStatus);
    }

    if (updates.length === 0) {
      return reply.status(400).send({ ok: false, error: 'No updatable fields provided' });
    }

    values.push(req.params.id);
    db.prepare(`UPDATE scheduled_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db
      .prepare(`SELECT * FROM scheduled_items WHERE id = ?`)
      .get(req.params.id) as Record<string, unknown>;
    return { ok: true, schedule: updated };
  });

  // POST /api/v1/inbound — pipeline entry point for raw inbound messages
  server.post<{ Body: unknown }>('/api/v1/inbound', async (req, reply) => {
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) {
      console.log(`[http:inbound] rejected — validation failed: ${parsed.error.message}`);
      return reply.status(400).send({ ok: false, error: parsed.error.message });
    }
    const { channel, sender, payload } = parsed.data;
    const rawBody = payload.type === 'reaction'
      ? `[reaction:${payload.removed ? 'removed' : 'added'} ${payload.emoji}]`
      : payload.body;
    const preview = rawBody.length > 60 ? `${rawBody.slice(0, 60)}…` : rawBody;
    console.log(`[http:inbound] channel=${channel} sender=${sender} body="${preview}"`);
    // Session binding is a capability of the authenticated app socket, not a
    // caller-controlled inbound field on the general API.
    const inbound = { ...parsed.data, metadata: { ...parsed.data.metadata } };
    delete inbound.metadata['bound_session_id'];
    delete inbound.metadata['session_channel'];
    delete inbound.metadata['session_topic'];
    const result = await processInbound(inbound, {
      queue,
      pipeline,
      config,
      db,
      registry,
      commandRegistry: deps.commandRegistry,
      pauseSet: deps.pauseSet,
    });
    if (result.queued) {
      console.log(`[http:inbound] queued id=${result.id} enqueued_count=${result.enqueued_count}`);
    } else {
      console.log(`[http:inbound] not queued reason=${result.reason}`);
    }
    return result;
  });

  // ── Model override endpoints (E53 S53.1) ────────────────────────────────────
  //
  // POST   /api/v1/model-overrides       — Set an agent or global model override
  // GET    /api/v1/model-overrides       — List all overrides
  // DELETE /api/v1/model-overrides       — Delete a specific override or all
  //
  // Backs the `model_overrides` table (migration 021). A job's own model
  // lives on its schedule (`scheduled_items.model`), not here — see
  // docs/SCHEDULING.md. These endpoints only manage the agent-wide and
  // global fallbacks that both cc-headless and cc-pool consult.

  interface ModelOverrideRow {
    id: number;
    agent_id: string | null;
    model: string;
    created_at: string;
    updated_at: string;
  }

  // POST /api/v1/model-overrides — Set or update an agent or global model override
  server.post<{ Body: { model: string; agent_id?: string | null; schedule_id?: string | null } }>(
    '/api/v1/model-overrides',
    async (req, reply) => {
      try {
        const { model, agent_id, schedule_id } = req.body;

        if (schedule_id) {
          return reply.status(400).send({
            ok: false,
            error:
              "A job's model now lives on its schedule (the schedule's `model` field), not on a schedule-scoped " +
              'override. Use PATCH /api/v1/schedules/:id with { "model": ... } instead.',
          });
        }

        if (!model || typeof model !== 'string' || model.trim().length === 0) {
          return reply.status(400).send({ ok: false, error: 'model is required and must be a non-empty string' });
        }

        const aId = agent_id ?? null;
        const now = new Date().toISOString();

        db.prepare(
          `INSERT INTO model_overrides (agent_id, model, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(COALESCE(agent_id, '')) DO UPDATE SET
             model = excluded.model,
             updated_at = excluded.updated_at`,
        ).run(aId, model, now, now);

        const row = db
          .prepare(
            `SELECT id, agent_id, model, created_at, updated_at FROM model_overrides WHERE agent_id IS ?`,
          )
          .get(aId) as ModelOverrideRow | undefined;

        return reply.status(201).send({
          ok: true,
          id: row?.id,
          override: row,
        });
      } catch (err) {
        console.error('[http:model-overrides] POST failed:', err);
        return reply.status(500).send({ ok: false, error: 'Failed to set model override' });
      }
    }
  );

  // GET /api/v1/model-overrides — List all model overrides
  server.get('/api/v1/model-overrides', async (_req, reply) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, agent_id, model, created_at, updated_at
           FROM model_overrides
           ORDER BY agent_id IS NULL, updated_at DESC`,
        )
        .all() as ModelOverrideRow[];

      return reply.send({
        ok: true,
        overrides: rows,
        count: rows.length,
      });
    } catch (err) {
      console.error('[http:model-overrides] GET failed:', err);
      return reply.status(500).send({ ok: false, error: 'Failed to list model overrides' });
    }
  });

  // DELETE /api/v1/model-overrides — Delete a specific override or all overrides
  server.delete<{ Querystring: { agent_id?: string; scope?: string; all?: string } }>(
    '/api/v1/model-overrides',
    async (req, reply) => {
      try {
        const { agent_id, scope, all } = req.query;

        if (all === 'true') {
          const result = db.prepare(`DELETE FROM model_overrides`).run();
          return reply.send({
            ok: true,
            deleted_count: result.changes,
            message: `Cleared ${result.changes} model override(s)`,
          });
        }

        if (!agent_id && scope !== 'global') {
          return reply.status(400).send({
            ok: false,
            error: 'Provide agent_id, or scope=global, to delete, or pass all=true to clear all',
          });
        }

        const aId = scope === 'global' ? null : (agent_id as string);
        const result = db.prepare(`DELETE FROM model_overrides WHERE agent_id IS ?`).run(aId);

        return reply.send({
          ok: true,
          deleted_count: result.changes,
          message: `Deleted ${result.changes} override(s) for ${aId === null ? 'scope=global' : `agent_id=${aId}`}`,
        });
      } catch (err) {
        console.error('[http:model-overrides] DELETE failed:', err);
        return reply.status(500).send({ ok: false, error: 'Failed to delete model override' });
      }
    }
  );

  // POST /api/v1/webhooks/pebble — Pebble Ring voice-memo ingestion (E25).
  //
  // The bearer token IS the sender's identity: it is looked up directly
  // against contacts[*].platforms.pebble.token and resolves `sender` straight
  // to the canonical `contact:<id>` form. There is no fallback identity for
  // an unrecognized token — auth failure is always a hard 401, never a
  // platform:pebble:<token> passthrough (unlike Telegram/email's unknown-sender
  // handling in contact-resolve.ts).
  if (config.adapters.pebble?.enabled) {
    const pebbleConfig = config.adapters.pebble;
    const contactIdByToken = new Map<string, string>();
    for (const contact of Object.values(config.contacts)) {
      const token = contact.platforms.pebble?.token;
      if (token) contactIdByToken.set(token, contact.id);
    }

    server.post('/api/v1/webhooks/pebble', async (req, reply) => {
      // Best-effort raw-request logging (E38), off by default — see
      // adapters.pebble.logging. Never affects the actual response.
      const logRequest = (ok: boolean, status: number, reason: string, extra: Record<string, unknown> = {}) =>
        logWebhookRequest(pebbleConfig.logging, {
          webhook: 'pebble',
          ok,
          status,
          reason,
          raw: {
            headers: {
              'content-type': req.headers['content-type'],
              'content-length': req.headers['content-length'],
            },
            ...extra,
          },
        });

      // Body-size guard before the multipart parser does any work.
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > pebbleConfig.max_body_bytes) {
        logRequest(false, 413, 'body_too_large');
        return reply.status(413).send({ ok: false, error: 'Request body too large' });
      }

      const authHeader = req.headers['authorization'];
      const token =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice('Bearer '.length)
          : undefined;
      const contactId = token ? contactIdByToken.get(token) : undefined;
      if (!contactId) {
        console.log('[http:pebble] rejected — missing or unrecognized bearer token');
        logRequest(false, 401, 'unauthorized');
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }

      if (!req.isMultipart()) {
        logRequest(false, 400, 'not_multipart');
        return reply.status(400).send({ ok: false, error: 'Content-Type must be multipart/form-data' });
      }

      const fields: Record<string, string> = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            fields[part.fieldname] = String(part.value ?? '');
          }
        }
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
        console.log(`[http:pebble] rejected — multipart parse error: ${(err as Error).message}`);
        logRequest(false, statusCode, 'multipart_parse_error', { error: (err as Error).message });
        return reply.status(statusCode).send({ ok: false, error: 'Malformed multipart body' });
      }

      const transcription = fields['transcription'];
      if (!transcription || transcription.trim() === '') {
        logRequest(false, 400, 'missing_transcription', { fields });
        return reply
          .status(400)
          .send({ ok: false, error: 'transcription field is required and must be non-empty' });
      }

      // Assumed unix epoch SECONDS. Not verified against a live device payload —
      // if the ring's proxy actually sends milliseconds, drop the *1000 below.
      const recordedAtRaw = fields['recordedAt'];
      const recordedAtSeconds = recordedAtRaw ? Number(recordedAtRaw) : NaN;
      if (!recordedAtRaw || !Number.isFinite(recordedAtSeconds)) {
        logRequest(false, 400, 'invalid_recordedAt', { fields });
        return reply
          .status(400)
          .send({ ok: false, error: 'recordedAt field is required and must be a unix epoch number' });
      }

      const client = fields['client'];
      if (client !== 'ring') {
        console.log(`[http:pebble] warning — unexpected client field "${client}"`);
      }

      const preview = transcription.length > 60 ? `${transcription.slice(0, 60)}…` : transcription;
      console.log(`[http:pebble] sender=contact:${contactId} body="${preview}"`);

      // envelope.timestamp is intentionally left unset: MessageQueue.dequeue()
      // always overwrites it with the DB row's enqueue time (see queue.ts
      // rowToQueuedMessage), so any value set here would be silently discarded
      // before reaching a delivered message — this is true for every channel,
      // not pebble-specific. recordedAt (when the memo was actually spoken) is
      // preserved durably in metadata instead, which survives enqueue/dequeue.
      const result = await processInbound(
        {
          channel: 'pebble',
          sender: `contact:${contactId}`,
          payload: { type: 'text', body: transcription },
          metadata: {
            recordedAt: recordedAtSeconds,
            client,
            source: 'pebble',
          },
        },
        {
          queue,
          pipeline,
          config,
          db,
          registry,
          commandRegistry: deps.commandRegistry,
          pauseSet: deps.pauseSet,
        },
      );

      logRequest(true, 200, 'ok', { contactId, fields });

      if (result.queued) {
        console.log(`[http:pebble] queued id=${result.id} enqueued_count=${result.enqueued_count}`);
      } else {
        console.log(`[http:pebble] not queued reason=${result.reason}`);
      }
      return result;
    });
  }

  // /api/v1/siri/* — Siri channel (E42). Mirrors the Pebble block: mounted only
  // when configured, per-contact bearer token as identity. The adapter is the
  // send() target that completes the waiting request — see src/adapters/siri.ts.
  if (config.adapters.siri?.enabled && deps.siri) {
    registerSiriRoutes(server, {
      config,
      registry,
      siri: deps.siri,
      submitInbound: (message) =>
        processInbound(message, {
          queue,
          pipeline,
          config,
          db,
          registry,
          commandRegistry: deps.commandRegistry,
          pauseSet: deps.pauseSet,
        }),
    });
  }

  if (config.adapters.app?.enabled && deps.app) {
    const bridge = await registerAppRoutes(server, {
      config, db, queue, app: deps.app, commandRegistry: deps.commandRegistry,
      getHeadlessSnapshots: deps.getHeadlessSnapshots,
      submitInbound: (message) => processInbound(message, {
        queue, pipeline, config, db, registry,
        commandRegistry: deps.commandRegistry, pauseSet: deps.pauseSet,
      }),
    });
    deps.app.setActivityListener(bridge.activity);
  }

  return server;
}
