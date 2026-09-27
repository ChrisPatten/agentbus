/**
 * `/pane` — PNG snapshot of the cc-pool's tmux pane(s), so a stuck pane can
 * be inspected from chat without attaching to tmux.
 *
 * Same extraction pattern as `src/commands/cost.ts`/`pool.ts`: its own module
 * with its own deps. The capture goes through an injected `TmuxExec` (unit
 * tests pass a fake), the tmux session name comes from the pool's config
 * (`tmux_session`), and lease/model data comes from the pool's `LeaseStore`.
 *
 * The captured screen can contain sensitive text, so nothing here logs it.
 */
import type { CommandDefinition, CommandImage, SlashCommandContext } from './registry.js';
import type { PoolManager } from '../pool/pool-manager.js';
import { toBareAgentId, type PoolLeaseRow } from '../pool/types.js';
import { captureScreen, realTmuxExecRaw, type TmuxExec } from '../pool/tmux.js';
import { renderPanePng, stripAnsi } from '../pool/pane-render.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { getCcPoolInstances } from '../config/schema.js';

/** Most images a single `/pane` reply may carry. */
export const MAX_PANES = 8;

export interface PaneCommandDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; defaults to a real, untrimmed tmux exec. */
  tmuxExec?: TmuxExec;
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Lease state as shown in the caption: a `leased` pane reads as `bound`. */
function stateLabel(pane: PoolLeaseRow): string {
  return pane.state === 'leased' ? 'bound' : pane.state;
}

/** "peggy-pool:2" -> "2" — the pane's index within its tmux session. */
export function paneIndex(paneId: string): string {
  return paneId.slice(paneId.lastIndexOf(':') + 1);
}

function buildCaption(pane: PoolLeaseRow, ctx: SlashCommandContext, isInvoking: boolean, now: Date): string {
  const parts = [`${pane.pane_id}`, stateLabel(pane)];
  if (pane.conversation_id) {
    const topic = isInvoking ? ` (${ctx.envelope.topic})` : '';
    parts.push(`conv=${pane.conversation_id.slice(0, 8)}${topic}`);
  }
  parts.push(`model=${pane.model ?? 'default'}`);
  parts.push(`captured ${now.toISOString()}`);
  return parts.join(' · ');
}

export function createPaneCommand(deps: PaneCommandDeps): CommandDefinition {
  const exec = deps.tmuxExec ?? realTmuxExecRaw;

  return {
    name: 'pane',
    description: 'Send a PNG snapshot of the cc-pool tmux pane(s)',
    usage: '/pane [n|all]',
    scope: 'bus',
    handler: async (args, ctx) => {
      if (deps.poolManagers.size === 0) {
        return { body: 'No cc-pool instances configured.' };
      }

      const now = (deps.now ?? (() => new Date()))();
      const arg = args[0]?.toLowerCase();
      if (arg !== undefined && arg !== 'all' && !/^\d+$/.test(arg)) {
        return { body: 'Usage: /pane [n|all]' };
      }

      const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
      const invokingConv = computeConversationId(contactId, ctx.envelope.channel, ctx.envelope.topic);
      const tmuxSessions = new Map(
        getCcPoolInstances(ctx.config).map((c) => [toBareAgentId(c.agent_id), c.tmux_session]),
      );

      // Candidate panes, tagged with the tmux session their pool is configured with.
      const all: Array<{ pane: PoolLeaseRow; session: string | undefined }> = [];
      for (const manager of deps.poolManagers.values()) {
        for (const pane of manager.leaseStore.list(manager.poolId)) {
          all.push({ pane, session: tmuxSessions.get(toBareAgentId(manager.poolId)) });
        }
      }

      let selected = all;
      if (arg === undefined) {
        const mine = all.filter(({ pane }) => pane.conversation_id === invokingConv && pane.state === 'leased');
        if (mine.length > 0) selected = mine;
      } else if (arg !== 'all') {
        selected = all.filter(({ pane }) => paneIndex(pane.pane_id) === arg);
        if (selected.length === 0) {
          return { body: `No pane with index ${arg}. Try /pool to list panes.` };
        }
      }
      if (selected.length === 0) {
        return { body: 'The pool has no panes yet.' };
      }
      selected = selected.slice(0, MAX_PANES);

      const images: CommandImage[] = [];
      const errors: string[] = [];
      for (const { pane, session } of selected) {
        // The lease's pane_id is the tmux target; the configured session name
        // is only used to make a "not found" error readable.
        try {
          const screen = await captureScreen(exec, pane.pane_id);
          const caption = buildCaption(pane, ctx, pane.conversation_id === invokingConv, now);
          images.push({
            png: renderPanePng(screen.text, screen.cols, screen.rows),
            caption,
            fallbackText: `${caption}\n\`\`\`\n${stripAnsi(screen.text)}\n\`\`\``,
          });
        } catch (err) {
          // Deliberately no err.message: tmux's own error text never contains
          // screen content, but a short fixed reason keeps the reply tidy.
          const missing = /can't find/i.test(err instanceof Error ? err.message : String(err));
          errors.push(
            `${pane.pane_id}: ${missing ? `tmux session "${session ?? pane.pane_id}" or window not found` : 'capture failed'} (state ${stateLabel(pane)}).`,
          );
        }
      }

      const body = errors.join('\n');
      return images.length > 0 ? { ...(body ? { body } : {}), images } : { body };
    },
  };
}
