/**
 * Built-in bus command handlers.
 *
 * Each handler is a CommandHandler: (args, context) => Promise<CommandResponse>.
 * Custom/plugin commands call CommandRegistry.register() directly.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CommandDefinition, CommandHandler, CommandResponse, SlashCommandContext } from './registry.js';
import type { CommandRegistry } from './registry.js';
import type { AdapterRegistry } from '../core/registry.js';
import type { MessageQueue } from '../core/queue.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import type { HeadlessCapacitySnapshot } from '../adapters/cc-headless.js';
import type { RuntimeResolver } from '../core/runtime-resolver.js';
import { formatCapabilities } from '../core/runtime-capabilities.js';
import type { AdvisoryService } from '../advisories/service.js';
import type { JournalEngine } from '../journaling/engine.js';

/**
 * Mutable holder for the headless adapter's control hooks. Populated by
 * index.ts after startHeadless(); an empty map means the headless adapter is
 * not running (e.g. an MCP-only deployment), so commands degrade gracefully.
 */
export interface HeadlessControl {
  /**
   * Kill the in-flight `claude -p` turn for a contact, keyed by the owning
   * cc-headless agent_id (e.g. "agent:peggy"). Used by `/stop`. Returns true
   * if a turn was found and killed.
   */
  stopTurn: Map<string, (conversationId: string) => boolean>;
  snapshots?: Map<string, () => HeadlessCapacitySnapshot>;
}

export interface HandlerDeps {
  adapterRegistry: AdapterRegistry;
  queue: MessageQueue;
  pauseSet: Set<string>;
  /** Raw DB handle for built-in commands that need write access */
  db: Database.Database;
  /** Late-bound headless adapter hooks (see HeadlessControl). */
  headlessControl?: HeadlessControl;
  /**
   * One PoolManager per configured `cc-pool` instance (E48), keyed by the
   * pool's prefixed logical agent id (e.g. "agent:peggy"). Populated upfront
   * by index.ts, unlike `headlessControl` — absent/empty when no `cc-pool`
   * adapters are configured.
   */
  poolManagers?: Map<string, import('../pool/pool-manager.js').PoolManager>;
  /** E64 — agent runtime lookup for the /status Runtimes section. Omitted → section omitted. */
  runtimeResolver?: Pick<RuntimeResolver, 'list'>;
  /** E65 — active advisories for the /status Advisories section. Omitted or none → section omitted. */
  advisories?: Pick<AdvisoryService, 'listActive'>;
  /** E66 — the journaling engine; /clear fires its `clear` trigger. Omitted → /clear closes without journaling. */
  journal?: Pick<JournalEngine, 'trigger'>;
}

