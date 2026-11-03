/**
 * E96 follow-on — tapping a choice button of a conversation from a surface.
 *
 * `POST /api/v1/surface/actions` (and the WS `action` frame) with `object: "conversations:<conversation id>"`
 * and `action_id` = the button index (the `index` in `ConversationMessage.buttons`) taps that button the way a
 * Telegram tap does:
 *
 *   1. {@link resolveChoiceTap}: the prompt must be open and addressed to the surface's contact (or to nobody);
 *      the `open -> answered` flip is atomic, so a double tap answers once. It also clears the
 *      conversation's `answer_needed` flag (S96.6) and the sessions resource is refreshed by the existing
 *      listener.
 *   2. The pick is injected into the prompt's conversation as an inbound message from the contact:
 *      `[tapped] <label>`, or the choice's slash command (E54), with `reply_to` the question and the same
 *      choice metadata Telegram attaches.
 *   3. A failed injection reopens the prompt so the button can be tapped again.
 *   4. The Telegram keyboard of the prompt is cleared best-effort (the adapter's `finalizeChoicePrompt`), so
 *      the buttons do not stay live on the phone.
 *
 * Which prompt: the one on `message_id` when the request names it, else the newest open callback prompt of the
 * conversation. Copy and link buttons cannot be tapped from a surface (`invalid`).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChoiceStore } from '../choices/store.js';
import { resolveChoiceTap } from '../choices/tap.js';
import type { ChoicePrompt } from '../choices/types.js';
import type { InboundAbort, InboundMessage, InboundResult, InboundSystemOptions } from '../http/api.js';
import type { ActionResult, Device } from './types.js';

export interface ConversationActionDeps {
  db: Database.Database;
  choices: Pick<ChoiceStore, 'getById' | 'answer' | 'reopen' | 'clearMessageRef' | 'db'>;
  submitInbound: (msg: InboundMessage, system?: InboundSystemOptions) => Promise<InboundResult | InboundAbort>;
  /** The contact the device's surface follows (bare id) and whether the surface may read the conversation; null: unknown surface. */
  surfaceOf: (device: Device) => { contact: string; canRead: (conversationId: string) => boolean } | null;
  /** Clears the platform keyboard of an answered prompt (Telegram). Failures are swallowed. */
  clearKeyboard?: (prompt: ChoicePrompt) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Open prompt ids of a conversation, newest first (callback prompts only, unexpired). */
function openPromptIds(db: Database.Database, conversationId: string, nowIso: string, messageId?: string): string[] {
  const rows = db.prepare(
    `SELECT cp.id AS id FROM choice_prompts cp
       WHERE cp.status = 'open' AND cp.expires_at > @now
         AND (@msg IS NULL OR cp.bus_message_id = @msg)
         AND cp.bus_message_id IN (SELECT message_id FROM transcripts WHERE conversation_id = @cid AND direction = 'outbound')
       ORDER BY cp.created_at DESC, cp.rowid DESC`,
  ).all({ now: nowIso, msg: messageId ?? null, cid: conversationId }) as { id: string }[];
  return rows.map((r) => r.id);
}

export function createConversationAction(deps: ConversationActionDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(`[surface-actions] ${m}`));

  return async function conversationAction(
    device: Device, conversationId: string, index: number, messageId: string | undefined, key: string,
  ): Promise<ActionResult> {
    const base = { type: 'action_result' as const, idempotency_key: key };
    const failed = (reason: string): ActionResult => ({ ...base, status: 'failed', reason });
    const surface = deps.surfaceOf(device);
    if (!surface || !surface.canRead(conversationId)) return failed('not_found');

    const nowIso = new Date(now()).toISOString();
    const ids = openPromptIds(deps.db, conversationId, nowIso, messageId);
    if (ids.length === 0) {
      // Nothing open: report what happened to the newest prompt of that message/conversation, if any.
      const any = deps.db.prepare(
        `SELECT cp.id AS id, cp.status AS status FROM choice_prompts cp
           WHERE (@msg IS NULL OR cp.bus_message_id = @msg)
             AND cp.bus_message_id IN (SELECT message_id FROM transcripts WHERE conversation_id = @cid AND direction = 'outbound')
           ORDER BY cp.created_at DESC, cp.rowid DESC LIMIT 1`,
      ).get({ msg: messageId ?? null, cid: conversationId }) as { id: string; status: string } | undefined;
      if (any?.status === 'answered') return { ...base, status: 'already_done' };
      if (any?.status === 'expired' || any?.status === 'open') return { ...base, status: 'expired' };   // open here means past its expiry
      return failed('not_found');
    }

    const prompt = deps.choices.getById(ids[0]!);
    if (!prompt) return failed('not_found');
    const result = resolveChoiceTap(deps.choices as ChoiceStore, prompt.id, index, surface.contact, `device:${device.id}`, new Date(now()));
    switch (result.outcome) {
      case 'already_answered': return { ...base, status: 'already_done' };
      case 'expired':
        deps.choices.clearMessageRef(prompt.id);
        void deps.clearKeyboard?.(prompt)?.catch(() => {});
        return { ...base, status: 'expired' };
      case 'forbidden': return failed('forbidden');
      case 'invalid_choice': return failed('invalid');
      case 'not_found': return failed('not_found');
      case 'answered': break;
    }
    if (result.outcome !== 'answered') return failed('invalid');

    const msg: InboundMessage = {
      id: randomUUID(),
      channel: prompt.channel,
      ...(prompt.topic && prompt.topic !== 'general' ? { topic: prompt.topic } : {}),
      sender: `contact:${surface.contact}`,
      reply_to: prompt.bus_message_id,
      payload: { type: 'text', body: result.body },
      metadata: {
        origin: 'surface_action', surface_id: device.surface_id, device_id: device.id,
        object: `conversations:${conversationId}`, action_id: String(index), idempotency_key: key,
        ...result.metadata, choice_label: result.label,
      },
    };

    let out: InboundResult | InboundAbort;
    try {
      out = await deps.submitInbound(msg);
    } catch (err) {
      log(`choice tap on ${prompt.id} could not be delivered: ${String(err)}`);
      deps.choices.reopen(prompt.id);                                         // the same button may be tapped again
      return failed('internal_error');
    }
    const ok = out.queued ? out.enqueued_count > 0 : out.reason === 'command_handled';
    if (!ok) {
      deps.choices.reopen(prompt.id);
      return failed(out.queued ? 'no_route' : (out.reason || 'rejected'));
    }
    if (deps.clearKeyboard && prompt.platform_message_id) {
      try { await deps.clearKeyboard(prompt); deps.choices.clearMessageRef(prompt.id); }
      catch (err) { log(`could not clear the keyboard of ${prompt.id}: ${String(err)}`); }
    }
    return { ...base, status: 'done', message_id: msg.id! };
  };
}
