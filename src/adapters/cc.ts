/**
 * Claude Code adapter — MCP server for a Claude Code agent.
 *
 * Run as a separate process spawned by Claude Code over stdio:
 *   AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/cc.ts
 *
 * This process communicates with bus-core exclusively over HTTP.
 * It does NOT import from bus-core internals.
 *
 * IMPORTANT: All logging uses console.error() (stderr).
 * console.log() writes to stdout, which is reserved for the MCP protocol stream.
 *
 * AGENTBUS_TOOLS_ONLY=true — skip the polling loop and serve the headless
 * tool subset (including reply/send_message, excluding get_adapter_status). Used by cc-headless.ts
 * to provide MCP tools to `claude -p` subprocesses via --mcp-config.
 */
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/loader.js';
import { createMcpServer } from '../mcp/server.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from '../mcp/tools/index.js';
import { installBusTokenFetch, resolveBusToken } from '../core/bus-auth.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { isSystemOnly, neutralizeSystemMarkers, readSystemBlocks } from '../core/system-block.js';

const AGENT_ID = process.env['AGENTBUS_AGENT_ID'] ?? 'claude';
const TOOLS_ONLY = process.env['AGENTBUS_TOOLS_ONLY'] === 'true';
const DEGRADED_THRESHOLD = 3;
const DISCONNECTED_THRESHOLD = 10;
const BACKOFF_INTERVAL_MS = 5000;

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = resolve(process.env['AGENTBUS_CONFIG'] ?? 'config.yaml');
const config = loadConfig(configPath);
const pollIntervalMs = resolvePollIntervalMs(
  process.env['AGENTBUS_POLL_INTERVAL_MS'],
  config.adapters['claude-code']?.poll_interval_ms,
);
const busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;

// When bus.auth_token is set (in this config, or passed down as
// AGENTBUS_BUS_TOKEN), every request this process makes to the bus — the
// polling loop and every MCP tool — must carry X-Bus-Token. Patch the global
// fetch once, scoped to busBaseUrl, so no call site can forget it.
installBusTokenFetch(busBaseUrl, resolveBusToken(config));

/**
 * Poll interval for this process: `AGENTBUS_POLL_INTERVAL_MS` (set by cc-pool
 * from the pool's `poll_interval_ms`) wins, then the `claude-code` adapter's
 * `poll_interval_ms`, then 1000ms. A non-positive or non-numeric env value is ignored.
 */
export function resolvePollIntervalMs(envValue: string | undefined, configValue: number | undefined): number {
  const fromEnv = envValue !== undefined ? Number(envValue) : NaN;
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return configValue ?? 1000;
}

// ── Shared mutable state ──────────────────────────────────────────────────────

const healthState: HealthState = {
  status: 'healthy',
  busReachable: false,
  lastPollAt: null,
  consecutiveFailures: 0,
};

const messageBuffer: MessageEnvelope[] = [];

// ── MCP server ────────────────────────────────────────────────────────────────

const mcpServer = createMcpServer();
if (TOOLS_ONLY) {
  registerHeadlessTools(mcpServer, busBaseUrl, AGENT_ID, config);
} else {
  registerAllTools(mcpServer, busBaseUrl, healthState, AGENT_ID, config);
}

// ── Message formatting ────────────────────────────────────────────────────────

/**
 * Format a batch of message envelopes into a single string for delivery.
 * Each message becomes one paragraph; multiple messages in a batch are
 * separated by a blank line.
 */
function fmtTs(iso: string, full: boolean): string {
  const d = new Date(iso);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  const time = `${hh}:${get('minute')}`;
  return full ? `${get('year')}-${get('month')}-${get('day')}T${time}` : time;
}

