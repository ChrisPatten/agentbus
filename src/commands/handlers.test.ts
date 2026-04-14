import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createBuiltinCommands, createHelpHandler, paginateLines, playbackStates } from './handlers.js';
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
  afterEach(() => {
    playbackStates.clear();
  });

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

  describe('/replay', () => {
    it('returns usage when no session_id given', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler([], makeCtx(deps.db));
      expect(result.body).toContain('Usage:');
    });

    it('returns error for unknown session', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler(['nonexistent-id'], makeCtx(deps.db));
      expect(result.body).toContain('Session not found');
    });

    it('replays transcript for a valid session', async () => {
      const db = makeDb();
      const sessionId = 'aaaabbbb-0000-0000-0000-000000000000';
      const convId = 'conv-1';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, convId, 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 2);
      db.prepare(
        `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('t1', 'm1', convId, sessionId, new Date().toISOString(), 'telegram', 'chris', 'inbound', 'Hello there', '{}');

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler([sessionId], makeCtx(db));
      expect(result.body).toContain('Hello there');
      expect(result.body).toContain('>');
    });

    it('supports short ID prefix matching', async () => {
      const db = makeDb();
      const sessionId = 'aaaabbbb-0000-0000-0000-000000000000';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, 'conv-1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 0);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler(['aaaabbbb'], makeCtx(db));
      expect(result.body).toContain('aaaabbbb');
    });

    it('paginates long transcripts and includes footer', async () => {
      const db = makeDb();
      const sessionId = 'aaaabbbb-0000-0000-0000-000000000000';
      const convId = 'conv-1';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, convId, 'telegram', 'chris', '2026-04-14T10:00:00.000Z', '2026-04-14T10:30:00.000Z', 50);

      // Insert many transcript entries that exceed a small limit
      for (let i = 0; i < 50; i++) {
        db.prepare(
          `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(`t${i}`, `m${i}`, convId, sessionId, `2026-04-14T10:${String(i).padStart(2, '0')}:00.000Z`, 'telegram', 'chris', 'inbound', `Message number ${i} with some extra text`, '{}');
      }

      // Use a small maxMessageLength adapter
      const deps = makeDeps({ db, adapters: [{ id: 'telegram', maxMessageLength: 300 }] });
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler([sessionId], makeCtx(db));

      expect(result.body).toContain('/next');
      expect(result.body).toContain('/cancel');
      expect(playbackStates.has('contact:chris')).toBe(true);
    });

    it('returns single page without footer for small transcripts', async () => {
      const db = makeDb();
      const sessionId = 'bbbbcccc-0000-0000-0000-000000000000';
      const convId = 'conv-2';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, convId, 'telegram', 'chris', '2026-04-14T10:00:00.000Z', '2026-04-14T10:00:00.000Z', 1);
      db.prepare(
        `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('t1', 'm1', convId, sessionId, '2026-04-14T10:00:00.000Z', 'telegram', 'chris', 'inbound', 'Short msg', '{}');

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler([sessionId], makeCtx(db));

      expect(result.body).not.toContain('/next');
      expect(playbackStates.has('contact:chris')).toBe(false);
    });
  });

  describe('/next', () => {
    it('returns error when no active playback', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const next = commands.find((c) => c.name === 'next')!;
      const result = await next.handler([], makeCtx(deps.db));
      expect(result.body).toContain('No active playback');
    });

    it('advances to next page with footer', async () => {
      playbackStates.set('contact:chris', {
        pages: ['page1', 'page2', 'page3'],
        currentPage: 0,
      });

      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const next = commands.find((c) => c.name === 'next')!;
      const result = await next.handler([], makeCtx(deps.db));
      expect(result.body).toContain('page2');
      expect(result.body).toContain('/next');
    });

    it('returns last page without footer and clears state', async () => {
      playbackStates.set('contact:chris', {
        pages: ['page1', 'page2'],
        currentPage: 0,
      });

      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const next = commands.find((c) => c.name === 'next')!;
      const result = await next.handler([], makeCtx(deps.db));
      expect(result.body).toBe('page2');
      expect(result.body).not.toContain('/next');
      expect(playbackStates.has('contact:chris')).toBe(false);
    });
  });

  describe('/cancel', () => {
    it('returns error when no active playback', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const cancel = commands.find((c) => c.name === 'cancel')!;
      const result = await cancel.handler([], makeCtx(deps.db));
      expect(result.body).toContain('No active playback to cancel');
    });

    it('clears playback state', async () => {
      playbackStates.set('contact:chris', {
        pages: ['page1', 'page2'],
        currentPage: 0,
      });

      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const cancel = commands.find((c) => c.name === 'cancel')!;
      const result = await cancel.handler([], makeCtx(deps.db));
      expect(result.body).toBe('Playback cancelled.');
      expect(playbackStates.has('contact:chris')).toBe(false);
    });
  });

  describe('/forget', () => {
    it('returns "no memories found" when there are no active memories for the contact', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler(['chris'], makeCtx(deps.db));
      expect(result.body).toContain('No active memories found for contact');
    });

    it('returns usage when no contact_id given', async () => {
      const deps = makeDeps();
      const commands = createBuiltinCommands(deps);
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler([], makeCtx(deps.db));
      expect(result.body).toContain('Usage:');
    });

    it('expires memories when table exists', async () => {
      const db = makeDb();
      // memories table is created by migration 003
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at) VALUES (?, ?, 'general', ?, 0.9, 'manual', ?)`).run('m1', 'chris', 'likes coffee', now);
      db.prepare(`INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at) VALUES (?, ?, 'general', ?, 0.9, 'manual', ?)`).run('m2', 'chris', 'works remotely', now);

      const deps = makeDeps({ db });
      const commands = createBuiltinCommands(deps);
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler(['chris'], makeCtx(db));
      expect(result.body).toContain('2 memory records');
    });
  });

  describe('paginateLines', () => {
    it('returns single page when content fits', () => {
      const pages = paginateLines(['line1', 'line2', 'line3'], 100);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toBe('line1\nline2\nline3');
    });

    it('splits into multiple pages when content exceeds limit', () => {
      // Generate lines that together exceed 200 chars
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: some content here`);
      const pages = paginateLines(lines, 200);
      expect(pages.length).toBeGreaterThan(1);
    });

    it('splits a single long line into chunks', () => {
      const longLine = 'a'.repeat(500);
      const pages = paginateLines([longLine], 200);
      expect(pages.length).toBeGreaterThan(1);
      // Each page should fit within the effective limit
      // (effectiveMax = 200 - footer length)
      for (const page of pages) {
        expect(page.length).toBeLessThanOrEqual(200);
      }
    });

    it('handles empty input', () => {
      const pages = paginateLines([], 100);
      expect(pages).toEqual([]);
    });
  });
});