/** "3m", "2h", "4d" since `iso`. */
function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export function commandConversationId(ctx: SlashCommandContext, db: Database.Database, contactId: string): string {
  const boundId = ctx.channel === 'app' ? ctx.envelope.metadata?.['bound_session_id'] : undefined;
  if (typeof boundId === 'string') {
    const row = db.prepare(`SELECT conversation_id FROM sessions
      WHERE id = ? AND contact_id = ? AND ended_at IS NULL`).get(boundId, contactId) as {conversation_id:string}|undefined;
    if (row) return row.conversation_id;
  }
  return computeConversationId(contactId, ctx.channel, ctx.envelope.topic);
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

  // Pool: section (E48 S48.8) — one line per configured cc-pool instance,
  // e.g. "  pool peggy: 3/4 leased, 1 parked". Entirely omitted (no header,
  // no blank line) when poolManagers is absent/empty, so bus deployments
  // without cc-pool configured see byte-for-byte the same /status output as
  // before this feature existed.
  const poolLines: string[] = [];
  if (deps.poolManagers && deps.poolManagers.size > 0) {
    for (const manager of deps.poolManagers.values()) {
      const panes = manager.leaseStore.list(manager.poolId);
      const leased = panes.filter((p) => p.state === 'leased').length;
      const parked = manager.parkedStatus().count;
      const parkedClause = parked > 0 ? `, ${parked} parked` : '';
      poolLines.push(`  pool ${manager.poolId}: ${leased}/${panes.length} leased${parkedClause}`);
    }
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
    ...(poolLines.length > 0 ? ['', 'Pool:', ...poolLines] : []),
    ...(() => {
      const runtimes = deps.runtimeResolver?.list() ?? [];
      return runtimes.length > 0 ? ['', 'Runtimes:', ...runtimes.map((r) =>
        `  ${r.agentId}: ${r.kind} (${formatCapabilities(r.capabilities)})`)] : [];
    })(),
    ...(() => {
      const active = deps.advisories?.listActive() ?? [];
      return active.length > 0 ? ['', 'Advisories:', ...active.map((a) =>
        `  ${a.agent_id} [${a.severity}] ${a.title} (${a.state}, raised ${ago(a.raised_at)} ago) id:${a.id.slice(0, 8)}`)] : [];
    })(),
    ...(() => {
      const snapshots = [...(deps.headlessControl?.snapshots?.values() ?? [])].map((read) => read());
      return snapshots.length > 0 ? ['', 'Headless:', ...snapshots.map((s) =>
        `  ${s.agent_id}: ${s.running_user} user, ${s.running_system} system, ${s.waiting} waiting, limit ${s.limit} (${s.reserved_system_slots} reserved)`)] : [];
    })(),
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

// ── /schedule ─────────────────────────────────────────────────────────────────

async function scheduleHandler(
  args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'list') {
    // List active schedules for this channel
    const tableExists = deps.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_items'`)
      .get() as { name: string } | undefined;

    if (!tableExists) {
      return { body: 'Scheduling system not yet initialized.' };
    }

    const rows = deps.db
      .prepare(
        `SELECT id, type, label, fire_at, cron_expr, timezone, fire_count, max_fires, status, model
         FROM scheduled_items
         WHERE channel = ? AND status = 'active'
         ORDER BY fire_at ASC LIMIT 20`,
      )
      .all(ctx.channel) as Array<{
      id: string;
      type: string;
      label: string | null;
      fire_at: string;
      cron_expr: string | null;
      timezone: string;
      fire_count: number;
      max_fires: number | null;
      status: string;
      model: string | null;
    }>;

    if (rows.length === 0) {
      return { body: `No active schedules for channel: ${ctx.channel}` };
    }

    const lines = [`Active schedules for ${ctx.channel} (${rows.length}):\n`];
    for (const row of rows) {
      const shortId = row.id.slice(0, 8);
      const name = row.label ?? (row.type === 'cron' ? row.cron_expr! : 'one-shot');
      const nextFire = row.fire_at.slice(0, 16).replace('T', ' ');
      const tz = row.timezone && row.timezone !== 'UTC' ? ` (${row.timezone})` : ' UTC';
      const fires =
        row.max_fires !== null ? `${row.fire_count}/${row.max_fires}` : `${row.fire_count} fired`;
      const model = row.model ? `  [${row.model}]` : '';
      lines.push(`  ${shortId}  ${name}  next: ${nextFire}${tz}  (${fires})${model}`);
    }
    lines.push('\nUse /schedule cancel <id> to cancel a schedule.');
    return { body: lines.join('\n') };
  }

  if (sub === 'cancel') {
    const scheduleId = args[1];
    if (!scheduleId) {
      return { body: 'Usage: /schedule cancel <id>\nGet IDs with /schedule list.' };
    }

    const tableExists = deps.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_items'`)
      .get() as { name: string } | undefined;

    if (!tableExists) {
      return { body: 'Scheduling system not yet initialized.' };
    }

    // Scoped to this channel — prefix match (first 8 chars of UUID)
    const existing = deps.db
      .prepare(
        `SELECT id, label, status, created_by FROM scheduled_items
         WHERE (id = ? OR id LIKE ?) AND channel = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(scheduleId, scheduleId + '%', ctx.channel) as
      | { id: string; label: string | null; status: string; created_by: string }
      | undefined;

    if (!existing) {
      return { body: `Schedule not found in channel "${ctx.channel}": ${scheduleId}` };
    }

    if (existing.status === 'cancelled' || existing.status === 'completed') {
      return { body: `Schedule ${existing.id.slice(0, 8)} is already ${existing.status}.` };
    }

    deps.db
      .prepare(`UPDATE scheduled_items SET status = 'cancelled' WHERE id = ?`)
      .run(existing.id);

    const name = existing.label ? ` (${existing.label})` : '';
    const configNote =
      existing.created_by === 'config'
        ? '\nNote: this is a config-managed schedule. It will remain cancelled across restarts until its id is removed from config.yaml or changed.'
        : '';
    return { body: `Schedule ${existing.id.slice(0, 8)}${name} cancelled.${configNote}` };
  }

  return {
    body: 'Usage:\n  /schedule list            — list active schedules for this channel\n  /schedule cancel <id>    — cancel a schedule by ID',
  };
}

// ── /clear ────────────────────────────────────────────────────────────────────

/**
 * Start a fresh session for the sender on this channel. Closes the current
 * active session immediately (so the next message starts with no
 * `--resume`), then fires the journaling engine's `clear` trigger (E66) for
 * the closed session. The trigger is persisted, bypasses
 * `min_human_messages`, and runs the agent's journaler chain in the
 * background; the closed session's Claude transcript stays resumable on disk.
 * On cc-pool the conversation's pane is detached and cleared (or killed,
 * per `on_evict`), so the next message starts a fresh Claude session.
 */
async function clearHandler(
  _args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const contactId = ctx.sender.startsWith('contact:')
    ? ctx.sender.slice('contact:'.length)
    : ctx.sender;
  const conversationId = commandConversationId(ctx, deps.db, contactId);

  const session = deps.db
    .prepare(
      `SELECT id, claude_session_id, agent_id, channel FROM sessions
       WHERE conversation_id = ? AND ended_at IS NULL
         AND claude_session_id IS NOT NULL
       ORDER BY last_activity DESC LIMIT 1`,
    )
    .get(conversationId) as
    | { id: string; claude_session_id: string; agent_id: string | null; channel: string }
    | undefined;

  if (!session) {
    return { body: 'No active session to clear — your next message already starts fresh.' };
  }

  // Close immediately so the next inbound message starts a brand-new session.
  deps.db
    .prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), session.id);

  const journal = deps.journal?.trigger({ reason: 'clear', sessionId: session.id });

  // E66 S66.9 — on cc-pool the leased pane still holds the old Claude
  // context. Detach it now (the next message gets a fresh pane and session)
  // and clear or free it in the background. Journalers read the closed
  // session's transcript on disk, which /clear does not remove.
  for (const pool of deps.poolManagers?.values() ?? []) {
    const cleared = pool.clearConversation(conversationId);
    if (cleared) {
      void cleared.done.catch((err: unknown) => console.error(`[commands] /clear: releasing ${cleared.paneId} failed:`, err));
      break;
    }
  }

  if (journal && (journal.status === 'queued' || journal.status === 'merged')) {
    return {
      body: 'Context cleared — your next message starts a fresh session. Journaling the previous session in the background.',
    };
  }

  return {
    body: 'Context cleared — your next message starts a fresh session. (Journaling is not set up for this agent; closed without a memory pass.)',
  };
}

// ── /stop ─────────────────────────────────────────────────────────────────────

/**
 * Cancel the sender's in-flight `claude -p` turn on this channel. Resolves
 * the owning cc-headless instance the same way /clear does (by the active
 * session's agent_id, falling back to the sole registered instance when the
 * session predates agent_id tracking), then kills that instance's child
 * process for this contact. When the source adapter is Telegram, the
 * in-flight tool-call status draft (if any) is finalized in place with a
 * "Stopped by user" note rather than left to be silently overwritten or
 * abandoned — see TelegramAdapter.finalizeDraft (E29).
 */
async function stopHandler(
  _args: string[],
  ctx: SlashCommandContext,
  deps: HandlerDeps,
): Promise<CommandResponse> {
  const contactId = ctx.sender.startsWith('contact:') ? ctx.sender.slice('contact:'.length) : ctx.sender;
  const conversationId = commandConversationId(ctx, deps.db, contactId);

  const session = deps.db
    .prepare(
      `SELECT agent_id FROM sessions
       WHERE conversation_id = ? AND ended_at IS NULL
       ORDER BY last_activity DESC LIMIT 1`,
    )
    .get(conversationId) as { agent_id: string | null } | undefined;

  const runners = deps.headlessControl?.stopTurn;
  const stop = session?.agent_id
    ? runners?.get(session.agent_id)
    : runners?.size === 1
      ? [...runners.values()][0]
      : undefined;

  const stopped = stop ? stop(conversationId) : false;

  if (!stopped) {
    return { body: 'No active turn to stop.' };
  }

  const adapter = deps.adapterRegistry.lookup(ctx.adapterId);
  const finalized =
    typeof adapter?.finalizeDraft === 'function' &&
    adapter.finalizeDraft(ctx.sender, 'Stopped by user', ctx.channel, ctx.envelope.topic);

  // When the draft was finalized, "Stopped by user" already reached the user
  // as part of the conversation — a separate confirmation would be duplicative.
  if (finalized) {
    return {};
  }

  return { body: 'Stopped the current turn.' };
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
      name: 'schedule',
      description: 'List or cancel scheduled messages for this channel',
      usage: '/schedule [list | cancel <id>]',
      scope: 'bus',
      handler: (args, ctx) => scheduleHandler(args, ctx, deps),
    },
    {
      name: 'clear',
      description: 'Start a fresh session; journal the previous one in the background',
      usage: '/clear',
      scope: 'bus',
      handler: (args, ctx) => clearHandler(args, ctx, deps),
    },
    {
      name: 'stop',
      description: 'Cancel the current in-flight turn',
      usage: '/stop',
      scope: 'bus',
      handler: (args, ctx) => stopHandler(args, ctx, deps),
    },
  ];
}
