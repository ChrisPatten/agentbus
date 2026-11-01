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
import { installBusTokenFetch, resolveBusToken, resolveRemoteBusToken } from '../core/bus-auth.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { formatMessagesForSampling } from './message-format.js';
import { startPollLoop, type PollLoop } from './cc-poller.js';

const AGENT_ID = process.env['AGENTBUS_AGENT_ID'] ?? 'claude';
const TOOLS_ONLY = process.env['AGENTBUS_TOOLS_ONLY'] === 'true';
/** E88 — set by cc-pool per pane launch; sent on every poll so the bus can fence stale launches. */
const LAUNCH_ID = process.env['AGENTBUS_LAUNCH_ID']?.trim() || undefined;

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

/**
 * The bus this process talks to: `AGENTBUS_URL` (the variable the hook scripts
 * already use) when set, so a Claude Code session on another machine can reach
 * a remote bus, else the local one on `http_port`. A trailing slash is dropped.
 * The bus token (`bus.auth_token`, or `AGENTBUS_BUS_TOKEN` in the environment)
 * is sent to whichever URL this returns.
 */
export function resolveBusBaseUrl(envValue: string | undefined, httpPort: number): string {
  const fromEnv = envValue?.trim().replace(/\/+$/, '');
  return fromEnv ? fromEnv : `http://127.0.0.1:${httpPort}`;
}

/**
 * The token to send to `resolveBusBaseUrl`'s bus. With `AGENTBUS_URL` set it
 * is a remote bus, so only the environment's token counts (`resolveRemoteBusToken`):
 * the local config's `bus.auth_token` belongs to the local bus and is never sent
 * to another host. Unset, the local rule is unchanged (`resolveBusToken`).
 */
export function resolveBusTokenFor(
  envUrl: string | undefined, config: { bus?: { auth_token?: string | undefined } } | null, env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return envUrl?.trim() ? resolveRemoteBusToken(env) : resolveBusToken(config, env);
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
  const busBaseUrl = resolveBusBaseUrl(process.env['AGENTBUS_URL'], config.bus.http_port);

  // When bus.auth_token is set (in this config, or passed down as
  // AGENTBUS_BUS_TOKEN), every request this process makes to the bus — the
  // polling loop and every MCP tool — must carry X-Bus-Token. Patch the global
  // fetch once, scoped to busBaseUrl, so no call site can forget it.
  installBusTokenFetch(busBaseUrl, resolveBusTokenFor(process.env['AGENTBUS_URL'], config));

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

  let pollLoop: PollLoop | null = null;
  let shuttingDown = false;

  // ── Shutdown ────────────────────────────────────────────────────────────────

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    pollLoop?.stop();
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
      `[agentbus] claude-code adapter ready — polling ${busBaseUrl} for agent:${AGENT_ID} every ${pollIntervalMs}ms` +
        (LAUNCH_ID ? ` (launch ${LAUNCH_ID})` : '')
    );
    pollLoop = startPollLoop({
      busBaseUrl,
      agentId: AGENT_ID,
      ...(LAUNCH_ID ? { launchId: LAUNCH_ID } : {}),
      pollIntervalMs,
      healthState,
      onMessages: (acked) => {
        processAckedMessages(acked, messageBuffer, (text) => {
          sendChannelNotification(mcpServer.server, text);
        });
      },
    });
    // E88: a stale launch only stops polling. The MCP server stays up so the
    // Claude session it belongs to doesn't see its tools vanish mid-turn.
    void pollLoop.stopped.then((reason) => {
      if (reason === 'stale_launch') healthState.status = 'disconnected';
    });
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
