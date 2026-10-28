/**
 * E69 S69.1 — outbound origin metadata.
 *
 * Every agent send through the MCP tools (`send_message`, `reply`,
 * `send_email`) and cc-headless's fallback delivery carries
 * `metadata.origin`, so the bus can tell a Main turn's own sends from
 * foreign ones (a scheduled routine, another agent session) even when both
 * share the same `sender`. Rows with no origin are bus internals (command
 * responses, advisories, legacy rows) and are never treated as foreign.
 *
 * Pure and dependency-free: imported by the MCP child process (cc.ts) as
 * well as the bus.
 */
export type Origin =
  | { kind: 'turn'; agent_id: string; conversation_id: string; label?: string }
  | { kind: 'external'; label: string };

/** Per-turn env var cc-headless sets on its MCP child: the conversation the turn runs in. */
export const TURN_CONVERSATION_ENV = 'AGENTBUS_TURN_CONVERSATION_ID';
/** Optional MCP-server-wide source label for injected context. */
export const SOURCE_LABEL_ENV = 'AGENTBUS_SOURCE_LABEL';
/** Label used when neither the call nor the server names a source. */
export const DEFAULT_ORIGIN_LABEL = 'another agent session';

/**
 * The origin for a send from this MCP server. `kind: 'turn'` when the
 * per-turn conversation env var is set, `external` otherwise. Label
 * precedence: the per-call `source`, then `AGENTBUS_SOURCE_LABEL`, then
 * (external only) the generic default. `agentId` is the server's bare `AGENTBUS_AGENT_ID`
 * (the same value stamped as `sender`).
 */
export function originFromEnv(agentId: string, source?: string, env: NodeJS.ProcessEnv = process.env): Origin {
  const label = source?.trim() || env[SOURCE_LABEL_ENV]?.trim() || undefined;
  const conversationId = env[TURN_CONVERSATION_ENV]?.trim();
  // A turn's label is only an explicit one, so a quote of the agent's own
  // message isn't attributed to the generic "another agent session".
  return conversationId
    ? { kind: 'turn', agent_id: agentId, conversation_id: conversationId, ...(label ? { label } : {}) }
    : { kind: 'external', label: label ?? DEFAULT_ORIGIN_LABEL };
}

/** `metadata` with `origin` set, replacing any caller-supplied value. */
export function withOrigin(metadata: Record<string, unknown> | undefined, origin: Origin): Record<string, unknown> {
  return { ...(metadata ?? {}), origin };
}

/** Tolerant read of `metadata.origin`; null when absent or malformed. */
export function readOrigin(metadata: Record<string, unknown> | null | undefined): Origin | null {
  const raw = metadata?.['origin'];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o['label'] === 'string' && o['label'].trim() ? o['label'] : undefined;
  if (o['kind'] === 'external') return { kind: 'external', label: label ?? DEFAULT_ORIGIN_LABEL };
  if (o['kind'] === 'turn' && typeof o['conversation_id'] === 'string') {
    return {
      kind: 'turn',
      agent_id: typeof o['agent_id'] === 'string' ? o['agent_id'] : '',
      conversation_id: o['conversation_id'],
      ...(label ? { label } : {}),
    };
  }
  return null;
}

/** Whether a send with `origin` is foreign to `conversationId` (unstamped sends never are). */
export function isForeignOrigin(origin: Origin | null, conversationId: string): boolean {
  if (!origin) return false;
  return origin.kind === 'external' || origin.conversation_id !== conversationId;
}
