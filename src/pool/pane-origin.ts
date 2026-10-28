import type Database from 'better-sqlite3';
import { DEFAULT_ORIGIN_LABEL, scheduleLabelFromMetadata, type Origin } from '../core/origin.js';
import { LeaseStore } from './lease-store.js';
import { toBareAgentId } from './types.js';

/**
 * E83 S83.3 — bus-side origin for sends from a cc-pool pane.
 *
 * A pane's MCP server has no per-turn conversation (`AGENTBUS_TURN_CONVERSATION_ID`
 * is a cc-headless mechanism) and no schedule label (`AGENTBUS_SOURCE_LABEL`),
 * so every pane send arrives stamped `kind: 'external'` and a pane's own reply
 * to its conversation would read as foreign. The bus knows better: the
 * conversation is the one the sender's pane is leased to, or, when the send
 * names one (`reply` carries `metadata.conversation_id`), that conversation.
 * The lease is looked up at send time because an environment variable written
 * at launch would go stale when the pane is evicted and re-leased.
 *
 * The explicit conversation wins over the lease so a reply that was in flight
 * when its pane was evicted (lease `free`, `dead`, `launching`, `draining`, or
 * leased to another conversation) is still stamped as that conversation's own
 * turn and is never fed back to it as foreign context. (The outbound
 * stale-pane guard in `POST /api/v1/messages` still rejects the one case
 * where the pane now serves a different conversation.) Without a hint, only a
 * `leased` lease counts.
 *
 * Returns the origin to stamp for `sender`, or null when the sender isn't a
 * pane (no lease row at all) or no conversation can be determined: the origin
 * stays as the caller stamped it.
 *
 * Label: an explicit caller label (a `source`) wins; the generic external
 * default doesn't. Otherwise, when the conversation's newest inbound message
 * is a scheduled fire, the schedule's name (`scheduleLabelFromMetadata`, the
 * rule cc-headless applies through `AGENTBUS_SOURCE_LABEL`), so a routine's
 * send reads "Morning scan" and not "another agent session". The newest
 * inbound message, not the newest scheduled one: a person's reply after the
 * routine means the pane is no longer running the routine.
 */
export function paneTurnOrigin(db: Database.Database, sender: string, callerOrigin?: unknown, conversationHint?: unknown): Origin | null {
  const lease = new LeaseStore(db).findByAgentAnyPool(sender);
  if (!lease) return null;
  const hint = typeof conversationHint === 'string' && conversationHint.trim() ? conversationHint.trim() : null;
  const conversationId = hint ?? (lease.state === 'leased' ? lease.conversation_id : null);
  if (!conversationId) return null;
  const raw = callerOrigin && typeof callerOrigin === 'object' ? (callerOrigin as { label?: unknown }).label : undefined;
  const caller = typeof raw === 'string' && raw.trim() && raw !== DEFAULT_ORIGIN_LABEL ? raw : undefined;
  const label = caller ?? scheduledTurnLabel(db, conversationId);
  return { kind: 'turn', agent_id: toBareAgentId(sender), conversation_id: conversationId, ...(label ? { label } : {}) };
}

/** The schedule name when the conversation's newest inbound message was fired by a schedule, else undefined. */
function scheduledTurnLabel(db: Database.Database, conversationId: string): string | undefined {
  const row = db.prepare(`SELECT metadata FROM transcripts WHERE conversation_id = ? AND direction = 'inbound'
      AND COALESCE(json_extract(metadata, '$.system_only'), 0) = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(conversationId) as { metadata: string } | undefined;
  if (!row) return undefined;
  try {
    return scheduleLabelFromMetadata(JSON.parse(row.metadata) as Record<string, unknown>) ?? undefined;
  } catch {
    return undefined;
  }
}
