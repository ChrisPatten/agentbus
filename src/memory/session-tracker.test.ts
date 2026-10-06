import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { SessionTracker } from './session-tracker.js';
import type { AppConfig } from '../config/schema.js';

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

/** Spy on the on_session_close hook runner (private) without running a shell. */
function spyHook() {
  return vi.spyOn(SessionTracker.prototype as unknown as { runOnSessionCloseHook: (s: { id: string }) => void }, 'runOnSessionCloseHook')
    .mockImplementation(() => {});
}
const hookedIds = (spy: ReturnType<typeof spyHook>) => spy.mock.calls.map((c) => c[0].id);

function insertSession(
  db: Database.Database,
  opts: {
    id?: string;
    channel?: string;
    status?: string;
    lastActivityOffset?: number; // ms in the past
    startedAtOffset?: number; // ms in the past (E30 — hard-ceiling baseline when never journaled)
    endedAt?: string | null;
    summaryAttempts?: number;
    messageCount?: number;
    conversationId?: string;
    claudeSessionId?: string | null;
    lastJournaledAt?: string | null;
  } = {},
) {
  const id = opts.id ?? 'sess-' + Math.random().toString(36).slice(2);
  const lastActivity = new Date(Date.now() - (opts.lastActivityOffset ?? 0)).toISOString();
  const startedAt = new Date(Date.now() - (opts.startedAtOffset ?? 0)).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, message_count, status, summary_attempts, claude_session_id, last_journaled_at)
     VALUES (?, ?, ?, 'contact:chris', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.conversationId ?? 'conv-1',
    opts.channel ?? 'telegram',
    startedAt,
    lastActivity,
    opts.endedAt !== undefined ? opts.endedAt : null,
    opts.messageCount ?? 1,
    opts.status ?? 'active',
    opts.summaryAttempts ?? 0,
    opts.claudeSessionId ?? null,
    opts.lastJournaledAt ?? null,
  );
  return id;
}

