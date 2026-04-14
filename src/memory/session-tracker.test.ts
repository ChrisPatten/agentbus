import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { SessionTracker } from './session-tracker.js';
import type { AppConfig } from '../config/schema.js';
import type { Summarizer } from './summarizer.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const stubConfig: AppConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {
    summarizer_interval_ms: 60000,
    session_idle_threshold_ms: 900000, // 15 min
    context_window_hours: 48,
    claude_api_model: 'claude-sonnet-4-6',
    summary_max_tokens: 8192,
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

function makeMockSummarizer(): Summarizer {
  return {
    summarize: vi.fn().mockResolvedValue(true),
    retrySummarize: vi.fn().mockResolvedValue(true),
  } as unknown as Summarizer;
}

function insertSession(
  db: Database.Database,
  opts: {
    id?: string;
    status?: string;
    lastActivityOffset?: number; // ms in the past
    endedAt?: string | null;
    summaryAttempts?: number;
  } = {},
) {
  const id = opts.id ?? 'sess-' + Math.random().toString(36).slice(2);
  const lastActivity = new Date(Date.now() - (opts.lastActivityOffset ?? 0)).toISOString();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, message_count, status, summary_attempts)
     VALUES (?, 'conv-1', 'telegram', 'contact:chris', ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    now,
    lastActivity,
    opts.endedAt !== undefined ? opts.endedAt : null,
    opts.status ?? 'active',
    opts.summaryAttempts ?? 0,
  );
  return id;
}

describe('SessionTracker.tick()', () => {
  let db: Database.Database;
  let summarizer: Summarizer;
  let tracker: SessionTracker;

  beforeEach(() => {
    db = makeDb();
    summarizer = makeMockSummarizer();
    tracker = new SessionTracker({ db, config: stubConfig, summarizer });
  });

  it('closes idle sessions past the threshold', () => {
    // Session idle for 20 minutes (threshold is 15)
    const sessionId = insertSession(db, { lastActivityOffset: 20 * 60 * 1000 });

    tracker.tick();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string | null;
      status: string;
    };
    expect(session.ended_at).not.toBeNull();
    expect(session.status).toBe('summarize_pending');
  });

  it('calls summarizer for idle sessions', async () => {
    const sessionId = insertSession(db, { lastActivityOffset: 20 * 60 * 1000 });

    tracker.tick();
    // Allow fire-and-forget to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(summarizer.summarize).toHaveBeenCalledWith(sessionId);
  });

  it('does NOT close sessions within the idle threshold', () => {
    // Session idle for only 5 minutes (threshold is 15)
    const sessionId = insertSession(db, { lastActivityOffset: 5 * 60 * 1000 });

    tracker.tick();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string | null;
    };
    expect(session.ended_at).toBeNull();
  });

  it('does NOT close sessions that already have ended_at', () => {
    // Already-ended session — should not be touched
    const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sessionId = insertSession(db, {
      lastActivityOffset: 20 * 60 * 1000,
      status: 'summarized',
      endedAt,
    });

    tracker.tick();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string;
      status: string;
    };
    // ended_at should be unchanged (the original, not a new value)
    expect(session.ended_at).toBe(endedAt);
    expect(session.status).toBe('summarized');
  });

  it('retries failed sessions below max attempts', async () => {
    const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sessionId = insertSession(db, {
      status: 'summarize_failed',
      summaryAttempts: 1,
      endedAt,
      lastActivityOffset: 60 * 60 * 1000,
    });

    tracker.tick();
    await new Promise((r) => setTimeout(r, 10));

    // Status should be reset to pending before summarize is called
    expect(summarizer.summarize).toHaveBeenCalledWith(sessionId);
  });

  it('does NOT retry sessions that hit max attempts (3)', () => {
    const endedAt = new Date().toISOString();
    insertSession(db, {
      status: 'summarize_failed',
      summaryAttempts: 3,
      endedAt,
      lastActivityOffset: 60 * 60 * 1000,
    });

    tracker.tick();

    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it('hard-deletes memories expired more than 30 days ago', () => {
    const expiredLong = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const expiredRecent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    // These should be deleted (expired > 30 days ago)
    db.prepare(
      `INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
       VALUES ('mem-old', 'contact:chris', 'general', 'Old fact', 0.8, 'summarizer', ?, ?, NULL)`,
    ).run(expiredLong, expiredLong);

    // These should be kept (expired only recently)
    db.prepare(
      `INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
       VALUES ('mem-recent', 'contact:chris', 'general', 'Recent fact', 0.8, 'summarizer', ?, ?, NULL)`,
    ).run(expiredRecent, expiredRecent);

    // Active memory — should never be deleted
    db.prepare(
      `INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
       VALUES ('mem-active', 'contact:chris', 'general', 'Active fact', 0.9, 'summarizer', ?, NULL, NULL)`,
    ).run(new Date().toISOString());

    tracker.tick();

    const remaining = db.prepare('SELECT id FROM memories').all() as { id: string }[];
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain('mem-old');
    expect(ids).toContain('mem-recent');
    expect(ids).toContain('mem-active');
  });
});

describe('SessionTracker start/stop', () => {
  it('starts and stops without errors', () => {
    const db = makeDb();
    const summarizer = makeMockSummarizer();
    const tracker = new SessionTracker({ db, config: stubConfig, summarizer });
    tracker.start();
    tracker.stop();
    // No interval leak — just verifying it doesn't throw
  });
});
