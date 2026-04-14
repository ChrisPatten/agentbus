import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createBuiltinCommands, bindHelpToRegistry } from './handlers.js';
import { CommandRegistry } from './registry.js';
import type { SlashCommandContext } from './registry.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

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
    db,
    config: stubConfig,
    ...overrides,
  };
}

function makeAdapterRegistry(adapters: Array<{ id: string; status?: string }> = []) {
  const map = new Map(
    adapters.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.id,
        capabilities: { send: true as const, channels: ['telegram'] },
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

describe('command handlers', () => {
  describe('/status', () => {
    it('returns adapter status and queue counts', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram', status: 'healthy' }]);
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue({ pending: 3 }) as never,
        pauseSet,
      });
      const status = commands.find((c) => c.name === 'status')!;
      const db = makeDb();
      const result = await status.handler([], makeCtx(db));
      expect(result.body).toContain('telegram');
      expect(result.body).toContain('healthy');
      expect(result.body).toContain('pending:    3');
    });

    it('shows [PAUSED] for paused adapters', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram' }]);
      const pauseSet = new Set(['telegram']);
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const status = commands.find((c) => c.name === 'status')!;
      const result = await status.handler([], makeCtx(makeDb()));
      expect(result.body).toContain('[PAUSED]');
    });
  });

  describe('/help', () => {
    let registry: CommandRegistry;
    beforeEach(() => {
      registry = new CommandRegistry();
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      for (const cmd of commands) registry.register(cmd);
      bindHelpToRegistry(
        () => registry.list(),
        (name) => registry.lookup(name),
      );
    });

    it('lists all bus-scope commands without args', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler([], makeCtx(makeDb()));
      expect(result.body).toContain('/status');
      expect(result.body).toContain('/help');
      expect(result.body).toContain('/pause');
    });

    it('shows usage for a specific command', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler(['pause'], makeCtx(makeDb()));
      expect(result.body).toContain('/pause <adapterId>');
    });

    it('returns error for unknown command', async () => {
      const help = registry.lookup('help')!;
      const result = await help.handler(['nonexistent'], makeCtx(makeDb()));
      expect(result.body).toContain('Unknown command: nonexistent');
    });
  });

  describe('/pause', () => {
    it('adds adapter to pauseSet', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram' }]);
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['telegram'], makeCtx(makeDb()));
      expect(pauseSet.has('telegram')).toBe(true);
      expect(result.body).toContain('paused');
    });

    it('returns error for unknown adapter', async () => {
      const registry = makeAdapterRegistry([]);
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['nonexistent'], makeCtx(makeDb()));
      expect(result.body).toContain('Unknown adapter');
    });

    it('returns message when already paused', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram' }]);
      const pauseSet = new Set(['telegram']);
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler(['telegram'], makeCtx(makeDb()));
      expect(result.body).toContain('already paused');
    });

    it('returns usage when no arg given', async () => {
      const registry = makeAdapterRegistry([]);
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const pause = commands.find((c) => c.name === 'pause')!;
      const result = await pause.handler([], makeCtx(makeDb()));
      expect(result.body).toContain('Usage:');
    });
  });

  describe('/resume', () => {
    it('removes adapter from pauseSet', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram' }]);
      const pauseSet = new Set(['telegram']);
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler(['telegram'], makeCtx(makeDb()));
      expect(pauseSet.has('telegram')).toBe(false);
      expect(result.body).toContain('resumed');
    });

    it('returns message when not paused', async () => {
      const registry = makeAdapterRegistry([{ id: 'telegram' }]);
      const pauseSet = new Set<string>();
      const commands = createBuiltinCommands({
        adapterRegistry: registry as never,
        queue: makeQueue() as never,
        pauseSet,
      });
      const resume = commands.find((c) => c.name === 'resume')!;
      const result = await resume.handler(['telegram'], makeCtx(makeDb()));
      expect(result.body).toContain('not paused');
    });
  });

  describe('/sessions', () => {
    it('returns "no sessions" when empty', async () => {
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler([], makeCtx(makeDb()));
      expect(result.body).toBe('No sessions found.');
    });

    it('lists sessions from database', async () => {
      const db = makeDb();
      const sessionId = 'session-aabbccdd-0000-0000-0000-000000000000';
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, 'conv-1', 'telegram', 'chris', new Date().toISOString(), new Date().toISOString(), 5);

      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
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

      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const sessions = commands.find((c) => c.name === 'sessions')!;
      const result = await sessions.handler(['imessage'], makeCtx(db));
      expect(result.body).toContain('imessage');
      expect(result.body).not.toContain('telegram');
    });
  });

  describe('/replay', () => {
    it('returns usage when no session_id given', async () => {
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler([], makeCtx(makeDb()));
      expect(result.body).toContain('Usage:');
    });

    it('returns error for unknown session', async () => {
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler(['nonexistent-id'], makeCtx(makeDb()));
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

      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
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

      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const replay = commands.find((c) => c.name === 'replay')!;
      const result = await replay.handler(['aaaabbbb'], makeCtx(db));
      expect(result.body).toContain('aaaabbbb');
    });
  });

  describe('/forget', () => {
    it('returns graceful message when memories table does not exist', async () => {
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler(['chris'], makeCtx(makeDb()));
      expect(result.body).toContain('Memory system not yet available');
    });

    it('returns usage when no contact_id given', async () => {
      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler([], makeCtx(makeDb()));
      expect(result.body).toContain('Usage:');
    });

    it('expires memories when table exists', async () => {
      const db = makeDb();
      // Create a minimal memories table to simulate E8
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          content TEXT NOT NULL,
          superseded_by TEXT,
          expires_at TEXT
        )
      `);
      db.prepare(`INSERT INTO memories (id, contact_id, content) VALUES (?, ?, ?)`).run('m1', 'chris', 'likes coffee');
      db.prepare(`INSERT INTO memories (id, contact_id, content) VALUES (?, ?, ?)`).run('m2', 'chris', 'works remotely');

      const commands = createBuiltinCommands({
        adapterRegistry: makeAdapterRegistry() as never,
        queue: makeQueue() as never,
        pauseSet: new Set(),
      });
      const forget = commands.find((c) => c.name === 'forget')!;
      const result = await forget.handler(['chris'], makeCtx(db));
      expect(result.body).toContain('2 memory records');
    });
  });
});
