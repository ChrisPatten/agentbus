/**
 * E96 — a process-wide hook on accepted inbound messages, so the surface runtime can
 * clear `answer_needed` and push live Conversation appends without threading its
 * objects through every `processInbound` caller. Listeners must not throw (errors are logged).
 */
import type { MessageEnvelope } from '../types/envelope.js';

type Listener = (envelope: MessageEnvelope, conversationId: string | null, systemOnly: boolean) => void;
const listeners = new Set<Listener>();

export function onInboundAccepted(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyInboundAccepted(envelope: MessageEnvelope, conversationId: string | null, systemOnly: boolean): void {
  for (const l of listeners) {
    try { l(envelope, conversationId, systemOnly); } catch (err) { console.error(`[surface] inbound listener failed: ${String(err)}`); }
  }
}
