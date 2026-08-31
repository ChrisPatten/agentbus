import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createBuiltinCommands, createHelpHandler } from './handlers.js';
import { CommandRegistry } from './registry.js';
import type { SlashCommandContext } from './registry.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { createSafeDatabase } from '../db/safe-database.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {
    summarizer_interval_ms: 60000,
    session_idle_threshold_ms: 1800000,
    context_window_hours: 48,
    claude_api_model: 'claude-opus-4-6',
  },
  pipeline: {
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: [],
    vip_contacts: [],
    routes: [],
  },
} as unknown as AppConfig;

function makeEnvelope(): MessageEnvelope {
  return {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: '/status' },
    metadata: {},
  };
}

function makeCtx(db: Database.Database, overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    channel: 'telegram',
    sender: 'contact:chris',
    adapterId: 'telegram',
    argsRaw: '',
    envelope: makeEnvelope(),
    db: createSafeDatabase(db),
    config: stubConfig,
    ...overrides,
  };
}

function makeAdapterRegistry(adapters: Array<{ id: string; status?: string; maxMessageLength?: number }> = []) {
  const map = new Map(
    adapters.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.id,
        capabilities: {
          send: true as const,
          channels: ['telegram'],
          ...(a.maxMessageLength != null ? { maxMessageLength: a.maxMessageLength } : {}),
        },
        health: vi.fn().mockResolvedValue({ status: a.status ?? 'healthy' }),
        start: vi.fn(),
        stop: vi.fn(),
        send: vi.fn(),
      },
    ]),
  );
  return {
    list: () => Array.from(map.values()),
    lookup: (id: string) => map.get(id),
  };
}

function makeQueue(counts: Record<string, number> = {}) {
  return {
    counts: () => ({ pending: 0, processing: 0, delivered: 0, dead_letter: 0, ...counts }),
  };
}

function makeDeps(overrides: { db?: Database.Database; adapters?: Array<{ id: string; status?: string; maxMessageLength?: number }>; pauseSet?: Set<string>; counts?: Record<string, number> } = {}) {
  const db = overrides.db ?? makeDb();
  return {
    adapterRegistry: makeAdapterRegistry(overrides.adapters ?? []) as never,
    queue: makeQueue(overrides.counts) as never,
    pauseSet: overrides.pauseSet ?? new Set<string>(),
    db,
  };
}

