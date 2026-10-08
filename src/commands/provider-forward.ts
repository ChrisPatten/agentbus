/**
 * Provider command forwarding (E71) — sends a slash command the bus doesn't
 * handle itself to the provider that serves the conversation.
 *
 * A provider is the service that runs an agent's turns (`cc-pool`,
 * `cc-headless`), identified by the `adapterId` of a route's primary target.
 * Each provider that accepts commands registers one forwarder with
 * `CommandRegistry.registerProvider()`; `processInbound` (src/http/api.ts)
 * calls it for `//name`, or for a `/name` no bus command claims.
 */
import type { CommandResponse, SlashCommandContext } from './registry.js';
import type { HeadlessControl } from './handlers.js';
import type { RouteTarget } from '../pipeline/types.js';
import { PERMISSION_DIALOG_PATTERN, type PoolManager } from '../pool/pool-manager.js';
import {
  captureScreen,
  createTmuxController,
  realTmuxExec,
  realTmuxExecRaw,
  type TmuxExec,
} from '../pool/tmux.js';
import { renderPanePng, stripAnsi } from '../pool/pane-render.js';

/** Names the bus will forward: Claude Code commands, skills, `plugin:skill`. */
export const PROVIDER_COMMAND_NAME_RE = /^[A-Za-z][\w:-]*$/;

export interface ProviderForwardRequest {
  /** The route's primary target, after pool-route-resolve. */
  route: RouteTarget;
  /** Command name without the leading slash. */
  command: string;
  argsRaw: string;
  /** The line the provider receives: "/name" or "/name args". */
  line: string;
  ctx: SlashCommandContext;
}

export type ProviderForwardResult =
  /** Handled inline; send this response to the sender. */
  | { kind: 'reply'; response: CommandResponse }
  /** Enqueue for the provider, marked with `metadata.provider_command`. */
  | { kind: 'enqueue' }
  /** Not forwarded; send the reason to the sender. */
  | { kind: 'unsupported'; reason: string };

export interface ProviderCommandForwarder {
  forward(req: ProviderForwardRequest): Promise<ProviderForwardResult>;
}

/** "/name" or "/name args" — what the provider receives. */
export function providerCommandLine(command: string, argsRaw: string): string {
  return argsRaw ? `/${command} ${argsRaw}` : `/${command}`;
}

// ── cc-pool ───────────────────────────────────────────────────────────────────

/** How long to let the pane redraw before snapshotting it. */
export const POOL_SETTLE_MS = 1500;

/**
 * A captioned snapshot of a pane after keys were sent to it — the same image
 * `/pane` sends. Falls back to the caption alone if the capture fails: the
 * keys were already sent, so that is still a success.
 */
export async function paneSnapshotResponse(execRaw: TmuxExec, paneId: string, caption: string): Promise<CommandResponse> {
  try {
    const shot = await captureScreen(execRaw, paneId);
    return {
      images: [
        {
          png: renderPanePng(shot.text, shot.cols, shot.rows),
          caption,
          fallbackText: `${caption}\n\`\`\`\n${stripAnsi(shot.text)}\n\`\`\``,
        },
      ],
    };
  } catch {
    return { body: `${caption}.` };
  }
}

export interface PoolForwarderDeps {
  poolManagers: Map<string, PoolManager>;
  /** Injectable for tests; default to the real tmux execs. */
  tmuxExec?: TmuxExec;
  tmuxExecRaw?: TmuxExec;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Types the command into the pane leased to the conversation, then replies
 * with a snapshot of the pane. Same keystroke path as `/rc`
 * (src/commands/rc.ts); the snapshot is the same image `/pane` sends.
 */
export function createPoolForwarder(deps: PoolForwarderDeps): ProviderCommandForwarder {
  const tmux = createTmuxController(deps.tmuxExec ?? realTmuxExec);
  const execRaw = deps.tmuxExecRaw ?? realTmuxExecRaw;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async forward(req) {
      // After pool-route-resolve the recipient is a concrete pane's agent id,
      // or a parked bucket / unresolved logical id that matches no lease.
      let pane = null;
      for (const manager of deps.poolManagers.values()) {
        pane = manager.leaseStore.findByAgent(manager.poolId, req.route.recipientId);
        if (pane) break;
      }
      if (!pane) {
        return { kind: 'unsupported', reason: `No pool pane is available for this conversation; ${req.line} was not sent.` };
      }
      if (pane.state !== 'leased') {
        return { kind: 'unsupported', reason: `${pane.pane_id} is ${pane.state}; ${req.line} was not sent.` };
      }
      if (/[\x00-\x1f\x7f]/.test(req.line)) {
        return { kind: 'unsupported', reason: 'A forwarded command must be a single line.' };
      }

      try {
        const screen = await tmux.capturePane(pane.pane_id, 30);
        if (PERMISSION_DIALOG_PATTERN.test(screen)) {
          return {
            kind: 'unsupported',
            reason: `${pane.pane_id} is waiting at a prompt; ${req.line} was not sent. Check /pane.`,
          };
        }
        await tmux.sendCommand(pane.pane_id, req.line);
      } catch {
        return { kind: 'unsupported', reason: `${pane.pane_id}: could not send keys (tmux window not found or unreachable).` };
      }

      await sleep(deps.settleMs ?? POOL_SETTLE_MS);
      return {
        kind: 'reply',
        response: await paneSnapshotResponse(execRaw, pane.pane_id, `Sent ${req.line} to ${pane.pane_id}`),
      };
    },
  };
}

// ── cc-headless ───────────────────────────────────────────────────────────────

/**
 * Queues the command for the owning cc-headless instance, which runs it as
 * its own `claude -p "/name args"` turn (see `HeadlessInstance` in
 * src/adapters/cc-headless.ts). Refuses a name the instance's last `init`
 * event didn't list; before the instance's first turn the list is unknown
 * and the command is let through.
 */
export function createHeadlessForwarder(deps: { headlessControl: HeadlessControl }): ProviderCommandForwarder {
  return {
    async forward(req) {
      const known = deps.headlessControl.slashCommands.get(req.route.recipientId);
      if (!known) {
        return { kind: 'unsupported', reason: `No cc-headless instance is running for ${req.route.recipientId}.` };
      }
      const names = known();
      if (names && !names.includes(req.command)) {
        return { kind: 'unsupported', reason: `The provider has no /${req.command} command in headless mode.` };
      }
      return { kind: 'enqueue' };
    },
  };
}
