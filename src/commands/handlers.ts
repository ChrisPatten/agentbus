/**
 * Built-in bus command handlers.
 *
 * Each handler is a CommandHandler: (args, context) => Promise<CommandResponse>.
 * All 7 built-in commands live here; custom/plugin commands call
 * CommandRegistry.register() directly.
 *
 * Handlers that depend on future epics degrade gracefully:
 *   /forget — returns "Memory system not yet available" until E8 lands.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CommandDefinition, CommandHandler, CommandResponse, SlashCommandContext } from './registry.js';
import type { CommandRegistry } from './registry.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { MessageQueue } from '../core/queue.js';

export interface HandlerDeps {
  adapterRegistry: AdapterRegistry;
  queue: MessageQueue;
  pauseSet: Set<string>;
  /** Raw DB handle for built-in commands that need write access */
  db: Database.Database;
}

// ── /status ──────────────────────────────────────────────────────────────────

async function statusHandler(
  _args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const counts = deps.queue.counts();
  const adapters = deps.adapterRegistry.list();

  const adapterLines: string[] = [];
  for (const adapter of adapters) {
    const health = await adapter.health().catch(() => ({ status: 'unhealthy' as const }));
    const paused = deps.pauseSet.has(adapter.id) ? ' [PAUSED]' : '';
    adapterLines.push(`  ${adapter.id}: ${health.status}${paused}`);
  }

  const lines = [
    'AgentBus status',
    '',
    'Adapters:',
    ...adapterLines,
    '',
    'Queue:',
    `  pending:    ${counts['pending'] ?? 0}`,
    `  processing: ${counts['processing'] ?? 0}`,
    `  delivered:  ${counts['delivered'] ?? 0}`,
    `  dead_letter: ${counts['dead_letter'] ?? 0}`,
  ];

  return { body: lines.join('\n') };
}

// ── /help ─────────────────────────────────────────────────────────────────────

/**
 * Create a /help handler bound to a specific CommandRegistry instance.
 * Called from createCommandSystem() after all other commands are registered,
 * so the handler can list everything in the registry at call time.
 */
export function createHelpHandler(registry: CommandRegistry): CommandHandler {
  return async (args: string[]): Promise<CommandResponse> => {
    if (args.length > 0) {
      const name = args[0]!;
      const cmd = registry.lookup(name);
      if (!cmd) {
        return { body: `Unknown command: ${name}\nType /help to list all commands.` };
      }
      return { body: `${cmd.usage}\n\n${cmd.description}` };
    }

    const commands = registry.list().filter((c) => c.scope === 'bus');
    const lines = ['Available commands:', ''];
    for (const cmd of commands) {
      lines.push(`  /${cmd.name} — ${cmd.description}`);
    }
    lines.push('', 'Type /help <command> for detailed usage.');
    return { body: lines.join('\n') };
  };
}

// ── /pause ────────────────────────────────────────────────────────────────────

async function pauseHandler(
  args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const adapterId = args[0];
  if (!adapterId) {
    return { body: 'Usage: /pause <adapterId>\nExample: /pause telegram' };
  }
  const adapter = deps.adapterRegistry.lookup(adapterId);
  if (!adapter) {
    return { body: `Unknown adapter: ${adapterId}\nUse /status to see registered adapters.` };
  }
  if (deps.pauseSet.has(adapterId)) {
    return { body: `Adapter "${adapterId}" is already paused.` };
  }
  deps.pauseSet.add(adapterId);
  deps.db
    .prepare(`INSERT OR REPLACE INTO paused_adapters (adapter_id, paused_at, paused_by) VALUES (?, ?, ?)`)
    .run(adapterId, new Date().toISOString(), ctx.sender);
  return { body: `Adapter "${adapterId}" paused. Inbound messages will be dropped until resumed.` };
}

// ── /resume ───────────────────────────────────────────────────────────────────

