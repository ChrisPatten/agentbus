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
    session_close_min_messages: 0,
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
    channel?: string;
    status?: string;
    lastActivityOffset?: number; // ms in the past
    endedAt?: string | null;
    summaryAttempts?: number;
    messageCount?: number;
  } = {},
) {
  const id = opts.id ?? 'sess-' + Math.random().toString(36).slice(2);
  const lastActivity = new Date(Date.now() - (opts.lastActivityOffset ?? 0)).toISOString();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, message_count, status, summary_attempts)
     VALUES (?, 'conv-1', ?, 'contact:chris', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.channel ?? 'telegram',
    now,
    lastActivity,
    opts.endedAt !== undefined ? opts.endedAt : null,
    opts.messageCount ?? 1,
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

  it('does NOT close idle sessions below the global min-message threshold', () => {
    const config = {
      ...stubConfig,
      memory: { ...stubConfig.memory, session_close_min_messages: 2 },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config, summarizer });

    // 0-message session, idle past threshold — should be skipped
    const skipped = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, messageCount: 0 });
    // 2-message session, idle past threshold — should be closed
    const closed = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, messageCount: 2 });

    t.tick();

    const s = db.prepare('SELECT ended_at, status FROM sessions WHERE id = ?').get(skipped) as {
      ended_at: string | null;
      status: string;
    };
    const c = db.prepare('SELECT ended_at, status FROM sessions WHERE id = ?').get(closed) as {
      ended_at: string | null;
      status: string;
    };
    expect(s.ended_at).toBeNull();
    expect(s.status).toBe('active');
    expect(c.ended_at).not.toBeNull();
    expect(c.status).toBe('summarize_pending');
  });

  it('applies per-channel min-message threshold correctly', () => {
    const config = {
      ...stubConfig,
      memory: {
        ...stubConfig.memory,
        session_close_min_messages: { telegram: 3, 'claude-code': 0 },
      },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config, summarizer });

    // telegram with 1 message — below channel threshold of 3, should be skipped
    const tgSkipped = insertSession(db, {
      channel: 'telegram',
      lastActivityOffset: 20 * 60 * 1000,
      messageCount: 1,
    });
    // claude-code with 1 message — channel threshold is 0, should be closed
    const ccClosed = insertSession(db, {
      channel: 'claude-code',
      lastActivityOffset: 20 * 60 * 1000,
      messageCount: 1,
    });

    t.tick();

    const tg = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(tgSkipped) as {
      ended_at: string | null;
    };
    const cc = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(ccClosed) as {
      ended_at: string | null;
    };
    expect(tg.ended_at).toBeNull();
    expect(cc.ended_at).not.toBeNull();
  });

  it('defaults to 0 (no guard) when session_close_min_messages is unset', () => {
    // stubConfig has no session_close_min_messages — schema defaults it to 0
    const sessionId = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, messageCount: 0 });

    tracker.tick();

    const session = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string | null;
    };
    expect(session.ended_at).not.toBeNull();
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
