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
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/loader.js';
import { createMcpServer } from '../mcp/server.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from '../mcp/tools/index.js';
import { installBusTokenFetch, resolveBusToken } from '../core/bus-auth.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { formatMessagesForSampling } from './message-format.js';

const AGENT_ID = process.env['AGENTBUS_AGENT_ID'] ?? 'claude';
const TOOLS_ONLY = process.env['AGENTBUS_TOOLS_ONLY'] === 'true';
const DEGRADED_THRESHOLD = 3;
const DISCONNECTED_THRESHOLD = 10;
const BACKOFF_INTERVAL_MS = 5000;

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

// ── Message formatting ────────────────────────────────────────────────────────

// E69: the formatter lives in a side-effect-free module so it can be tested
// (and imported) without this entrypoint's config load and stdio server.
export { formatMessagesForSampling };

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

// ── Entrypoint ────────────────────────────────────────────────────────────────

/**
 * Load config, connect the stdio MCP server and (unless tools-only) start the
 * polling loop. Runs only when this file is executed directly, so importing
 * one of the helpers above never starts an adapter inside another process.
 */
async function main(): Promise<void> {
  // ── Config ──────────────────────────────────────────────────────────────────

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

  // ── Shared mutable state ────────────────────────────────────────────────────

  const healthState: HealthState = {
    status: 'healthy',
    busReachable: false,
    lastPollAt: null,
    consecutiveFailures: 0,
  };

  const messageBuffer: MessageEnvelope[] = [];

  // ── MCP server ──────────────────────────────────────────────────────────────

  const mcpServer = createMcpServer();
  if (TOOLS_ONLY) {
    registerHeadlessTools(mcpServer, busBaseUrl, AGENT_ID, config);
  } else {
    registerAllTools(mcpServer, busBaseUrl, healthState, AGENT_ID, config);
  }

  // ── Polling loop ────────────────────────────────────────────────────────────

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

  // ── Shutdown ────────────────────────────────────────────────────────────────

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

  // ── Start ───────────────────────────────────────────────────────────────────

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
}

/**
 * True when `moduleUrl` is the script this process was started with
 * (`tsx src/adapters/cc.ts`, `node dist/adapters/cc.js`, or cc-headless's
 * `tsx src/adapters/cc.js`). Extensions are ignored because tsx maps the
 * `.js` specifier to the `.ts` source.
 */
function isEntrypoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  const canonical = (p: string): string => {
    const abs = resolve(p);
    let dir = dirname(abs);
    try {
      dir = realpathSync(dir);
    } catch {
      // keep the unresolved directory
    }
    return join(dir, basename(abs)).replace(/\.[cm]?[jt]s$/, '');
  };
  return canonical(script) === canonical(fileURLToPath(moduleUrl));
}

if (isEntrypoint(import.meta.url)) await main();
