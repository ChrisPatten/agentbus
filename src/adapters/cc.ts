/**
 * Claude Code adapter — MCP server for Peggy.
 *
 * Run as a separate process spawned by Claude Code over stdio:
 *   AGENTBUS_CONFIG=/path/to/config.yaml npx tsx src/adapters/cc.ts
 *
 * This process communicates with bus-core exclusively over HTTP.
 * It does NOT import from bus-core internals.
 *
 * IMPORTANT: All logging uses console.error() (stderr).
 * console.log() writes to stdout, which is reserved for the MCP protocol stream.
 */
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config/loader.js';
import { createMcpServer } from '../mcp/server.js';
import { createSamplingQueue } from '../mcp/sampling-queue.js';
import { registerTools, type HealthState } from '../mcp/tools.js';
import type { MessageEnvelope } from '../types/envelope.js';

const AGENT_ID = process.env['AGENTBUS_AGENT_ID'] ?? 'peggy';
const DEGRADED_THRESHOLD = 3;
const DISCONNECTED_THRESHOLD = 10;
const BACKOFF_INTERVAL_MS = 5000;

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = process.env['AGENTBUS_CONFIG'] ?? resolve(process.cwd(), 'config.yaml');
const config = loadConfig(configPath);
const pollIntervalMs = config.adapters['claude-code']?.poll_interval_ms ?? 1000;
const samplingMaxTokens = config.adapters['claude-code']?.sampling_max_tokens ?? 8192;
const busBaseUrl = `http://127.0.0.1:${config.bus.http_port}`;

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
registerTools(mcpServer, busBaseUrl, healthState, messageBuffer);

// ── Sampling helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the connected client declared the `sampling` capability.
 * Pass the result of `mcpServer.server.getClientCapabilities()` directly.
 */
export function detectSamplingCapability(caps: ClientCapabilities | undefined): boolean {
  return !!caps?.sampling;
}

/**
 * Process a batch of successfully-acked messages: push them into the shared
 * buffer and either enqueue a `createMessage` call (when sampling is available)
 * or emit a logging notification so the agent can poll manually.
 */
export function processAckedMessages(
  acked: MessageEnvelope[],
  messageBuffer: MessageEnvelope[],
  samplingAvailable: boolean,
  samplingQueue: { enqueue(text: string): void } | null,
  sendLogging: (msg: string) => void,
): void {
  messageBuffer.push(...acked);
  if (samplingAvailable && samplingQueue !== null) {
    samplingQueue.enqueue(formatMessagesForSampling(acked));
  } else {
    sendLogging(`[agentbus] ${acked.length} new message(s) — call get_pending_messages`);
  }
}

// ── Message formatting ────────────────────────────────────────────────────────

/**
 * Format a batch of message envelopes into a single user-turn string for
 * `sampling/createMessage`. Each message becomes one paragraph; multiple
 * messages in a batch are separated by a blank line.
 */
export function formatMessagesForSampling(envelopes: MessageEnvelope[]): string {
  return envelopes
    .map((env) => {
      const body = env.payload.type === 'text' ? env.payload.body : `[${env.payload.type}]`;
      return `New message from ${env.sender} via ${env.channel} [id:${env.id}]:\n${body}`;
    })
    .join('\n\n');
}

// ── Polling loop ──────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let samplingAvailable = false;

// Sampling queue is initialised after connect() reveals client capabilities.
// If sampling is unavailable, this stays null and sendLoggingMessage is used instead.
let samplingQueue: ReturnType<typeof createSamplingQueue> | null = null;

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

    // Buffer messages and notify Claude Code
    if (acked.length > 0) {
      processAckedMessages(acked, messageBuffer, samplingAvailable, samplingQueue, (msg) => {
        mcpServer.sendLoggingMessage({ level: 'info', data: msg }).catch(() => {});
      });
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

// Check client capabilities after handshake
samplingAvailable = detectSamplingCapability(mcpServer.server.getClientCapabilities());

if (samplingAvailable) {
  console.error('[agentbus] sampling capability detected — proactive delivery enabled');
  samplingQueue = createSamplingQueue(async (text: string) => {
    await mcpServer.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text } }],
      maxTokens: samplingMaxTokens,
    });
  });
} else {
  console.error(
    '[agentbus] sampling capability not declared by client — ' +
      'falling back to sendLoggingMessage; use get_pending_messages to retrieve messages manually'
  );
}

console.error(
  `[agentbus] claude-code adapter ready — polling ${busBaseUrl} for agent:${AGENT_ID} every ${pollIntervalMs}ms`
);

void poll();
