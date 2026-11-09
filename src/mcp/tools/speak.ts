/**
 * E102 — `speak`: the agent says its answer aloud on the Intercom device that sent a push-to-talk message.
 *
 * The bus finds the device from the message id or the surface (the tool never takes a device id) and starts
 * paced synthesis in the background. It declines only when the device is asleep, muted or not connected;
 * the agent, not the bus, follows the owner's voice guide. On success this tool also records the spoken text (🔊, audio tags removed) as
 * a quiet message in the followed conversation so the Thread, Telegram and journaling see it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageEnvelope } from '../../types/envelope.js';
import { toolError, toolSuccess } from './helpers.js';
import { originFromEnv } from '../../core/origin.js';

export const SPEAK_DESCRIPTION =
  'Say something aloud on Chris\'s Intercom device (the Compact on his desk). Use it to answer a push-to-talk message (pass that message\'s id as message_id) ' +
  'AND any other time you want to be heard there: for example in a Telegram chat he said "let me know on the Compact when that is done", and now it is. ' +
  'It is allowed at any time and from any session; the bus applies no limits on length, count or hours, so YOU are responsible for following his voice guide ' +
  '(the file named by voice.speech.style_file, normally data/intercom/voice-style.md: tone, brevity, how to say numbers and times). Re-read it if you no longer have it. ' +
  'Targeting: with a message_id of a push-to-talk message still in progress, it speaks on the device that sent it. Otherwise it speaks on every connected, awake device of ' +
  '`surface` (default: the one surface that has speech enabled, "compact"; if several are eligible and you name none, you get an error listing them). ' +
  'Write plain prose as you would say it: no Markdown, lists, links or emoji. ElevenLabs audio tags such as [warmly], [quickly] or [short pause] are sent to the voice untouched and removed from the written copy. ' +
  'Long text is fine: it is split and played in full, paced to the device; several calls play in order. ' +
  'speak changes audio only. The Understood screen shows what you give reply() (pass a glance), so for a push-to-talk message also call reply(); a reply is not spoken unless the bus fallback is on. ' +
  'Returns at once: "spoken" (audio is streaming), "queued" (it follows audio still playing) or "skipped" with reason "asleep", "muted" (volume 0), "offline" (no device connected) or "off" (speech disabled). ' +
  'When skipped as asleep, muted or offline, nothing was spoken: use notify (or send_message) to reach him instead. ' +
  'The spoken text is also recorded in the Intercom conversation as "🔊 text" so the Thread and Telegram show what was said.';

export function registerSpeakTool(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'speak',
    {
      description: SPEAK_DESCRIPTION,
      inputSchema: {
        text: z.string().min(1).max(50_000).describe('What to say, plain prose as you would speak it, following the voice guide. Audio tags like [warmly] are allowed'),
        message_id: z.string().min(1).optional().describe('The [id:...] of the push-to-talk message you are answering, to speak on the device that sent it. Omit for proactive speech'),
        surface: z.string().min(1).optional().describe('Intercom surface id for proactive speech; default: the one speech-enabled surface (compact)'),
      },
    },
    async ({ text, message_id, surface }) => {
      let data: Record<string, unknown>;
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/speak`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...(message_id ? { message_id } : {}), ...(surface ? { surface } : {}), agent_id: agentId }),
        });
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || !data['ok']) {
          return toolError(String(data['error'] ?? (res.status === 404 ? 'speak is not available (Intercom is not enabled on this bus)' : `HTTP ${res.status}`)));
        }
      } catch (err) {
        return toolError(`Failed to speak: ${String(err)}`);
      }
      if (data['status'] === 'skipped') return toolSuccess({ status: 'skipped', reason: data['reason'] });

      // Spoken: record it in the surface's followed conversation, quietly. A failure here does not undo the speech.
      let recorded: string | null = null;
      try {
        const follow = data['follow'] as { channel: string; topic?: string; contact: string };
        let replyTo: string | null = null;
        let conversationId: string | undefined;
        if (data['interaction_message'] === true && message_id) {
          const orig = await fetch(`${busBaseUrl}/api/v1/messages/${message_id}`);
          if (orig.ok) {
            const original = ((await orig.json()) as { message: MessageEnvelope }).message;
            replyTo = original.id;
            const conv = original.metadata?.['conversation_id'];
            if (typeof conv === 'string') conversationId = conv;
          }
        }
        const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: follow.channel, ...(follow.topic ? { topic: follow.topic } : {}),
            sender: `agent:${agentId}`, recipient: `contact:${follow.contact}`, reply_to: replyTo, priority: 'normal',
            payload: { type: 'text', body: String(data['echo'] ?? '') },
            metadata: {
              ...(conversationId ? { conversation_id: conversationId } : {}),
              intercom_spoken: true, silent: true, no_preview: true, origin: originFromEnv(agentId),
            },
          }),
        });
        const r = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string };
        if (r.ok) recorded = r.id ?? null;
      } catch { /* recorded stays null */ }
      return toolSuccess({ status: data['status'], spoken: data['text'], surface: data['surface_id'], devices: data['devices'], recorded_message_id: recorded });
    },
  );
}
