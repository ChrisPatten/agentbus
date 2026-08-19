/**
 * S7.2 — Outbound Tool: send_message
 *
 * Validates routing, constructs an envelope, and enqueues via bus-core.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError, toolSuccess } from './helpers.js';
import { getEmailInstances, type AppConfig } from '../../config/schema.js';

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
        topic: z
          .string()
          .optional()
          .default('general')
          .describe(
            'Message topic (default: "general"). To target a specific Telegram forum topic ' +
              '(e.g. one created via create_telegram_topic), pass the `topic` value it returned ' +
              '(a "thread:<hash>" id) — not the channel or a plain topic name.',
          ),
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
    async ({ to, channel, body, topic, reply_to, priority, metadata }) => {
      // Validate channel exists — resolved the same way real delivery is
      // (registry.lookupPrimaryByChannel), so a dynamically-derived channel
      // (e.g. a Telegram group, E28) validates correctly too.
      try {
        const resolveRes = await fetch(
          `${busBaseUrl}/api/v1/adapters/resolve?channel=${encodeURIComponent(channel)}`,
        );
        if (!resolveRes.ok) {
          return toolError(`Failed to resolve channel: HTTP ${resolveRes.status}`);
        }
        const resolveData = (await resolveRes.json()) as { ok: boolean; exists?: boolean };
        if (!resolveData.exists) {
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
        topic: topic ?? 'general',
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

/** Resolved configuration the `send_email` tool needs at registration time. */
export interface EmailToolConfig {
  /** The email channel id to send on (e.g. "email" or "email:peggy"). */
  channel: string;
  /** Ordered allowlist of email addresses; index 0 is the default recipient. */
  allowlist: string[];
  /** Lowercased address → owning contact id (for the `contact:` delivery recipient). */
  addressToContact: Record<string, string>;
}

/**
 * Derive the `send_email` tool's config from the app config: the first email
 * adapter instance is the send channel, and the allowlist is every address under
 * `contacts[*].platforms.email.address` (config order preserved, de-duplicated).
 * Returns null when no email adapter or no allowlisted address is configured —
 * in which case the tool is not registered.
 */
export function buildEmailToolConfig(config: AppConfig): EmailToolConfig | null {
  const instances = getEmailInstances(config);
  if (instances.length === 0) return null;
  const first = instances[0]!;
  const channel = first.name ? `email:${first.name}` : 'email';

  const allowlist: string[] = [];
  const addressToContact: Record<string, string> = {};
  const seen = new Set<string>();
  for (const contact of Object.values(config.contacts)) {
    const email = contact.platforms.email;
    if (!email) continue;
    const addrs = Array.isArray(email.address) ? email.address : [email.address];
    for (const a of addrs) {
      const low = a.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      allowlist.push(a);
      addressToContact[low] = contact.id;
    }
  }
  if (allowlist.length === 0) return null;
  return { channel, allowlist, addressToContact };
}

/**
 * S(E21) — Outbound tool: send_email
 *
 * Lets the agent start a NEW email thread to the user (as opposed to `reply`,
 * which threads into the message the agent received). Defaults the recipient to
 * the first allowlisted address; an explicit `to` is allowed only if it is on
 * the allowlist. This is the same allowlist the inbound adapter enforces, so the
 * agent can never email an arbitrary address.
 */
export function registerEmailTool(
  server: McpServer,
  busBaseUrl: string,
  emailCfg: EmailToolConfig,
): void {
  const defaultTo = emailCfg.allowlist[0]!;

  server.registerTool(
    'send_email',
    {
      description:
        'Start a NEW email thread to the user over the email channel. Use this to ' +
        'reach out proactively (not in reply to a received message). Defaults to the ' +
        'primary allowlisted address; pass `to` to target a different allowlisted ' +
        'address. Any recipient not on the allowlist is rejected.',
      inputSchema: {
        body: z
          .string()
          .min(1)
          .describe(
            'Email body. Markdown is supported and rendered as formatted HTML ' +
              '(headings, tables, lists, links, code blocks); plain prose is fine too.',
          ),
        to: z
          .string()
          .optional()
          .describe(
            `Recipient email address. Must be on the allowlist (${emailCfg.allowlist.join(', ')}). ` +
              `Defaults to ${defaultTo}.`,
          ),
        subject: z
          .string()
          .optional()
          .describe('Subject line. Defaults to "Message from your assistant".'),
      },
    },
    async ({ body, to, subject }) => {
      const address = (to ?? defaultTo).trim();
      const contactId = emailCfg.addressToContact[address.toLowerCase()];
      if (!contactId) {
        return toolError(
          `Refusing to send: "${address}" is not on the email allowlist. ` +
            `Allowed addresses: ${emailCfg.allowlist.join(', ')}`,
        );
      }

      // The delivery worker only dispatches `contact:`-prefixed recipients, so
      // route via the owning contact and carry the exact target address in
      // metadata (email_to) for the adapter to send to precisely. An optional
      // subject rides metadata.email_subject (the adapter falls back to a default).
      const trimmedSubject = subject?.trim();
      const metadata: Record<string, unknown> = { email_to: address };
      if (trimmedSubject) metadata['email_subject'] = trimmedSubject;
      const envelope = {
        channel: emailCfg.channel,
        topic: 'general',
        sender: 'agent:claude',
        recipient: `contact:${contactId}`,
        reply_to: null,
        priority: 'normal' as const,
        payload: { type: 'text' as const, body },
        metadata,
      };

      try {
        const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
        });
        const data = (await res.json()) as { ok: boolean; id?: string; error?: string };
        if (!data.ok) {
          return toolError(`Bus rejected email: ${data.error ?? 'unknown error'}`);
        }
        return toolSuccess({ success: true, message_id: data.id, to: address });
      } catch (err) {
        return toolError(`Failed to send email: ${String(err)}`);
      }
    },
  );
}
