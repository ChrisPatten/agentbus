/**
 * MCP tool registration barrel.
 *
 * Registers all AgentBus tools on the MCP server:
 *   - reply, get_adapter_status (E2 core tools)
 *   - list_channels (S7.1)
 *   - send_message (S7.2)
 *   - recall_memory, log_memory, search_transcripts (S7.3)
 *   - get_session, list_sessions (S7.4)
 *   - react_to_message (S7.5)
 *   - schedule_message, list_schedules, cancel_schedule (E18)
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageEnvelope } from '../../types/envelope.js';
import { toolError, toolSuccess } from './helpers.js';
import { registerChannelTools } from './channels.js';
import { registerMessagingTools } from './messaging.js';
import { registerMemoryTools } from './memory.js';
import { registerSessionTools } from './sessions.js';
import { registerReactionTools } from './reactions.js';
import { registerScheduleTools } from './scheduling.js';

export { toolError, toolSuccess };

export interface HealthState {
  status: 'healthy' | 'degraded' | 'disconnected';
  busReachable: boolean;
  lastPollAt: string | null;
  consecutiveFailures: number;
}

/**
 * Register all AgentBus MCP tools on the server.
 *
 * @param server      - The MCP server instance
 * @param busBaseUrl  - Base URL of bus-core HTTP API (e.g. "http://127.0.0.1:4000")
 * @param healthState - Mutable health state shared with the polling loop
 */
export function registerAllTools(
  server: McpServer,
  busBaseUrl: string,
  healthState: HealthState,
): void {
  // E2 core tools
  registerCoreTools(server, busBaseUrl, healthState);

  // E7 tools
  registerChannelTools(server, busBaseUrl);
  registerMessagingTools(server, busBaseUrl);
  registerMemoryTools(server, busBaseUrl);
  registerSessionTools(server, busBaseUrl);
  registerReactionTools(server, busBaseUrl);
  registerScheduleTools(server, busBaseUrl);
}

// ── Core tools (E2) ───────────────────────────────────────────────────────────

function registerCoreTools(
  server: McpServer,
  busBaseUrl: string,
  healthState: HealthState,
): void {
  // ── reply ────────────────────────────────────────────────────────────────

  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a message. Looks up the original by message_id, swaps sender/recipient, and posts the outbound message to AgentBus.',
      inputSchema: {
        message_id: z.string().describe('ID of the message to reply to'),
        body: z.string().min(1).describe('Text body of the reply'),
      },
    },
    async ({ message_id, body }) => {
      let original: MessageEnvelope;
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages/${message_id}`);
        if (!res.ok) {
          return toolError(`Message not found: ${message_id}`);
        }
        const data = (await res.json()) as { ok: boolean; message: MessageEnvelope };
        original = data.message;
      } catch (err) {
        return toolError(`Failed to fetch original message: ${String(err)}`);
      }

      const replyBody = {
        channel: original.channel,
        topic: original.topic,
        sender: original.recipient,
        recipient: original.sender,
        reply_to: original.id,
        priority: 'normal' as const,
        payload: { type: 'text' as const, body },
        metadata: {},
      };

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(replyBody),
        });
        const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
        if (!data.ok) {
          return toolError(`Bus rejected reply: ${data.error ?? 'unknown error'}`);
        }
        return toolSuccess({ success: true, outbound_message_id: data.id });
      } catch (err) {
        return toolError(`Failed to send reply: ${String(err)}`);
      }
    }
  );

  // ── get_adapter_status ────────────────────────────────────────────────────

  server.registerTool(
    'get_adapter_status',
    {
      description: 'Return the current health status of the AgentBus claude-code adapter.',
    },
    () => {
      return toolSuccess({
        status: healthState.status,
        bus_reachable: healthState.busReachable,
        last_poll_at: healthState.lastPollAt,
        consecutive_failures: healthState.consecutiveFailures,
      });
    }
  );
}