describe('command handlers', () => {
  describe('/status', () => {
    it('returns adapter status and queue counts', async () => {
      const deps = makeDeps({ adapters: [{ id: 'telegram', status: 'healthy' }], counts: { pending: 3 } });
      const commands = createBuiltinCommands(deps);
      const status = commands.find((c) => c.name === 'status')!;
      const result = await status.handler([], makeCtx(deps.db));
      expect(result.body).toContain('telegram');
      expect(result.body).toContain('healthy');
      expect(result.body).toContain('pending:    3');
    });

    it('shows [PAUSED] for paused adapters', async () => {
      const deps = makeDeps({ adapters: [{ id: 'telegram' }], pauseSet: new Set(['telegram']) });
      const commands = createBuiltinCommands(deps);
      const status = commands.find((c) => c.name === 'status')!;
      const result = await status.handler([], makeCtx(deps.db));
      expect(result.body).toContain('[PAUSED]');
    });
  });

  describe('/help', () => {
    let registry: CommandRegistry;
    let db: Database.Database;
    beforeEach(() => {
      db = makeDb();
      registry = new CommandRegistry();
      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      for (const cmd of commands) registry.register(cmd);
      registry.register({
        name: 'help',
        description: 'List commands or show usage for a specific command',
        usage: '/help [command]',
        scope: 'bus',
        handler: createHelpHandler(registry),
      });
    });

    it('lists all bus-scope commands without args', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler([], makeCtx(db));
      expect(result.body).toContain('/status');
      expect(result.body).toContain('/help');
      expect(result.body).toContain('/pause');
    });

    it('shows usage for a specific command', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler(['pause'], makeCtx(db));
      expect(result.body).toContain('/pause <adapterId>');
    });

    it('returns error for unknown command', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler(['nonexistent'], makeCtx(db));
      expect(result.body).toContain('Unknown command: nonexistent');
    });

    it('includes plugin commands registered after createHelpHandler()', async () => {
      registry.register({
        name: 'ping',
        description: 'Responds with pong',
        usage: '/ping',
        scope: 'bus',
        handler: async () => ({ body: 'pong' }),
      });
      const help = registry.lookup('help')!;
      const result = await help.handler([], makeCtx(db));
      expect(result.body).toContain('/ping');
    });
  });

  describe('/pause', () => {
    it('adds adapter to pauseSet and persists to DB', async () => {
      const db = makeDb();
      const pauseSet = new Set<string>();
      const deps = makeDeps({ db, adapters: [{ id: 'telegram' }], pauseSet });
      const commands = createBuiltinCommands(deps);
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['telegram'], makeCtx(db));
      expect(pauseSet.has('telegram')).toBe(true);
      expect(result.body).toContain('paused');

      // Verify persisted to DB
      const row = db.prepare('SELECT adapter_id, paused_by FROM paused_adapters WHERE adapter_id = ?').get('telegram') as { adapter_id: string; paused_by: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.paused_by).toBe('contact:chris');
    });

    it('returns error for unknown adapter', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['nonexistent'], makeCtx(deps.db));
      expect(result.body).toContain('Unknown adapter');
    });

    it('returns message when already paused', async () => {
      const deps = makeDeps({ adapters: [{ id: 'telegram' }], pauseSet: new Set(['telegram']) });
      const commands = createBuiltinCommands(deps);
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['telegram'], makeCtx(deps.db));
      expect(result.body).toContain('already paused');
    });

    it('returns usage when no arg given', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler([], makeCtx(deps.db));
      expect(result.body).toContain('Usage:');
    });
  });

  describe('/resume', () => {
    it('removes adapter from pauseSet and deletes from DB', async () => {
      const db = makeDb();
      const pauseSet = new Set(['telegram']);
      db.prepare('INSERT INTO paused_adapters (adapter_id, paused_at, paused_by) VALUES (?, ?, ?)').run('telegram', new Date().toISOString(), 'contact:chris');

      const deps = makeDeps({ db, adapters: [{ id: 'telegram' }], pauseSet });
      const commands = createBuiltinCommands(deps);
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler(['telegram'], makeCtx(db));
      expect(pauseSet.has('telegram')).toBe(false);
      expect(result.body).toContain('resumed');

      // Verify deleted from DB
      const row = db.prepare('SELECT adapter_id FROM paused_adapters WHERE adapter_id = ?').get('telegram');
      expect(row).toBeUndefined();
    });

    it('returns message when not paused', async () => {
      const deps = makeDeps({ adapters: [{ id: 'telegram' }] });
      const commands = createBuiltinCommands(deps);
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler(['telegram'], makeCtx(deps.db));
      expect(result.body).toContain('not paused');
    });

    it('returns error for unknown adapter', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler(['nonexistent'], makeCtx(deps.db));
      expect(result.body).toContain('Unknown adapter');
    });

    it('returns usage when no arg given', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler([], makeCtx(deps.db));
      expect(result.body).toContain('Usage:');
    });
  });

  describe('/sessions', () => {
    it('returns "no sessions" when empty', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler([], makeCtx(deps.db));
      expect(result.body).toBe('No sessions found.');
    });

    it('lists sessions from database', async () => {
      const db = makeDb();
      const sessionId = 'session-aabbccdd-0000-0000-0000-000000000000';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, 'conv-1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 5);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler([], makeCtx(db));
      expect(result.body).toContain('telegram');
      expect(result.body).toContain('chris');
      expect(result.body).toContain('5 msgs');
    });

    it('filters by channel when provided', async () => {
      const db = makeDb();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'c1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 1);
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('s2', 'c2', 'imessage', 'peggy', new Date().toISOString(), new Date().toISOString(), 2);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler(['imessage'], makeCtx(db));
      expect(result.body).toContain('imessage');
      expect(result.body).not.toContain('telegram');
    });

    it('respects --limit flag', async () => {
      const db = makeDb();
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(`s${i}`, `c${i}`, 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), i);
      }

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler(['--limit', '2'], makeCtx(db));
      expect(result.body).toContain('2 shown');
    });

    it('clamps --limit to 50', async () => {
      const db = makeDb();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'c1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 1);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      // Should not crash with limit > 50 — just clamp
      const result = await sessions.handler(['--limit', '999'], makeCtx(db));
      expect(result.body).toContain('1 shown');
    });

    it('ignores invalid --limit value', async () => {
      const db = makeDb();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'c1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 1);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const sessions = commands.find((c) => c.name === 'sessions')!;
      // "abc" is not a number — should use default limit 10
      const result = await sessions.handler(['--limit', 'abc'], makeCtx(db));
      expect(result.body).toContain('1 shown');
    });
  });

  // ── /schedule ────────────────────────────────────────────────────────────

  describe('/schedule', () => {
    function insertSchedule(
      db: Database.Database,
      opts: {
        id?: string;
        channel?: string;
        type?: 'once' | 'cron';
        cron_expr?: string;
        timezone?: string;
        fire_at?: string;
        label?: string | null;
        fire_count?: number;
        max_fires?: number | null;
        status?: string;
        created_by?: string;
      } = {},
    ): string {
      const id = opts.id ?? `sched-${Math.random().toString(36).slice(2)}`;
      const fireAt = opts.fire_at ?? new Date(Date.now() + 3_600_000).toISOString();
      db.prepare(
        `INSERT INTO scheduled_items
           (id, type, cron_expr, timezone, fire_at, channel, sender, payload_body,
            topic, priority, label, created_at, created_by, fire_count, max_fires, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
      ).run(
        id,
        opts.type ?? 'once',
        opts.cron_expr ?? null,
        opts.timezone ?? 'UTC',
        fireAt,
        opts.channel ?? 'telegram',
        'contact:chris',
        'Hello',
        'general',
        'normal',
        opts.label ?? null,
        opts.created_by ?? 'http',
        opts.fire_count ?? 0,
        opts.max_fires ?? null,
        opts.status ?? 'active',
      );
      return id;
    }

    it('lists active schedules for the current channel', async () => {
      const db = makeDb();
      insertSchedule(db, { channel: 'telegram', label: 'Daily briefing', cron_expr: '0 8 * * *', type: 'cron' });
      insertSchedule(db, { channel: 'other', label: 'Other channel' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['list'], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('Daily briefing');
      expect(result.body).not.toContain('Other channel');
    });

    it('shows UTC for schedules without a custom timezone', async () => {
      const db = makeDb();
      insertSchedule(db, { channel: 'telegram', timezone: 'UTC' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['list'], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('UTC');
    });

    it('shows IANA timezone name for non-UTC schedules', async () => {
      const db = makeDb();
      insertSchedule(db, { channel: 'telegram', timezone: 'America/New_York', type: 'cron', cron_expr: '0 8 * * *' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['list'], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('America/New_York');
    });

    it('shows "No active schedules" when there are none', async () => {
      const db = makeDb();
      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['list'], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('No active schedules');
    });

    it('defaults to list when no subcommand is provided', async () => {
      const db = makeDb();
      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler([], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('No active schedules');
    });

    it('cancels a schedule by id', async () => {
      const db = makeDb();
      const id = insertSchedule(db, { channel: 'telegram' });
      const shortId = id.slice(0, 8);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['cancel', shortId], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('cancelled');
      const row = db.prepare(`SELECT status FROM scheduled_items WHERE id = ?`).get(id) as { status: string };
      expect(row.status).toBe('cancelled');
    });

    it('cancel returns not-found for a schedule in a different channel', async () => {
      const db = makeDb();
      const id = insertSchedule(db, { channel: 'other' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['cancel', id.slice(0, 8)], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('not found');
    });

    it('cancel on an already-cancelled schedule is idempotent', async () => {
      const db = makeDb();
      const id = insertSchedule(db, { channel: 'telegram', status: 'cancelled' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['cancel', id.slice(0, 8)], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('already cancelled');
    });

    it('cancel of a config-managed schedule includes a note', async () => {
      const db = makeDb();
      const id = insertSchedule(db, { channel: 'telegram', created_by: 'config', label: 'My config schedule' });

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['cancel', id.slice(0, 8)], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('config-managed');
      expect(result.body).toContain('config.yaml');
    });

    it('returns usage when an unknown subcommand is given', async () => {
      const db = makeDb();
      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const schedule = commands.find((c) => c.name === 'schedule')!;
      const result = await schedule.handler(['unknown'], makeCtx(db, { channel: 'telegram' }));

      expect(result.body).toContain('Usage');
    });
  });

  describe('/clear', () => {
    function insertSession(
      db: Database.Database,
      opts: {
        id: string;
        channel?: string;
        claudeSessionId?: string | null;
        endedAt?: string | null;
        agentId?: string | null;
      },
    ) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, claude_session_id, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        opts.id,
        `conv-${opts.id}`,
        opts.channel ?? 'telegram',
        'chris',
        now,
        now,
        opts.endedAt ?? null,
        opts.claudeSessionId === undefined ? 'claude-abc' : opts.claudeSessionId,
        opts.agentId ?? null,
      );
    }

    it('closes the active session and journals it in the background', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-1' });
      const journalResumeId = vi.fn();
      const deps = { ...makeDeps({ db }), headlessControl: { journalResumeId: new Map([['agent:peggy', journalResumeId]]) } };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('fresh session');
      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = 'sess-1'`).get() as {
        ended_at: string | null;
      };
      expect(row.ended_at).not.toBeNull();
      expect(journalResumeId).toHaveBeenCalledWith({
        claudeSessionId: 'claude-abc',
        contactId: 'chris',
        channel: 'telegram',
      });
    });

    it('reports nothing to clear when there is no active session', async () => {
      const db = makeDb();
      const journalResumeId = vi.fn();
      const deps = { ...makeDeps({ db }), headlessControl: { journalResumeId: new Map([['agent:peggy', journalResumeId]]) } };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('No active session');
      expect(journalResumeId).not.toHaveBeenCalled();
    });

    it('does not touch a session on a different channel', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-sys', channel: 'system:peggy' });
      const journalResumeId = vi.fn();
      const deps = { ...makeDeps({ db }), headlessControl: { journalResumeId: new Map([['agent:peggy', journalResumeId]]) } };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      // makeCtx defaults to channel 'telegram'
      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('No active session');
      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = 'sess-sys'`).get() as {
        ended_at: string | null;
      };
      expect(row.ended_at).toBeNull();
      expect(journalResumeId).not.toHaveBeenCalled();
    });

    it('ignores a session with no claude_session_id (never spoke)', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-nul', claudeSessionId: null });
      const deps = { ...makeDeps({ db }), headlessControl: { journalResumeId: new Map([['agent:peggy', vi.fn()]]) } };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('No active session');
    });

    it('routes to the owning agent when multiple headless instances are registered (E23)', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-poke', claudeSessionId: 'claude-poke', agentId: 'agent:pokeclaude' });
      const peggyJournal = vi.fn();
      const pokeclaudeJournal = vi.fn();
      const deps = {
        ...makeDeps({ db }),
        headlessControl: {
          journalResumeId: new Map([
            ['agent:peggy', peggyJournal],
            ['agent:pokeclaude', pokeclaudeJournal],
          ]),
        },
      };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      await clear.handler([], makeCtx(db));

      expect(pokeclaudeJournal).toHaveBeenCalledWith({
        claudeSessionId: 'claude-poke',
        contactId: 'chris',
        channel: 'telegram',
      });
      expect(peggyJournal).not.toHaveBeenCalled();
    });

    it('skips journaling for an orphaned agent_id with multiple instances registered', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-orphan', agentId: 'agent:retired' });
      const peggyJournal = vi.fn();
      const pokeclaudeJournal = vi.fn();
      const deps = {
        ...makeDeps({ db }),
        headlessControl: {
          journalResumeId: new Map([
            ['agent:peggy', peggyJournal],
            ['agent:pokeclaude', pokeclaudeJournal],
          ]),
        },
      };
      const commands = createBuiltinCommands(deps as never);
      const clear = commands.find((c) => c.name === 'clear')!;

      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('fresh session');
      expect(peggyJournal).not.toHaveBeenCalled();
      expect(pokeclaudeJournal).not.toHaveBeenCalled();
    });

    it('still closes the session when the headless adapter is not running', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-2' });
      const deps = makeDeps({ db }); // no headlessControl
      const commands = createBuiltinCommands(deps);
      const clear = commands.find((c) => c.name === 'clear')!;

      const result = await clear.handler([], makeCtx(db));

      expect(result.body).toContain('No headless journaling agent available');
      const row = db.prepare(`SELECT ended_at FROM sessions WHERE id = 'sess-2'`).get() as {
        ended_at: string | null;
      };
      expect(row.ended_at).not.toBeNull();
    });
  });

  describe('/stop', () => {
    function insertSession(
      db: Database.Database,
      opts: { id: string; channel?: string; agentId?: string | null },
    ) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, claude_session_id, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(opts.id, `conv-${opts.id}`, opts.channel ?? 'telegram', 'chris', now, now, opts.agentId ?? null);
    }

    function makeTelegramAdapterWithFinalize(finalizeReturns = true) {
      return {
        id: 'telegram',
        name: 'telegram',
        capabilities: { send: true as const, channels: ['telegram'], toolStatus: true },
        health: vi.fn().mockResolvedValue({ status: 'healthy' }),
        start: vi.fn(),
        stop: vi.fn(),
        send: vi.fn(),
        finalizeDraft: vi.fn().mockReturnValue(finalizeReturns),
      };
    }

    it('stops the in-flight turn, finalizes the Telegram draft, and sends no separate confirmation', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-1', agentId: 'agent:peggy' });
      const telegramAdapter = makeTelegramAdapterWithFinalize(true);
      const stopTurn = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db }),
        adapterRegistry: { lookup: (id: string) => (id === 'telegram' ? telegramAdapter : undefined), list: () => [telegramAdapter] } as never,
        headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', stopTurn]]) },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      // The finalized draft ("Stopped by user") is the user's only feedback —
      // a separate command-response message would be duplicative.
      expect(result.body).toBeUndefined();
      expect(stopTurn).toHaveBeenCalledWith('contact:chris');
      expect(telegramAdapter.finalizeDraft).toHaveBeenCalledWith('contact:chris', 'Stopped by user', 'telegram', 'general');
    });

    it('falls back to a confirmation message when there was no draft to finalize', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-1b', agentId: 'agent:peggy' });
      const telegramAdapter = makeTelegramAdapterWithFinalize(false); // no draft was open
      const stopTurn = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db }),
        adapterRegistry: { lookup: (id: string) => (id === 'telegram' ? telegramAdapter : undefined), list: () => [telegramAdapter] } as never,
        headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', stopTurn]]) },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      expect(result.body).toContain('Stopped');
      expect(telegramAdapter.finalizeDraft).toHaveBeenCalledWith('contact:chris', 'Stopped by user', 'telegram', 'general');
    });

    it('reports nothing to stop when no turn is running', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-2', agentId: 'agent:peggy' });
      const telegramAdapter = makeTelegramAdapterWithFinalize();
      const stopTurn = vi.fn().mockReturnValue(false);
      const deps = {
        ...makeDeps({ db }),
        adapterRegistry: { lookup: (id: string) => (id === 'telegram' ? telegramAdapter : undefined), list: () => [telegramAdapter] } as never,
        headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', stopTurn]]) },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      expect(result.body).toContain('No active turn to stop');
      expect(telegramAdapter.finalizeDraft).not.toHaveBeenCalled();
    });

    it('reports nothing to stop when the headless adapter is not running', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-3', agentId: 'agent:peggy' });
      const deps = makeDeps({ db }); // no headlessControl
      const commands = createBuiltinCommands(deps);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      expect(result.body).toContain('No active turn to stop');
    });

    it('routes to the owning agent when multiple headless instances are registered (E23)', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-poke', agentId: 'agent:pokeclaude' });
      const peggyStop = vi.fn().mockReturnValue(true);
      const pokeclaudeStop = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db }),
        headlessControl: {
          journalResumeId: new Map(),
          stopTurn: new Map([
            ['agent:peggy', peggyStop],
            ['agent:pokeclaude', pokeclaudeStop],
          ]),
        },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      await stop.handler([], makeCtx(db));

      expect(pokeclaudeStop).toHaveBeenCalledWith('contact:chris');
      expect(peggyStop).not.toHaveBeenCalled();
    });

    it('falls back to the sole registered instance when the session predates agent_id tracking', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-legacy', agentId: null });
      const soloStop = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db }),
        headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', soloStop]]) },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      expect(soloStop).toHaveBeenCalledWith('contact:chris');
      expect(result.body).toContain('Stopped');
    });

    it('does not fall back for an orphaned agent_id when multiple instances are registered', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-orphan', agentId: 'agent:retired' });
      const peggyStop = vi.fn().mockReturnValue(true);
      const pokeclaudeStop = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db }),
        headlessControl: {
          journalResumeId: new Map(),
          stopTurn: new Map([
            ['agent:peggy', peggyStop],
            ['agent:pokeclaude', pokeclaudeStop],
          ]),
        },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db));

      expect(result.body).toContain('No active turn to stop');
      expect(peggyStop).not.toHaveBeenCalled();
      expect(pokeclaudeStop).not.toHaveBeenCalled();
    });

    it('stops the turn without error when the originating adapter has no finalizeDraft (non-Telegram)', async () => {
      const db = makeDb();
      insertSession(db, { id: 'sess-email', channel: 'email:peggy', agentId: 'agent:peggy' });
      const stopTurn = vi.fn().mockReturnValue(true);
      const deps = {
        ...makeDeps({ db, adapters: [{ id: 'email:peggy' }] }),
        headlessControl: { journalResumeId: new Map(), stopTurn: new Map([['agent:peggy', stopTurn]]) },
      };
      const commands = createBuiltinCommands(deps as never);
      const stop = commands.find((c) => c.name === 'stop')!;

      const result = await stop.handler([], makeCtx(db, { channel: 'email:peggy', adapterId: 'email:peggy' }));

      expect(result.body).toContain('Stopped');
      expect(stopTurn).toHaveBeenCalledWith('contact:chris');
    });
  });
});