async function resumeHandler(
  args: string[],
  _ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const adapterId = args[0];
  if (!adapterId) {
    return { body: 'Usage: /resume <adapterId>\nExample: /resume telegram' };
  }
  const adapter = deps.adapterRegistry.lookup(adapterId);
  if (!adapter) {
    return { body: `Unknown adapter: ${adapterId}\nUse /status to see registered adapters.` };
  }
  if (!deps.pauseSet.has(adapterId)) {
    return { body: `Adapter "${adapterId}" is not paused.` };
  }
  deps.pauseSet.delete(adapterId);
  deps.db.prepare(`DELETE FROM paused_adapters WHERE adapter_id = ?`).run(adapterId);
  // TODO(E9): trigger context briefing for this conversation on resume
  return { body: `Adapter "${adapterId}" resumed. Messages will flow normally.` };
}

// ── /sessions ─────────────────────────────────────────────────────────────────

async function sessionsHandler(
  args: string[],
  ctx: SlashCommandContext,
): Promise<CommandResponse> {
  // Parse optional channel filter and --limit N
  let channel: string | undefined;
  let limit = 10;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--limit' && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 50);
      i++;
    } else if (!arg.startsWith('--')) {
      channel = arg;
    }
  }

  const rows = channel
    ? (ctx.db
        .prepare(
          `SELECT id, channel, contact_id, started_at, message_count, ended_at
           FROM sessions WHERE channel = ?
           ORDER BY last_activity DESC LIMIT ?`,
        )
        .all(channel, limit) as SessionRow[])
    : (ctx.db
        .prepare(
          `SELECT id, channel, contact_id, started_at, message_count, ended_at
           FROM sessions ORDER BY last_activity DESC LIMIT ?`,
        )
        .all(limit) as SessionRow[]);

  if (rows.length === 0) {
    return { body: 'No sessions found.' };
  }

  const lines = [`Sessions (${rows.length} shown):\n`];
  for (const row of rows) {
    const status = row.ended_at ? 'closed' : 'active';
    const shortId = row.id.slice(0, 8);
    const started = row.started_at.slice(0, 16).replace('T', ' ');
    lines.push(`  ${shortId}  ${row.channel}  ${row.contact_id}  ${started}  ${row.message_count} msgs  [${status}]`);
  }
  return { body: lines.join('\n') };
}

interface SessionRow {
  id: string;
  channel: string;
  contact_id: string;
  started_at: string;
  message_count: number;
  ended_at: string | null;
}

// ── Playback state (for paginated /replay) ──────────────────────────────────

const DEFAULT_MAX_MESSAGE_LENGTH = 4096;
const REPLAY_FOOTER = '\n\nReply /next for next message or /cancel to stop playback.';

export interface PlaybackState {
  pages: string[];
  currentPage: number;
}

/** Per-sender playback state for paginated /replay */
export const playbackStates = new Map<string, PlaybackState>();

/**
 * Split transcript lines into pages that fit within maxLength.
 * If a single line exceeds the effective limit, it is split mid-line.
 */
export function paginateLines(lines: string[], maxLength: number): string[] {
  const hasMultiplePages = lines.join('\n').length > maxLength;
  // Reserve space for the pagination footer on multi-page output.
  // Floor at 1 to prevent negative/zero effective limits.
  const effectiveMax = hasMultiplePages ? Math.max(1, maxLength - REPLAY_FOOTER.length) : maxLength;

  const pages: string[] = [];
  let currentPage = '';

  for (const line of lines) {
    // If a single line exceeds the limit, split it into chunks
    if (line.length > effectiveMax) {
      // Flush current page first
      if (currentPage) {
        pages.push(currentPage);
        currentPage = '';
      }
      let remaining = line;
      while (remaining.length > effectiveMax) {
        pages.push(remaining.slice(0, effectiveMax));
        remaining = remaining.slice(effectiveMax);
      }
      if (remaining) currentPage = remaining;
      continue;
    }

    const candidate = currentPage ? currentPage + '\n' + line : line;
    if (candidate.length > effectiveMax) {
      pages.push(currentPage);
      currentPage = line;
    } else {
      currentPage = candidate;
    }
  }
  if (currentPage) pages.push(currentPage);

  return pages;
}

