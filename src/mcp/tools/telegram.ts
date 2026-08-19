/**
 * E28 — Outbound tool: create_telegram_topic
 *
 * Lets the agent start a new forum topic in a Telegram group on its own
 * initiative and reference it later (e.g. in a `schedule_message` call) via
 * the `thread:<hash>` topic it returns. Group-only — DM Threaded Mode is
 * retired. All the real logic (admin-rights check, createForumTopic,
 * thread-store upsert) lives in the bus-core endpoint
 * POST /api/v1/adapters/:id/topics; this tool is a thin fetch wrapper,
 * mirroring how react_to_message's logic lives in bus-core.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';

interface CreateTopicResponse {
  ok: boolean;
  topic?: string;
  message_thread_id?: number;
  name?: string;
  error?: string;
}

export function registerTelegramTools(server: McpServer, busBaseUrl: string): void {
  server.registerTool(
    'create_telegram_topic',
    {
      description:
        'Create a new forum topic in a Telegram group you have been added to. Group-only — ' +
        'not available for a contact\'s direct message channel. This always starts a brand-new ' +
        'session for the topic — there is no prior conversation history to inherit. Returns a ' +
        '`topic` value (e.g. "thread:abc123") to pass as `topic` on a later ' +
        '`send_message`/`schedule_message` call targeting this thread. Requires the bot to have ' +
        '"Manage Topics" admin rights in the group; fails with a clear error naming the exact fix ' +
        'if it does not.',
      inputSchema: {
        channel: z
          .string()
          .min(1)
          .describe('The group\'s channel id (e.g. "telegram:group:-100123"), as seen on an inbound message from that group'),
        name: z.string().min(1).describe('The new topic\'s display name'),
        context: z
          .string()
          .optional()
          .describe(
            'Optional context to seed this topic\'s brand-new session with — injected into the agent\'s ' +
              'first turn on this topic only, once, the moment the first message arrives on it. Use this ' +
              'to explain why the topic exists or what it should track.',
          ),
      },
    },
    async ({ channel, name, context }: { channel: string; name: string; context?: string }) => {
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/adapters/${encodeURIComponent(channel)}/topics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, context }),
        });
        const data = (await res.json().catch(() => ({}))) as CreateTopicResponse;
        if (!data.ok) {
          return toolError(data.error ?? `Failed to create topic: HTTP ${res.status}`);
        }
        return toolSuccess({ topic: data.topic, message_thread_id: data.message_thread_id, name: data.name });
      } catch (err) {
        return toolError(`Failed to create topic: ${String(err)}`);
      }
    },
  );
}
