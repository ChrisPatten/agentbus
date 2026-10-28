/**
 * MCP tool registration barrel.
 *
 * Registers all AgentBus tools on the MCP server:
 *   - reply, get_adapter_status (E2 core tools)
 *   - list_channels (S7.1)
 *   - send_message (S7.2)
 *   - search_transcripts (S7.3; recall_memory/log_memory removed after E66)
 *   - write_knowledge, get_knowledge, forget_knowledge, search_knowledge (agent-managed knowledge store, Phase 1)
 *   - get_session, list_sessions (S7.4)
 *   - react_to_message (S7.5)
 *   - schedule_message, list_schedules, cancel_schedule (E18)
 *   - set_headless_model, get_headless_model, list_headless_model, delete_headless_model (model overrides)
 *   - advisory_ack (E65)
 *   - journal_complete (E66; live agents only — not registered for cc-headless)
 *   - propose_change (E68)
 *   - status (E79)
 *   - send_location, send_venue, send_contact, send_document, ask_input, send_rich, edit_message,
 *     pin_message, unpin_message (E81; only when a Telegram adapter is configured)
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageEnvelope } from '../../types/envelope.js';
import { toolError, toolSuccess } from './helpers.js';
import { applyChoices, choicesSchema, CHOICES_DESCRIPTION } from '../../choices/validate.js';
import { applySendOptions, sendOptionFields } from '../../outbound/send-options.js';
import type { AppConfig } from '../../config/schema.js';
import { registerChannelTools } from './channels.js';
import { registerMessagingTools, registerEmailTool, buildEmailToolConfig } from './messaging.js';
import { registerTranscriptTools } from './transcripts.js';
import { registerKnowledgeTools } from './knowledge.js';
import { registerSessionTools } from './sessions.js';
import { registerReactionTools } from './reactions.js';
import { registerScheduleTools } from './scheduling.js';
import { registerAttachmentTools } from './attachments.js';
import { registerTelegramTools } from './telegram.js';
import { registerTelegramSendTools } from './telegram-send.js';
import { registerModelOverrideTools } from './model-overrides.js';
import { registerAdvisoryTools } from './advisories.js';
import { registerJournalTools } from './journal.js';
import { registerProposalTools } from './proposals.js';
import { registerStatusTool } from './status.js';
import { getTelegramInstances } from '../../config/schema.js';
import { originFromEnv } from '../../core/origin.js';

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
 * @param agentId     - BARE agent id of the calling instance (e.g. "claude",
 *                      "peggy-pool-3") — threaded into `send_message`/`send_email`
 *                      so their outbound `sender` identifies the real caller
 *                      (E48 S48.6; previously hardcoded to "agent:claude").
 * @param config      - App config; when present and an email adapter is
 *                      configured, the allowlist-gated `send_email` tool is added
 */
export function registerAllTools(
  server: McpServer,
  busBaseUrl: string,
  healthState: HealthState,
  agentId: string,
  config?: AppConfig,
): void {
  // E2 core tools
  registerCoreTools(server, busBaseUrl, healthState, agentId);

  // E7 tools
  registerChannelTools(server, busBaseUrl);
  registerMessagingTools(server, busBaseUrl, agentId);
  registerTranscriptTools(server, busBaseUrl);
  registerKnowledgeTools(server, busBaseUrl);
  registerSessionTools(server, busBaseUrl);
  registerReactionTools(server, busBaseUrl);
  registerScheduleTools(server, busBaseUrl);
  registerAttachmentTools(server, busBaseUrl);
  registerModelOverrideTools(server, busBaseUrl);
  registerAdvisoryTools(server, busBaseUrl, agentId);
  registerJournalTools(server, busBaseUrl, agentId);
  registerProposalTools(server, busBaseUrl, agentId);
  registerStatusTool(server);
  maybeRegisterEmailTool(server, busBaseUrl, agentId, config);
  maybeRegisterTelegramTools(server, busBaseUrl, agentId, config);
}

/** Register the `send_email` tool when an email adapter + allowlist is configured. */
function maybeRegisterEmailTool(
  server: McpServer,
  busBaseUrl: string,
  agentId: string,
  config?: AppConfig,
): void {
  if (!config) return;
  const emailCfg = buildEmailToolConfig(config);
  if (emailCfg) registerEmailTool(server, busBaseUrl, agentId, emailCfg);
}