// ── /replay ───────────────────────────────────────────────────────────────────

async function replayHandler(
  args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const sessionId = args[0];
  if (!sessionId) {
    return { body: 'Usage: /replay <session_id>\nGet session IDs with /sessions.' };
  }

  // Allow short ID prefix matching (first 8 chars).
  // Use ORDER BY + LIMIT 1 for deterministic results on prefix collisions.
  const session =
    ctx.db
      .prepare(`SELECT id, channel, contact_id, started_at, ended_at, message_count FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined ??
    (sessionId.length < 36
      ? (ctx.db
          .prepare(`SELECT id, channel, contact_id, started_at, ended_at, message_count FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1`)
          .get(sessionId + '%') as SessionRow | undefined)
      : undefined);

  if (!session) {
    return { body: `Session not found: ${sessionId}` };
  }

  const transcript = ctx.db
    .prepare(
      `SELECT direction, body, created_at FROM transcripts
       WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(session.id) as Array<{ direction: string; body: string; created_at: string }>;

  if (transcript.length === 0) {
    return { body: `Session ${session.id.slice(0, 8)} has no transcript entries.` };
  }

  const started = session.started_at.slice(0, 16).replace('T', ' ');
  const header = `Session ${session.id.slice(0, 8)} — ${session.channel} — ${started}`;
  const lines = [header, '-'.repeat(header.length), ''];

  for (const row of transcript) {
    const who = row.direction === 'inbound' ? '>' : '<';
    const time = row.created_at.slice(11, 16);
    lines.push(`${time} ${who} ${row.body}`);
  }

  // Determine max message length from adapter capabilities
  const adapter = deps.adapterRegistry.lookup(ctx.adapterId);
  const maxLen = adapter?.capabilities.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;

  const pages = paginateLines(lines, maxLen);

  if (pages.length === 1) {
    playbackStates.delete(ctx.sender);
    return { body: pages[0]! };
  }

  // Multi-page: store state and send first page with footer
  playbackStates.set(ctx.sender, { pages, currentPage: 0 });
  return { body: pages[0]! + REPLAY_FOOTER };
}

// ── /next ────────────────────────────────────────────────────────────────────

async function nextHandler(
  _args: string[],
  ctx: SlashCommandContext,
): Promise<CommandResponse> {
  const state = playbackStates.get(ctx.sender);
  if (!state) {
    return { body: 'No active playback. Use /replay <session_id> to start.' };
  }

  state.currentPage++;
  const page = state.pages[state.currentPage]!;
  const isLast = state.currentPage >= state.pages.length - 1;

  if (isLast) {
    playbackStates.delete(ctx.sender);
    return { body: page };
  }

  return { body: page + REPLAY_FOOTER };
}

// ── /cancel ──────────────────────────────────────────────────────────────────

async function cancelHandler(
  _args: string[],
  ctx: SlashCommandContext,
): Promise<CommandResponse> {
  if (!playbackStates.has(ctx.sender)) {
    return { body: 'No active playback to cancel.' };
  }
  playbackStates.delete(ctx.sender);
  return { body: 'Playback cancelled.' };
}

// ── /retry-summary ────────────────────────────────────────────────────────────

async function retrySummaryHandler(
  args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const sessionIdArg = args[0];
  if (!sessionIdArg) {
    return { body: 'Usage: /retry-summary <session_id>\nUse /sessions to list session IDs.' };
  }

  // Exact match first, then prefix match (like /replay)
  type SessStatus = { id: string; status: string; summary_attempts: number };
  const session =
    (ctx.db
      .prepare(`SELECT id, status, summary_attempts FROM sessions WHERE id = ?`)
      .get(sessionIdArg) as SessStatus | undefined) ??
    (sessionIdArg.length < 36
      ? (ctx.db
          .prepare(
            `SELECT id, status, summary_attempts FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1`,
          )
          .get(sessionIdArg + '%') as SessStatus | undefined)
      : undefined);

  if (!session) {
    return { body: `Session not found: ${sessionIdArg}` };
  }

  if (session.status !== 'summarize_failed') {
    return {
      body: `Session ${session.id.slice(0, 8)} is not in a failed state (status: ${session.status}).`,
    };
  }

  // Reset for next session tracker tick to pick up
  deps.db
    .prepare(
      `UPDATE sessions SET status = 'summarize_pending', summary_attempts = 0 WHERE id = ?`,
    )
    .run(session.id);

  return {
    body: `Session ${session.id.slice(0, 8)} queued for re-summarization. The tracker will retry on the next tick (up to 60s).`,
  };
}

// ── /forget ───────────────────────────────────────────────────────────────────

async function forgetHandler(
  args: string[],
  _ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const contactId = args[0];
  if (!contactId) {
    return { body: 'Usage: /forget <contact_id>\nExample: /forget alice' };
  }

  // Check if memories table exists (E8 may not be installed yet)
  const tableExists = deps.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
    .get() as { name: string } | undefined;

  if (!tableExists) {
    return { body: 'Memory system not yet available. (Pending E8 implementation.)' };
  }

  const now = new Date().toISOString();
  const result = deps.db
    .prepare(
      `UPDATE memories SET superseded_by = 'manual_forget', expires_at = ?
       WHERE contact_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .run(now, contactId, now);

  const count = result.changes;
  if (count === 0) {
    return { body: `No active memories found for contact: ${contactId}` };
  }
  return { body: `Forgot ${count} memory record${count === 1 ? '' : 's'} for contact: ${contactId}` };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build built-in command definitions, with deps injected via closure.
 * /help is registered separately in createCommandSystem() after all others.
 */
export function createBuiltinCommands(deps: HandlerDeps): CommandDefinition[] {
  return [
    {
      name: 'status',
      description: 'Show adapter status and queue depth',
      usage: '/status',
      scope: 'bus',
      handler: (_args, ctx) => statusHandler(_args, ctx, deps),
    },
    {
      name: 'pause',
      description: 'Pause inbound messages from an adapter',
      usage: '/pause <adapterId>',
      scope: 'bus',
      handler: (args, ctx) => pauseHandler(args, ctx, deps),
    },
    {
      name: 'resume',
      description: 'Resume a paused adapter',
      usage: '/resume <adapterId>',
      scope: 'bus',
      handler: (args, ctx) => resumeHandler(args, ctx, deps),
    },
    {
      name: 'sessions',
      description: 'List recent sessions',
      usage: '/sessions [channel] [--limit N]',
      scope: 'bus',
      handler: sessionsHandler,
    },
    {
      name: 'replay',
      description: 'Replay transcript for a session',
      usage: '/replay <session_id>',
      scope: 'bus',
      handler: (args, ctx) => replayHandler(args, ctx, deps),
    },
    {
      name: 'next',
      description: 'Show next page of replay playback',
      usage: '/next',
      scope: 'bus',
      handler: nextHandler,
    },
    {
      name: 'cancel',
      description: 'Cancel active replay playback',
      usage: '/cancel',
      scope: 'bus',
      handler: cancelHandler,
    },
    {
      name: 'forget',
      description: 'Expire all memories for a contact',
      usage: '/forget <contact_id>',
      scope: 'bus',
      handler: (args, ctx) => forgetHandler(args, ctx, deps),
    },
    {
      name: 'retry-summary',
      description: 'Re-queue summarization for a failed session',
      usage: '/retry-summary <session_id>',
      scope: 'bus',
      handler: (args, ctx) => retrySummaryHandler(args, ctx, deps),
    },
  ];
}
