/**
 * `/pool` — cc-pool pane leases and parked-queue depth (E48 S48.8).
 *
 * Factored into its own module (rather than living inline in handlers.ts) so
 * it can carry its own dedicated deps (`poolManagers`) — the same extraction
 * pattern `src/commands/cost.ts` uses for `db`/`headlessControl`.
 */
import type { CommandDefinition } from './registry.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { toBareAgentId, type PoolLeaseRow } from '../pool/types.js';
import { commandConversationId } from './handlers.js';
import type { SlashCommandContext } from './registry.js';
import type Database from 'better-sqlite3';

export interface PoolCommandDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** E80 — flags the pane serving the conversation the command was sent from. */
export const THIS_CHAT_MARKER = '◀ this chat';

/** The conversation a command was sent from (honours the Mac app's bound session). */
function currentConversation(ctx: SlashCommandContext): string {
  const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
  // SafeDatabase exposes the .prepare().get() that commandConversationId needs.
  return commandConversationId(ctx, ctx.db as unknown as Database.Database, contactId);
}

/**
 * "1234" (ms) -> "1s", "90000" -> "1m", etc. — floors to the coarsest unit
 * that still produces a value >= 1, mirroring how a human would casually
 * describe an elapsed duration. Shared by the per-pane `idle=` annotation
 * and the parked-queue's `oldest` age.
 */
function formatDurationMs(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * One pane's line: "  <pane_id>: <state>  conv=<short>  model=<m>  idle=<age>".
 * `conv=`, `model=`, and `idle=` are each omitted when the underlying value
 * is null — a free pane has none of them. `conversation_id` is truncated to
 * its first 8 hex chars: the full sha256 hex is unreadable in a chat
 * message, and 8 chars is plenty to eyeball-match across two truncated
 * displays (e.g. /sessions). `model=` (E53) is the model the pane's current
 * Claude session was launched with — `pool_leases.model`, `null` when the
 * pane launched with no `--model` flag (CLI default).
 */
function formatPaneLine(pane: PoolLeaseRow, now: Date, currentConversationId: string): string {
  const parts: string[] = [pane.state];
  if (pane.conversation_id) {
    parts.push(`conv=${pane.conversation_id.slice(0, 8)}`);
  }
  if (pane.model) {
    parts.push(`model=${pane.model}`);
  }
  if (pane.last_activity_at) {
    parts.push(`idle=${formatDurationMs(now.getTime() - new Date(pane.last_activity_at).getTime())}`);
  }
  const marker = pane.state === 'leased' && pane.conversation_id === currentConversationId ? `  ${THIS_CHAT_MARKER}` : '';
  return `  ${pane.pane_id}: ${parts.join('  ')}${marker}`;
}

/** One pool's full block: header line, one line per pane, one parked-queue line. */
function formatPoolBlock(key: string, manager: PoolManager, now: Date, conversationId: string): string {
  const panes = manager.leaseStore.list(manager.poolId);
  const parked = manager.parkedStatus();

  const header = `Pool ${manager.poolId} (${key}) — ${panes.length} pane${panes.length === 1 ? '' : 's'}`;
  const paneLines = panes.map((p) => formatPaneLine(p, now, conversationId));
  const parkedLine = parked.oldestParkedAt
    ? `  parked: ${parked.count} (oldest ${formatDurationMs(now.getTime() - new Date(parked.oldestParkedAt).getTime())})`
    : `  parked: ${parked.count}`;

  return [header, ...paneLines, parkedLine].join('\n');
}

export function createPoolCommand(deps: PoolCommandDeps): CommandDefinition {
  return {
    name: 'pool',
    description: 'Show cc-pool panes (marks this chat\'s) or kill this chat\'s pane',
    usage: '/pool [pool-agent-id] | /pool kill',
    scope: 'bus',
    handler: async (args, ctx) => {
      if (deps.poolManagers.size === 0) {
        return { body: 'No cc-pool instances configured.' };
      }
      const conversationId = currentConversation(ctx);

      // E80 — `/pool kill`: kill the window serving this conversation, even
      // mid-turn. The next message acquires a fresh window.
      if (args[0]?.toLowerCase() === 'kill') {
        if (args.length > 1) return { body: 'Usage: /pool kill' };
        for (const manager of deps.poolManagers.values()) {
          const killed = manager.killConversation(conversationId);
          if (!killed) continue;
          void killed.done.catch((err: unknown) => console.error(`[commands] /pool kill: ${killed.paneId} failed:`, err));
          return {
            body:
              `Killed ${killed.paneId}${killed.inFlight ? ' (a turn was in flight and was cut off)' : ''}. ` +
              'Your next message starts on a fresh window.',
          };
        }
        return { body: 'No pane is serving this chat; nothing to kill.' };
      }

      const now = (deps.now ?? (() => new Date()))();

      // args[0], when given, is matched against either the bare ("peggy") or
      // "agent:"-prefixed ("agent:peggy") form of a poolManagers key —
      // toBareAgentId() normalizes both sides so either spelling works.
      const filterArg = args[0];
      const entries = filterArg
        ? [...deps.poolManagers.entries()].filter(([key]) => toBareAgentId(key) === toBareAgentId(filterArg))
        : [...deps.poolManagers.entries()];

      if (filterArg && entries.length === 0) {
        return { body: `No cc-pool instance for "${filterArg}".` };
      }

      const blocks = entries.map(([key, manager]) => formatPoolBlock(key, manager, now, conversationId));
      const serving = entries.some(([, m]) =>
        m.leaseStore.list(m.poolId).some((p) => p.state === 'leased' && p.conversation_id === conversationId),
      );
      if (!serving) blocks.push('This chat: no pane is serving it (none held; its next message takes a free pane or parks).');
      return { body: blocks.join('\n\n') };
    },
  };
}