/** Register `create_telegram_topic` (E28) when a Telegram adapter is configured. */
function maybeRegisterTelegramTools(
  server: McpServer,
  busBaseUrl: string,
  agentId: string,
  config?: AppConfig,
): void {
  if (!config) return;
  if (getTelegramInstances(config).length === 0) return;
  registerTelegramTools(server, busBaseUrl);
  // E81: location/venue/contact/document/rich/ask_input sends plus edit/pin by message id.
  registerTelegramSendTools(server, busBaseUrl, agentId, config);
}

/**
 * Register the subset of tools available to the cc-headless adapter.
 *
 * Includes reply + send_message: the headless adapter watches the claude
 * stream-json for these tool calls and lets the agent own delivery (interim
 * "working on it" updates, the final answer, per-channel sends). Excludes
 * get_adapter_status (no persistent health state in a per-request invocation).
 *
 * @param agentId - BARE agent id of the calling instance — see registerAllTools's
 *                  matching param doc.
 */
export function registerHeadlessTools(
  server: McpServer,
  busBaseUrl: string,
  agentId: string,
  config?: AppConfig,
): void {
  registerReplyTool(server, busBaseUrl, agentId);
  registerChannelTools(server, busBaseUrl);
  registerMessagingTools(server, busBaseUrl, agentId);
  registerTranscriptTools(server, busBaseUrl);
  registerKnowledgeTools(server, busBaseUrl);
  registerSessionTools(server, busBaseUrl);
  registerReactionTools(server, busBaseUrl);
  registerScheduleTools(server, busBaseUrl);
  registerAttachmentTools(server, busBaseUrl);
  registerModelOverrideTools(server, busBaseUrl);
  registerAdvisoryTools(server, busBaseUrl, agentId);
  registerProposalTools(server, busBaseUrl, agentId);
  registerStatusTool(server);
  maybeRegisterEmailTool(server, busBaseUrl, agentId, config);
  maybeRegisterTelegramTools(server, busBaseUrl, agentId, config);
}

// ── Core tools (E2) ───────────────────────────────────────────────────────────

function registerCoreTools(
  server: McpServer,
  busBaseUrl: string,
  healthState: HealthState,
  agentId: string,
): void {
  registerReplyTool(server, busBaseUrl, agentId);

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

// ── reply tool (shared by full + headless tool sets) ────────────────────────────

function registerReplyTool(server: McpServer, busBaseUrl: string, agentId: string): void {
  // ── reply ────────────────────────────────────────────────────────────────

  server.registerTool(
    'reply',
    {
      description:
        'Send a reply to a message. Looks up the original by message_id, swaps sender/recipient, and posts the outbound message to AgentBus. ' +
        'Pass `choices` to offer single-choice answers (tappable buttons on Telegram). ' +
        '`silent`, `no_preview` and `pin` tune Telegram delivery (no notification sound, no link card, pin after sending).',
      inputSchema: {
        message_id: z.string().describe('ID of the message to reply to'),
        body: z.string().min(1).describe('Text body of the reply'),
        choices: choicesSchema.optional().describe(CHOICES_DESCRIPTION),
        ...sendOptionFields,
      },
    },
    async ({ message_id, body, choices, silent, no_preview, pin }) => {
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

      // Forward the original message's conversation_id (stamped on inbound
      // fan-out — see Stage 70/route-resolve.ts) so E48 (S48.6)'s stale-pane
      // guard at POST /api/v1/messages can resolve this reply's
      // conversationId directly, without needing the reply_to ->
      // transcripts DB join (that join still runs too, as a fallback/
      // cross-check — this is purely additive).
      const originalConversationId = original.metadata?.['conversation_id'];
      const baseMetadata: Record<string, unknown> =
        typeof originalConversationId === 'string' ? { conversation_id: originalConversationId } : {};
      const withChoices = applyChoices(
        original.channel,
        body,
        applySendOptions(baseMetadata, { silent, no_preview, pin }),
        choices,
      );
      const replyBody = {
        channel: original.channel,
        topic: original.topic,
        sender: original.recipient,
        recipient: original.sender,
        reply_to: original.id,
        priority: 'normal' as const,
        payload: { type: 'text' as const, body: withChoices.body },
        metadata: {
          ...withChoices.metadata,
          origin: originFromEnv(agentId), // E69
        },
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
}
