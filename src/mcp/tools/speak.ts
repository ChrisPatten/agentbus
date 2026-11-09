/**
 * E102 — `speak`: the agent says its answer aloud on the Intercom device that sent a push-to-talk message.
 *
 * The bus finds the device from the message id (the tool never takes a device id), applies every speech
 * guard (quiet hours, muted or sleeping device, length, one utterance at a time, reply window), and starts
 * synthesis in the background. On success this tool also records the spoken text (🔊, audio tags removed) as
 * a quiet message in the followed conversation so the Thread, Telegram and journaling see it.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageEnvelope } from '../../types/envelope.js';
import { toolError, toolSuccess } from './helpers.js';
import { originFromEnv } from '../../core/origin.js';

export const SPEAK_DESCRIPTION =
  'Say something aloud on the Intercom device (the Compact) that sent you a push-to-talk message, and show it as the answer on its screen. ' +
  'Use it ONLY for a message that says it was spoken by push-to-talk (a speech transcript); pass that message\'s id as message_id. ' +
  'The bus picks the device; you never name one. Call speak FIRST, with the short answer as you would say it to someone at your desk: ' +
  'one to three plain sentences (up to about 400 characters), no Markdown, no lists, no links, no emoji, numbers and times written the way you would say them. ' +
  'Then, only if there is more to say, call reply() with the full text: it goes to the Thread and Telegram and is NOT spoken, and it does not replace what the device shows. ' +
  'You may speak twice (for example "Checking now." then the result). ' +
  'ElevenLabs audio tags such as [warmly], [quickly] or [short pause] may be put in the text; they are sent to the voice untouched and removed from the written copy. ' +
  'Returns at once: status "spoken" (audio is being streamed now), "queued" (it follows an utterance still playing) or "skipped" with a reason ' +
  '(quiet_hours, muted, asleep, off, enough, gone: nothing is spoken and nothing is shown; answer with reply() instead). ' +
  'An error means speaking is not allowed here (not a push-to-talk message, a typed message came after it, the window has passed, or the text is too long or empty): use reply(). ' +
  'If you never call speak, the bus speaks your reply\'s glance for you after a short grace, so always pass a glance on reply() too. Follow the voice style guide you were given.';

export function registerSpeakTool(server: McpServer, busBaseUrl: string, agentId: string): void {
  server.registerTool(
    'speak',
    {
      description: SPEAK_DESCRIPTION,
      inputSchema: {
        message_id: z.string().min(1).describe('ID of the push-to-talk message you are answering (the [id:...] of the message that says it was spoken)'),
        text: z.string().min(1).max(2000).describe('What to say, plain prose, up to about 400 characters (audio tags like [warmly] do not count)'),
      },
    },
    async ({ message_id, text }) => {
      let data: Record<string, unknown>;
      try {
        const res = await fetch(`${busBaseUrl}/api/v1/speak`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id, text, agent_id: agentId }),
        });
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || !data['ok']) {
          return toolError(String(data['error'] ?? (res.status === 404 ? 'speak is not available (Intercom is not enabled on this bus)' : `HTTP ${res.status}`)));
        }
      } catch (err) {
        return toolError(`Failed to speak: ${String(err)}`);
      }
      if (data['status'] === 'skipped') return toolSuccess({ status: 'skipped', reason: data['reason'] });

      // Spoken: record it in the followed conversation, quietly. A failure here does not undo the speech.
      let recorded: string | null = null;
      try {
        const orig = await fetch(`${busBaseUrl}/api/v1/messages/${message_id}`);
        if (orig.ok) {
          const original = ((await orig.json()) as { message: MessageEnvelope }).message;
          const conv = original.metadata?.['conversation_id'];
          const res = await fetch(`${busBaseUrl}/api/v1/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: original.channel, topic: original.topic,
              sender: original.recipient, recipient: original.sender, reply_to: original.id, priority: 'normal',
              payload: { type: 'text', body: String(data['echo'] ?? '') },
              metadata: {
                ...(typeof conv === 'string' ? { conversation_id: conv } : {}),
                intercom_spoken: true, silent: true, no_preview: true, origin: originFromEnv(agentId),
              },
            }),
          });
          const r = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string };
          if (r.ok) recorded = r.id ?? null;
        }
      } catch { /* recorded stays null */ }
      return toolSuccess({ status: data['status'], spoken: data['text'], recorded_message_id: recorded });
    },
  );
}
