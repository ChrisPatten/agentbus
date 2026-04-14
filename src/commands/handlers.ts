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
import type { CommandDefinition, CommandResponse, SlashCommandContext } from './registry.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { MessageQueue } from '../core/queue.js';

export interface HandlerDeps {
  adapterRegistry: AdapterRegistry;
  queue: MessageQueue;
  pauseSet: Set<string>;
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

// Handler receives the full registry via closure — set after all commands registered.
// We use a late-binding ref pattern (thunk) so help can list all registered commands.
let getRegistryList: (() => CommandDefinition[]) | undefined;
let getRegistryLookup: ((name: string) => CommandDefinition | undefined) | undefined;

export function bindHelpToRegistry(
  list: () => CommandDefinition[],
  lookup: (name: string) => CommandDefinition | undefined,
): void {
  getRegistryList = list;
  getRegistryLookup = lookup;
}

async function helpHandler(
  args: string[],
  _ctx: SlashCommandContext,
): Promise<CommandResponse> {
  if (!getRegistryList || !getRegistryLookup) {
    return { body: 'Help system not yet initialized.' };
  }

  if (args.length > 0) {
    const name = args[0]!;
    const cmd = getRegistryLookup(name);
    if (!cmd) {
      return { body: `Unknown command: ${name}\nType /help to list all commands.` };
    }
    return { body: `${cmd.usage}\n\n${cmd.description}` };
  }

  const commands = getRegistryList().filter((c) => c.scope === 'bus');
  const lines = ['Available commands:', ''];
  for (const cmd of commands) {
    lines.push(`  /${cmd.name} — ${cmd.description}`);
  }
  lines.push('', 'Type /help <command> for detailed usage.');
  return { body: lines.join('\n') };
}

// ── /pause ────────────────────────────────────────────────────────────────────

async function pauseHandler(
  args: string[],
  _ctx: SlashCommandContext,
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

// ── /replay ───────────────────────────────────────────────────────────────────

async function replayHandler(
  args: string[],
  ctx: SlashCommandContext,
): Promise<CommandResponse> {
  const sessionId = args[0];
  if (!sessionId) {
    return { body: 'Usage: /replay <session_id>\nGet session IDs with /sessions.' };
  }

  // Allow short ID prefix matching (first 8 chars)
  const session =
    ctx.db
      .prepare(`SELECT id, channel, contact_id, started_at, ended_at, message_count FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined ??
    (sessionId.length < 36
      ? (ctx.db
          .prepare(`SELECT id, channel, contact_id, started_at, ended_at, message_count FROM sessions WHERE id LIKE ?`)
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

  return { body: lines.join('\n') };
}

// ── /forget ───────────────────────────────────────────────────────────────────

async function forgetHandler(
  args: string[],
  ctx: SlashCommandContext,
): Promise<CommandResponse> {
  const contactId = args[0];
  if (!contactId) {
    return { body: 'Usage: /forget <contact_id>\nExample: /forget alice' };
  }

  // Check if memories table exists (E8 may not be installed yet)
  const tableExists = ctx.db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
    .get() as { name: string } | undefined;

  if (!tableExists) {
    return { body: 'Memory system not yet available. (Pending E8 implementation.)' };
  }

  const now = new Date().toISOString();
  const result = ctx.db
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
 * Build all 7 built-in command definitions, with deps injected via closure.
 * Call bindHelpToRegistry() after registering them all so /help can list everything.
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
      name: 'help',
      description: 'List commands or show usage for a specific command',
      usage: '/help [command]',
      scope: 'bus',
      handler: helpHandler,
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
      handler: replayHandler,
    },
    {
      name: 'forget',
      description: 'Expire all memories for a contact',
      usage: '/forget <contact_id>',
      scope: 'bus',
      handler: forgetHandler,
    },
  ];
}
