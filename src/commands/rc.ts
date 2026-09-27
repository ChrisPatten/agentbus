/**
 * `/rc` — type `/remote-control` into a cc-pool Claude pane, so a pane can be
 * switched to Remote Control from chat.
 *
 * Same shape as `src/commands/pane.ts`: pane candidates come from the pools'
 * `LeaseStore`, keystrokes go through the tmux controller built on an
 * injected `TmuxExec`. Unlike `/pane` this writes to the pane, so it only
 * targets a pane that is bound or free — never one that is launching,
 * draining, or dead.
 */
import type { CommandDefinition } from './registry.js';
import type { PoolManager } from '../pool/pool-manager.js';
import type { PoolLeaseRow } from '../pool/types.js';
import { createTmuxController, realTmuxExec, type TmuxExec } from '../pool/tmux.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { paneIndex } from './pane.js';

/** The line typed into the pane. */
export const REMOTE_CONTROL_LINE = '/remote-control';

export interface RcCommandDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; defaults to the real tmux exec. */
  tmuxExec?: TmuxExec;
}

export function createRcCommand(deps: RcCommandDeps): CommandDefinition {
  const tmux = createTmuxController(deps.tmuxExec ?? realTmuxExec);

  return {
    name: 'rc',
    description: 'Send /remote-control to a cc-pool Claude pane',
    usage: '/rc [n]',
    scope: 'bus',
    handler: async (args, ctx) => {
      if (deps.poolManagers.size === 0) {
        return { body: 'No cc-pool instances configured.' };
      }
      const arg = args[0];
      if (arg !== undefined && !/^\d+$/.test(arg)) {
        return { body: 'Usage: /rc [n]' };
      }

      const panes: PoolLeaseRow[] = [];
      for (const manager of deps.poolManagers.values()) {
        panes.push(...manager.leaseStore.list(manager.poolId));
      }

      let matches: PoolLeaseRow[];
      if (arg === undefined) {
        const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
        const conv = computeConversationId(contactId, ctx.envelope.channel, ctx.envelope.topic);
        matches = panes.filter((p) => p.conversation_id === conv && p.state === 'leased');
        if (matches.length === 0) {
          return { body: 'No pane is leased to this conversation. Use /rc <n> (see /pool).' };
        }
      } else {
        matches = panes.filter((p) => paneIndex(p.pane_id) === arg);
        if (matches.length === 0) {
          return { body: `No pane with index ${arg}. Try /pool to list panes.` };
        }
        if (matches.length > 1) {
          return { body: `Pane index ${arg} is ambiguous across pools; no keys sent.` };
        }
      }

      const pane = matches[0]!;
      if (pane.state !== 'leased' && pane.state !== 'free') {
        return { body: `${pane.pane_id} is ${pane.state}; not sending keys.` };
      }

      try {
        await tmux.sendCommand(pane.pane_id, REMOTE_CONTROL_LINE);
      } catch {
        return { body: `${pane.pane_id}: could not send keys (tmux window not found or unreachable).` };
      }
      return { body: `Sent ${REMOTE_CONTROL_LINE} to ${pane.pane_id}.` };
    },
  };
}
