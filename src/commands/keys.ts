/**
 * `/keys` — send keystrokes to a cc-pool Claude pane, e.g. to answer a dialog
 * or interrupt a turn from chat (E58).
 *
 * Same shape as `src/commands/rc.ts`: pane candidates come from the pools'
 * `LeaseStore`, keystrokes go through an injected `TmuxExec`. Unlike `/rc` it
 * also targets a `launching` or `draining` pane — a pane stuck at a prompt is
 * the main reason to send keys — and it replies with a snapshot of the pane.
 */
import type { CommandDefinition } from './registry.js';
import type { PoolManager } from '../pool/pool-manager.js';
import type { PoolLeaseRow } from '../pool/types.js';
import { realTmuxExec, realTmuxExecRaw, type TmuxExec } from '../pool/tmux.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { paneIndex } from './pane.js';
import { POOL_SETTLE_MS, paneSnapshotResponse } from './provider-forward.js';

/** Most keys one `/keys` call sends. */
export const MAX_KEYS = 20;

const USAGE = 'Usage: /keys [@n] <key> [key...]\nExample: /keys Escape   /keys @2 Down Enter   /keys "yes please" Enter';

export interface KeysCommandDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; default to the real tmux execs. */
  tmuxExec?: TmuxExec;
  tmuxExecRaw?: TmuxExec;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Splits on whitespace; a double-quoted run is one key (typed literally by tmux). */
export function parseKeys(argsRaw: string): string[] {
  const keys: string[] = [];
  for (const m of argsRaw.matchAll(/"([^"]*)"|(\S+)/g)) {
    const key = m[1] ?? m[2]!;
    if (key) keys.push(key);
  }
  return keys;
}

export function createKeysCommand(deps: KeysCommandDeps): CommandDefinition {
  const exec = deps.tmuxExec ?? realTmuxExec;
  const execRaw = deps.tmuxExecRaw ?? realTmuxExecRaw;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    name: 'keys',
    description: 'Send keystrokes to a cc-pool Claude pane',
    usage: '/keys [@n] <key> [key...]',
    scope: 'bus',
    handler: async (_args, ctx) => {
      if (deps.poolManagers.size === 0) {
        return { body: 'No cc-pool instances configured; /keys only works for a provider running in tmux.' };
      }

      const keys = parseKeys(ctx.argsRaw);
      const paneArg = /^@(\d+)$/.exec(keys[0] ?? '')?.[1];
      if (paneArg !== undefined) keys.shift();
      if (keys.length === 0) return { body: USAGE };
      if (keys.length > MAX_KEYS) return { body: `Too many keys (max ${MAX_KEYS}).` };
      if (keys.some((k) => /[\x00-\x1f\x7f]/.test(k))) {
        return { body: 'Keys must not contain control characters. Use key names such as Enter, Tab, or C-c.' };
      }

      const panes: PoolLeaseRow[] = [];
      for (const manager of deps.poolManagers.values()) {
        panes.push(...manager.leaseStore.list(manager.poolId));
      }

      let matches: PoolLeaseRow[];
      if (paneArg === undefined) {
        const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
        const conv = computeConversationId(contactId, ctx.envelope.channel, ctx.envelope.topic);
        matches = panes.filter((p) => p.conversation_id === conv && p.state !== 'free' && p.state !== 'dead');
        if (matches.length === 0) {
          return { body: 'No pane is leased to this conversation. Use /keys @<n> <key> (see /pool).' };
        }
      } else {
        matches = panes.filter((p) => paneIndex(p.pane_id) === paneArg);
        if (matches.length === 0) {
          return { body: `No pane with index ${paneArg}. Try /pool to list panes.` };
        }
        if (matches.length > 1) {
          return { body: `Pane index ${paneArg} is ambiguous across pools; no keys sent.` };
        }
      }

      const pane = matches[0]!;
      if (pane.state === 'dead') {
        return { body: `${pane.pane_id} is dead; not sending keys.` };
      }

      try {
        // `--` so a key such as "-1" is never read as a tmux flag. tmux sends
        // a name it knows (Enter, C-c) as that key and anything else as text.
        await exec(['send-keys', '-t', pane.pane_id, '--', ...keys]);
      } catch {
        return { body: `${pane.pane_id}: could not send keys (tmux window not found or unreachable).` };
      }

      await sleep(deps.settleMs ?? POOL_SETTLE_MS);
      return paneSnapshotResponse(execRaw, pane.pane_id, `Sent ${keys.join(' ')} to ${pane.pane_id}`);
    },
  };
}