export function formatMessagesForSampling(envelopes: MessageEnvelope[]): string {
  const parts: string[] = [];

  // Bus-originated system blocks (E65) go first, deduplicated across the
  // batch. Everything after them is neutralized (see src/core/system-block.ts),
  // so no message text can open or close a block of its own.
  const systemBlocks = [...new Set(envelopes.flatMap((env) => readSystemBlocks(env.metadata)))];

  const firstMeta = envelopes[0]?.metadata;

  // One-shot context injected by create_telegram_topic (E28) for a brand-new
  // topic's first turn.
  const topicContext = firstMeta?.injected_topic_context;
  if (typeof topicContext === 'string' && topicContext.length > 0) {
    parts.push(`[Context for this new topic, provided when it was created]\n${topicContext}`);
    delete firstMeta!['injected_topic_context'];
  }

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    let body: string;
    if (env.payload.type === 'text') {
      body = env.payload.body;
    } else if (env.payload.type === 'reaction') {
      const verb = env.payload.removed ? 'removed reaction' : 'reacted';
      body = `[${verb} ${env.payload.emoji} to message ${env.payload.target_message_id}]`;
    } else {
      body = `[${(env.payload as { type: string }).type}]`;
    }
    // Quoted reply context (E28) — a user quote-replying to a message, rendered
    // as a context line before the body (same precedent as the reaction line
    // above), never affecting which session/topic the message routed to.
    const quoted = env.metadata?.['quoted_message'] as
      | { sender_name?: string; text?: string }
      | undefined;
    if (quoted) {
      body = `[Replying to ${quoted.sender_name ?? 'someone'}: "${quoted.text ?? ''}"]\n${body}`;
    }
    const ts = env.timestamp ? ` at ${fmtTs(env.timestamp, i === 0)}` : '';
    // Append [Image: ...] and [File: ...] lines after the body so the agent can
    // read any attached files. Empty-body attachment-only messages become just
    // the attachment line(s).
    const attachments = extractAttachments(env.metadata);
    const attachmentLines = attachments
      .map((a) => {
        if (a.type === 'image') return `[Image: ${a.local_path}]`;
        const label = a.original_filename ? ` — ${a.original_filename}` : '';
        return `[File: ${a.local_path}${label}]`;
      })
      .join('\n');
    // Inline (HTML-embedded) email images are not downloaded into the body;
    // surface a hint with the id so the agent can pull one in via fetch_attachment.
    const inlineLines = extractInlineAttachments(env.metadata)
      .map((a) => {
        const name = a.original_filename ? ` ${a.original_filename}` : '';
        return `[Inline image available${name} — fetch with fetch_attachment(id="${a.id}")]`;
      })
      .join('\n');
    const extraLines = [attachmentLines, inlineLines].filter(Boolean).join('\n');
    const bodyWithImages = body && extraLines ? `${body}\n${extraLines}` : body || extraLines;
    const sessionChannel = env.metadata?.['session_channel'];
    const routeLabel = typeof sessionChannel === 'string' && sessionChannel !== env.channel
      ? `via ${env.channel} (in your ${sessionChannel} session)`
      : `via ${env.channel} (topic: ${env.topic})`;
    // A system-only envelope (E65) carries no human message: only its blocks.
    if (isSystemOnly(env.metadata)) continue;
    parts.push(`New message from ${env.sender} ${routeLabel}${ts} [id:${env.id}]:\n${bodyWithImages}`);
  }

  return [...systemBlocks, ...parts.map(neutralizeSystemMarkers)].join('\n\n');
}

/**
 * Pull attachments out of envelope.metadata. Tolerant of shape drift: anything
 * that is not an object with a known `type` and a string `local_path` is ignored.
 */
function extractAttachments(
  metadata: Record<string, unknown> | undefined,
): Array<{ type: 'image' | 'file'; local_path: string; original_filename?: string }> {
  const raw = metadata?.['attachments'];
  if (!Array.isArray(raw)) return [];
  const out: Array<{ type: 'image' | 'file'; local_path: string; original_filename?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { type, local_path, original_filename } = item as Record<string, unknown>;
    if ((type === 'image' || type === 'file') && typeof local_path === 'string') {
      out.push({
        type,
        local_path,
        ...(typeof original_filename === 'string' ? { original_filename } : {}),
      });
    }
  }
  return out;
}

/**
 * Pull inline-attachment references out of envelope.metadata.inline_attachments.
 * These carry only an id (not a path) — the agent fetches them on demand via the
 * fetch_attachment tool. Tolerant of shape drift, like extractAttachments.
 */
function extractInlineAttachments(
  metadata: Record<string, unknown> | undefined,
): Array<{ id: string; original_filename?: string }> {
  const raw = metadata?.['inline_attachments'];
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; original_filename?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, original_filename } = item as Record<string, unknown>;
    if (typeof id === 'string') {
      out.push({
        id,
        ...(typeof original_filename === 'string' ? { original_filename } : {}),
      });
    }
  }
  return out;
}

