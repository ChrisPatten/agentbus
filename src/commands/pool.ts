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

export interface PoolCommandDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
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
function formatPaneLine(pane: PoolLeaseRow, now: Date): string {
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
  return `  ${pane.pane_id}: ${parts.join('  ')}`;
}

/** One pool's full block: header line, one line per pane, one parked-queue line. */
function formatPoolBlock(key: string, manager: PoolManager, now: Date): string {
  const panes = manager.leaseStore.list(manager.poolId);
  const parked = manager.parkedStatus();

  const header = `Pool ${manager.poolId} (${key}) — ${panes.length} pane${panes.length === 1 ? '' : 's'}`;
  const paneLines = panes.map((p) => formatPaneLine(p, now));
  const parkedLine = parked.oldestParkedAt
    ? `  parked: ${parked.count} (oldest ${formatDurationMs(now.getTime() - new Date(parked.oldestParkedAt).getTime())})`
    : `  parked: ${parked.count}`;

  return [header, ...paneLines, parkedLine].join('\n');
}

export function createPoolCommand(deps: PoolCommandDeps): CommandDefinition {
  return {
    name: 'pool',
    description: 'Show cc-pool pane leases and parked-queue depth',
    usage: '/pool [pool-agent-id]',
    scope: 'bus',
    handler: async (args, _ctx) => {
      if (deps.poolManagers.size === 0) {
        return { body: 'No cc-pool instances configured.' };
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

      const body = entries.map(([key, manager]) => formatPoolBlock(key, manager, now)).join('\n\n');
      return { body };
    },
  };
}