describe('SessionTracker.tick()', () => {
  let db: Database.Database;
  let tracker: SessionTracker;
  let hook: ReturnType<typeof spyHook>;

  beforeEach(() => {
    db = makeDb();
    hook = spyHook();
    tracker = new SessionTracker({ db, config: stubConfig });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('closes idle sessions past the threshold', () => {
    // Session idle for 20 minutes (threshold is 15)
    const sessionId = insertSession(db, { lastActivityOffset: 20 * 60 * 1000 });

    tracker.tick();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string | null;
      status: string;
    };
    expect(session.ended_at).not.toBeNull();
    expect(session.status).toBe('closed');
  });

  it('runs the on_session_close hook for idle sessions', () => {
    const sessionId = insertSession(db, { lastActivityOffset: 20 * 60 * 1000 });
    tracker.tick();
    expect(hookedIds(hook)).toEqual([sessionId]);
  });

  it('does NOT close idle headless sessions (claude_session_id set) — they are long-lived', () => {
    // Idle 20 min (past 15-min threshold) but headless-managed → must stay open.
    const sessionId = insertSession(db, {
      lastActivityOffset: 20 * 60 * 1000,
      claudeSessionId: 'cc-xyz',
    });

    tracker.tick();

    const session = db.prepare('SELECT ended_at, status FROM sessions WHERE id = ?').get(sessionId) as {
      ended_at: string | null;
      status: string;
    };
    expect(session.ended_at).toBeNull();
    expect(session.status).toBe('active');
    expect(hookedIds(hook)).not.toContain(sessionId);
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

  it('closes idle sessions below the global min-message threshold but skips the hook', () => {
    const config = {
      ...stubConfig,
      memory: { ...stubConfig.memory, session_close_min_messages: 2 },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config });

    // 0-message session, idle past threshold — closed but not summarized
    const below = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, messageCount: 0 });
    // 2-message session, idle past threshold — closed and summarized
    const meets = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, messageCount: 2 });

    t.tick();

    const b = db.prepare('SELECT ended_at, status FROM sessions WHERE id = ?').get(below) as {
      ended_at: string | null;
      status: string;
    };
    const m = db.prepare('SELECT ended_at, status FROM sessions WHERE id = ?').get(meets) as {
      ended_at: string | null;
      status: string;
    };
    // Both are closed — but only the one meeting the threshold runs the hook
    expect(b.ended_at).not.toBeNull();
    expect(b.status).toBe('closed');
    expect(m.ended_at).not.toBeNull();
    expect(m.status).toBe('closed');
    expect(hookedIds(hook)).toEqual([meets]);
  });

  it('applies per-channel min-message threshold: closes all idle, runs the hook only for those that qualify', () => {
    const config = {
      ...stubConfig,
      memory: {
        ...stubConfig.memory,
        session_close_min_messages: { telegram: 3, 'claude-code': 0 },
      },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config });

    // telegram with 1 message — below channel threshold of 3, closed but not summarized
    const tgBelow = insertSession(db, {
      channel: 'telegram',
      lastActivityOffset: 20 * 60 * 1000,
      messageCount: 1,
    });
    // claude-code with 1 message — channel threshold is 0, closed and summarized
    const ccMeets = insertSession(db, {
      channel: 'claude-code',
      lastActivityOffset: 20 * 60 * 1000,
      messageCount: 1,
    });

    t.tick();

    const tg = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(tgBelow) as {
      ended_at: string | null;
    };
    const cc = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(ccMeets) as {
      ended_at: string | null;
    };
    expect(tg.ended_at).not.toBeNull();
    expect(cc.ended_at).not.toBeNull();
    expect(hookedIds(hook)).toEqual([ccMeets]);
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

  it('marks mid-flight closed sessions closed and runs the hook once', () => {
    const sessionId = insertSession(db, { endedAt: new Date().toISOString() });
    tracker.tick();
    tracker.tick();
    expect((db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string }).status).toBe('closed');
    expect(hookedIds(hook)).toEqual([sessionId]);
  });

  it('leaves legacy summarize_failed sessions alone (no summarizer since E66)', () => {
    const sessionId = insertSession(db, { status: 'summarize_failed', summaryAttempts: 1, endedAt: new Date(Date.now() - 3_600_000).toISOString(), lastActivityOffset: 3_600_000 });
    tracker.tick();
    expect((db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string }).status).toBe('summarize_failed');
  });

});

describe('SessionTracker close notifications (E66)', () => {
  it('reports idle-closed and mid-flight-closed sessions to onSessionClosed', () => {
    const db = makeDb();
    const closed: string[] = [];
    const tracker = new SessionTracker({ db, config: stubConfig, onSessionClosed: (s) => closed.push(s.id) });
    const idle = insertSession(db, { id: 'idle', conversationId: 'c-idle', lastActivityOffset: 2 * 900_000 });
    const midFlight = insertSession(db, { id: 'mid', conversationId: 'c-mid', endedAt: new Date().toISOString() });
    insertSession(db, { id: 'headless', conversationId: 'c-h', lastActivityOffset: 2 * 900_000, claudeSessionId: 'claude-1' });
    tracker.tick();
    expect(closed.sort()).toEqual([idle, midFlight].sort());
    tracker.tick();
    expect(closed).toHaveLength(2); // each close reported once
  });

  it('a throwing onSessionClosed does not break the tick', () => {
    const db = makeDb();
    const hook = spyHook();
    const tracker = new SessionTracker({ db, config: stubConfig, onSessionClosed: () => { throw new Error('boom'); } });
    insertSession(db, { id: 'idle', lastActivityOffset: 2 * 900_000 });
    expect(() => tracker.tick()).not.toThrow();
    expect(hookedIds(hook)).toEqual(['idle']);
    vi.restoreAllMocks();
  });
});

describe('SessionTracker start/stop', () => {
  it('starts and stops without errors', () => {
    const db = makeDb();
    const tracker = new SessionTracker({ db, config: stubConfig });
    tracker.start();
    tracker.stop();
    // No interval leak — just verifying it doesn't throw
  });
});