/**
 * Send a `notifications/claude/channel` event to wake Claude Code and deliver
 * the formatted message content as an injected channel turn.
 *
 * Claude Code wraps `content` in a `<channel source="...">` tag automatically
 * using the server's registered name and any `meta` entries as attributes.
 * Do NOT wrap the content in XML here.
 */
export function sendChannelNotification(
  server: { notification(n: { method: string; params?: Record<string, unknown> }): void },
  text: string,
): void {
  server.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: { ts: new Date().toISOString() },
    },
  });
}

/**
 * Process a batch of successfully-acked messages: push them into the shared
 * buffer and fire a channel notification to wake Claude Code.
 */
export function processAckedMessages(
  acked: MessageEnvelope[],
  messageBuffer: MessageEnvelope[],
  notify: (text: string) => void,
): void {
  messageBuffer.push(...acked);
  notify(formatMessagesForSampling(acked));
}

// ── Polling loop ──────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

async function poll(): Promise<void> {
  if (shuttingDown) return;

  try {
    const res = await fetch(
      `${busBaseUrl}/api/v1/messages/pending?agent=${AGENT_ID}&limit=10`
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      ok: boolean;
      messages: MessageEnvelope[];
      count: number;
    };

    // Ack each message and only buffer those that acked successfully
    const acked: MessageEnvelope[] = [];
    await Promise.all(
      data.messages.map(async (envelope) => {
        try {
          const ackRes = await fetch(`${busBaseUrl}/api/v1/messages/${envelope.id}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'delivered' }),
          });
          if (ackRes.ok) {
            acked.push(envelope);
          } else {
            console.error(`[agentbus] ack rejected for ${envelope.id}: HTTP ${ackRes.status}`);
          }
        } catch (err: unknown) {
          console.error(`[agentbus] ack failed for ${envelope.id}: ${String(err)}`);
        }
      })
    );

    // Buffer messages and wake Claude Code via channel notification
    if (acked.length > 0) {
      processAckedMessages(acked, messageBuffer, (text) => {
        sendChannelNotification(mcpServer.server, text);
      });

      // Now that Claude Code has the messages, signal each source adapter to
      // start its typing indicator. Fire-and-forget — never blocks the poll loop.
      // Email channels have no typing indicator, so skip them.
      for (const envelope of acked) {
        if (envelope.channel === 'email' || envelope.channel.startsWith('email:')) continue;
        fetch(`${busBaseUrl}/api/v1/adapters/${envelope.channel}/typing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: envelope.sender }),
        }).catch(() => {});
      }
    }

    // Reset health on success
    if (!healthState.busReachable) {
      console.error('[agentbus] Bus reconnected');
    }
    healthState.busReachable = true;
    healthState.consecutiveFailures = 0;
    healthState.lastPollAt = new Date().toISOString();
    healthState.status = 'healthy';
  } catch (err) {
    healthState.consecutiveFailures++;
    healthState.busReachable = false;

    if (healthState.consecutiveFailures === DEGRADED_THRESHOLD) {
      healthState.status = 'degraded';
      console.error(
        `[agentbus] Bus unreachable after ${DEGRADED_THRESHOLD} failures — ` +
          `backing off to ${BACKOFF_INTERVAL_MS}ms intervals`
      );
    } else if (healthState.consecutiveFailures === DISCONNECTED_THRESHOLD) {
      healthState.status = 'disconnected';
      console.error(`[agentbus] Disconnected (${DISCONNECTED_THRESHOLD}+ consecutive failures)`);
    }
  }

  if (!shuttingDown) {
    const nextInterval =
      healthState.consecutiveFailures >= DEGRADED_THRESHOLD ? BACKOFF_INTERVAL_MS : pollIntervalMs;
    pollTimer = setTimeout(() => {
      void poll();
    }, nextInterval);
  }
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer !== null) clearTimeout(pollTimer);
  await mcpServer.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

if (TOOLS_ONLY) {
  console.error(`[agentbus] cc adapter ready (tools-only mode) — serving headless tool subset`);
} else {
  console.error(
    `[agentbus] claude-code adapter ready — polling ${busBaseUrl} for agent:${AGENT_ID} every ${pollIntervalMs}ms`
  );
  void poll();
}
