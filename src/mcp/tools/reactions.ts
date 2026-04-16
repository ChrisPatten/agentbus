/**
 * S7.5 — Reaction Tool: react_to_message
 *
 * Sends an emoji reaction to a message. All complex logic (transcript lookup,
 * adapter capability check, adapter.react() call) lives in the bus-core endpoint
 * POST /api/v1/messages/:id/react.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface ReactResponse {
  ok: boolean;
  success?: boolean;
  emoji?: string;
  message_id?: string;
  reason?: string;
  error?: string;
}

export function registerReactionTools(server: McpServer, busBaseUrl: string): void {
  server.registerTool(
    'react_to_message',
    {
      description:
        'Send an emoji reaction to a message. Only works on channels that support reactions (Telegram, BlueBubbles). Returns a graceful error on unsupported channels.',
      inputSchema: {
        message_id: z.string().min(1).describe('Bus message ID to react to'),
        emoji: z.string().min(1).describe('Reaction emoji (any single emoji)'),
      },
    },
    async ({ message_id, emoji }: { message_id: string; emoji: string }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages/${message_id}/react`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji }),
        });

        const data = (await res.json().catch(() => ({}))) as ReactResponse;

        if (res.status === 404) {
          return toolError(`Message not found: ${message_id}`);
        }
        if (res.status === 400) {
          return toolSuccess({
            success: false,
            reason: data.reason ?? data.error ?? 'Reactions not supported on this channel',
          });
        }
        if (res.status === 502) {
          return toolError(`Adapter error: ${data.error ?? 'unknown'}`);
        }
        if (!res.ok) {
          return toolError(`React failed: HTTP ${res.status}`);
        }

        return toolSuccess({ success: true, emoji, message_id });
      } catch (err) {
        return toolError(`Failed to send reaction: ${String(err)}`);
      }
    }
  );
}
