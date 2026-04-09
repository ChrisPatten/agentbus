import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageEnvelope } from '../types/envelope.js';

export interface HealthState {
  status: 'healthy' | 'degraded' | 'disconnected';
  busReachable: boolean;
  lastPollAt: string | null;
  consecutiveFailures: number;
}

/**
 * Register the E2 MCP tools on the server.
 *
 * - `reply` — send a reply to any message via the bus
 * - `get_pending_messages` — drain the local message buffer
 * - `get_adapter_status` — inspect the adapter's health state
 */
export function registerTools(
  server: McpServer,
  busBaseUrl: string,
  healthState: HealthState,
  messageBuffer: MessageEnvelope[]
): void {
  // ── reply ──────────────────────────────────────────────────────────────────

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
      // Look up original message from bus
      let original: MessageEnvelope;
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages/${message_id}`);
        if (!res.ok) {
          return {
            content: [{ type: 'text' as const, text: `Message not found: ${message_id}` }],
            isError: true,
          };
        }
        const data = (await res.json()) as { ok: boolean; message: MessageEnvelope };
        original = data.message;
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to fetch original message: ${String(err)}` }],
          isError: true,
        };
      }

      // Construct reply envelope (swap sender/recipient, set reply_to)
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

      // POST to bus
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(replyBody),
        });
        const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
        if (!data.ok) {
          return {
            content: [{ type: 'text' as const, text: `Bus rejected reply: ${data.error ?? 'unknown error'}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, outbound_message_id: data.id }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to send reply: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ── get_pending_messages ───────────────────────────────────────────────────

  server.registerTool(
    'get_pending_messages',
    {
      description:
        'Return and clear the local buffer of messages received from AgentBus. ' +
        'The polling loop populates this buffer; calling this tool drains it.',
      inputSchema: {
        limit: z.number().int().positive().optional().describe('Max messages to return (default: all buffered)'),
        topic: z.string().optional().describe('Only return messages with this topic'),
      },
    },
    ({ limit, topic }) => {
      let messages = [...messageBuffer];

      if (topic !== undefined) {
        messages = messages.filter((m) => m.topic === topic);
      }
      if (limit !== undefined) {
        messages = messages.slice(0, limit);
      }

      // Remove returned messages from the buffer (O(n) via Set)
      const toRemove = new Set(messages);
      const remaining = messageBuffer.filter((m) => !toRemove.has(m));
      messageBuffer.length = 0;
      messageBuffer.push(...remaining);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ messages, count: messages.length }),
          },
        ],
      };
    }
  );

  // ── get_adapter_status ────────────────────────────────────────────────────

  server.registerTool(
    'get_adapter_status',
    {
      description: 'Return the current health status of the AgentBus claude-code adapter.',
    },
    () => {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: healthState.status,
              bus_reachable: healthState.busReachable,
              last_poll_at: healthState.lastPollAt,
              consecutive_failures: healthState.consecutiveFailures,
            }),
          },
        ],
      };
    }
  );
}
