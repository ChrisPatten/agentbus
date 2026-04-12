/**
 * S7.2 — Outbound Tool: send_message
 *
 * Validates routing, constructs an envelope, and enqueues via bus-core.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import type { AdaptersResponse } from './types.js';

export function registerMessagingTools(server: McpServer, busBaseUrl: string): void {
  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to any contact on any channel. Use list_channels to discover available channels.',
      inputSchema: {
        to: z.string().min(1).describe('Recipient identifier (e.g. "contact:chris", "contact:alice")'),
        channel: z.string().min(1).describe('Target channel (e.g. "telegram", "bluebubbles")'),
        body: z.string().min(1).describe('Message text body'),
        reply_to: z.string().optional().describe('Bus message ID this message is replying to'),
        priority: z
          .enum(['normal', 'high', 'urgent'])
          .optional()
          .default('normal')
          .describe('Message priority (default: normal)'),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional key/value metadata attached to the message'),
      },
    },
    async ({ to, channel, body, reply_to, priority, metadata }) => {
      // Validate channel exists
      try {
        const adaptersRes = await fetch(`${busBaseUrl}/api/v1/adapters`);
        if (!adaptersRes.ok) {
          return toolError(`Failed to resolve channel: HTTP ${adaptersRes.status}`);
        }
        const adaptersData = (await adaptersRes.json()) as AdaptersResponse;
        const channelExists = adaptersData.adapters.some((a) => a.channels.includes(channel));
        if (!channelExists) {
          return toolError(`Unknown channel: "${channel}". Call list_channels to see available channels.`);
        }
      } catch (err) {
        return toolError(`Failed to validate channel: ${String(err)}`);
      }

      // Construct and enqueue the envelope.
      // reply_to is passed through as-is; the bus stores it without validating
      // against transcripts (no /api/v1/transcripts/:id endpoint exists yet).
      const envelope = {
        channel,
        topic: 'general',
        sender: 'agent:claude',
        recipient: to,
        reply_to: reply_to ?? null,
        priority: priority ?? 'normal',
        payload: { type: 'text' as const, body },
        metadata: metadata ?? {},
      };

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        });
        const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
        if (!data.ok) {
          return toolError(`Bus rejected message: ${data.error ?? 'unknown error'}`);
        }
        return toolSuccess({
          success: true,
          message_id: data.id,
        });
      } catch (err) {
        return toolError(`Failed to send message: ${String(err)}`);
      }
    }
  );
}
