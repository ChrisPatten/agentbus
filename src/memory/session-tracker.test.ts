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
    expect(summarizer.summarize).not.toHaveBeenCalledWith(sessionId);
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

  it('closes idle sessions below the global min-message threshold but skips hook+summarize', () => {
    const config = {
      ...stubConfig,
      memory: { ...stubConfig.memory, session_close_min_messages: 2 },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config, summarizer });

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
    // Both are closed — but only the one meeting the threshold triggers summarization
    expect(b.ended_at).not.toBeNull();
    expect(b.status).toBe('summarize_pending');
    expect(m.ended_at).not.toBeNull();
    expect(m.status).toBe('summarize_pending');
    // Summarizer called only for the session meeting the threshold
    expect(vi.mocked(summarizer.summarize)).toHaveBeenCalledWith(meets);
    expect(vi.mocked(summarizer.summarize)).not.toHaveBeenCalledWith(below);
  });

  it('applies per-channel min-message threshold: closes all idle, summarizes only those that qualify', () => {
    const config = {
      ...stubConfig,
      memory: {
        ...stubConfig.memory,
        session_close_min_messages: { telegram: 3, 'claude-code': 0 },
      },
    } as unknown as AppConfig;
    const t = new SessionTracker({ db, config, summarizer });

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
    expect(vi.mocked(summarizer.summarize)).toHaveBeenCalledWith(ccMeets);
    expect(vi.mocked(summarizer.summarize)).not.toHaveBeenCalledWith(tgBelow);
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

describe('SessionTracker.dispatchJournaling() (E20)', () => {
  let db: Database.Database;
  let summarizer: Summarizer;
  let runner: ReturnType<typeof vi.fn>;

  function journalingConfig(
    threshold_ms: number | Record<string, number>,
    enabled = true,
    ceiling_ms?: number,
  ): AppConfig {
    return {
      ...stubConfig,
      adapters: {
        'cc-headless': {
          agent_id: 'claude',
          poll_interval_ms: 1000,
          system_prompt: 'x',
          claude_bin: 'claude',
          error_reply: 'err',
          memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
          journaling: { enabled, threshold_ms, ceiling_ms, prompt: 'journal please' },
        },
      },
    } as unknown as AppConfig;
  }

  function makeTracker(config: AppConfig): SessionTracker {
    const t = new SessionTracker({ db, config, summarizer });
    t.registerJournalingRunner('agent:claude', runner as unknown as (c: string) => Promise<{ skipped?: boolean }>);
    return t;
  }

  const flush = () => new Promise((r) => setTimeout(r, 15));

  beforeEach(() => {
    db = makeDb();
    summarizer = makeMockSummarizer();
    runner = vi.fn().mockResolvedValue({});
  });

  it('dispatches once for an idle, never-journaled headless session and stamps last_journaled_at', async () => {
    const id = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('conv-1');
    const row = db.prepare('SELECT last_journaled_at, ended_at FROM sessions WHERE id = ?').get(id) as {
      last_journaled_at: string | null;
      ended_at: string | null;
    };
    expect(row.last_journaled_at).not.toBeNull();
    expect(row.ended_at).toBeNull(); // never closed
  });

  it('does not re-dispatch on the next tick after journaling (idle but already journaled)', async () => {
    insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();
    tracker.tick();
    await flush();

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('re-arms when activity occurred after the last journaling', async () => {
    // last_journaled_at older than last_activity → new activity since journaling.
    insertSession(db, {
      lastActivityOffset: 20 * 60 * 1000,
      claudeSessionId: 'cc-1',
      lastJournaledAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when journaled more recently than last activity', async () => {
    insertSession(db, {
      lastActivityOffset: 20 * 60 * 1000,
      claudeSessionId: 'cc-1',
      lastJournaledAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();

    expect(runner).not.toHaveBeenCalled();
  });

  it('never dispatches when journaling is disabled', async () => {
    insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
    const tracker = makeTracker(journalingConfig(900000, false));

    tracker.tick();
    await flush();

    expect(runner).not.toHaveBeenCalled();
  });

  it('ignores sessions without a claude_session_id', async () => {
    insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: null });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();

    expect(runner).not.toHaveBeenCalled();
  });

  it('honors the per-channel threshold', async () => {
    insertSession(db, {
      id: 'tg',
      channel: 'telegram',
      conversationId: 'conv-tg',
      lastActivityOffset: 20 * 60 * 1000,
      claudeSessionId: 'cc-tg',
    });
    insertSession(db, {
      id: 'em',
      channel: 'email',
      conversationId: 'conv-em',
      lastActivityOffset: 20 * 60 * 1000,
      claudeSessionId: 'cc-em',
    });
    const tracker = makeTracker(
      journalingConfig({ telegram: 900000, email: 86_400_000, default: 900000 }),
    );

    tracker.tick();
    await flush();

    // telegram idle 20 min > 15-min threshold → dispatched; email under 24 h → not.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith('conv-tg');
  });

  it('stamps last_journaled_at when the runner skips (nothing to journal)', async () => {
    const id = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
    runner.mockResolvedValue({ skipped: true });
    const tracker = makeTracker(journalingConfig(900000));

    tracker.tick();
    await flush();

    const row = db.prepare('SELECT last_journaled_at FROM sessions WHERE id = ?').get(id) as {
      last_journaled_at: string | null;
    };
    expect(row.last_journaled_at).not.toBeNull();
  });

  it('leaves last_journaled_at unchanged on failure and retries up to the attempt cap', async () => {
    const id = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
    runner.mockRejectedValue(new Error('spawn failed'));
    const tracker = makeTracker(journalingConfig(900000));

    // 3 ticks → 3 attempts (the cap); a 4th tick backs off.
    for (let i = 0; i < 4; i++) {
      tracker.tick();
      await flush();
    }

    expect(runner).toHaveBeenCalledTimes(3);
    const row = db.prepare('SELECT last_journaled_at FROM sessions WHERE id = ?').get(id) as {
      last_journaled_at: string | null;
    };
    expect(row.last_journaled_at).toBeNull();
  });

  describe('hard ceiling (E30)', () => {
    it('dispatches a never-idle session once the ceiling elapses since session start', async () => {
      // lastActivityOffset: 0 → not idle at all (well under the 15-min threshold),
      // but started 40 min ago and never journaled → ceiling (30 min) trips.
      const id = insertSession(db, {
        lastActivityOffset: 0,
        startedAtOffset: 40 * 60 * 1000,
        claudeSessionId: 'cc-1',
      });
      const tracker = makeTracker(journalingConfig(900000, true, 30 * 60 * 1000));

      tracker.tick();
      await flush();

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith('conv-1');
      const row = db.prepare('SELECT last_journaled_at FROM sessions WHERE id = ?').get(id) as {
        last_journaled_at: string | null;
      };
      expect(row.last_journaled_at).not.toBeNull();
    });

    it('does not dispatch a never-idle session before the ceiling elapses', async () => {
      insertSession(db, {
        lastActivityOffset: 0,
        startedAtOffset: 10 * 60 * 1000, // 10 min < 30-min ceiling
        claudeSessionId: 'cc-1',
      });
      const tracker = makeTracker(journalingConfig(900000, true, 30 * 60 * 1000));

      tracker.tick();
      await flush();

      expect(runner).not.toHaveBeenCalled();
    });

    it('measures the ceiling from last_journaled_at, not session start, once journaled once', async () => {
      // Journaled 10 min ago (within the 30-min ceiling), started 2h ago.
      // Without using last_journaled_at as the baseline this would re-fire
      // immediately off the old session-start timestamp.
      insertSession(db, {
        lastActivityOffset: 0,
        startedAtOffset: 2 * 60 * 60 * 1000,
        lastJournaledAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        claudeSessionId: 'cc-1',
      });
      const tracker = makeTracker(journalingConfig(900000, true, 30 * 60 * 1000));

      tracker.tick();
      await flush();

      expect(runner).not.toHaveBeenCalled();
    });

    it('the idle debounce and hard ceiling are independent — either can trigger', async () => {
      // Idle past the 15-min threshold, well under the 30-min ceiling — the
      // debounce leg alone should still fire.
      insertSession(db, {
        lastActivityOffset: 20 * 60 * 1000,
        startedAtOffset: 20 * 60 * 1000,
        claudeSessionId: 'cc-1',
      });
      const tracker = makeTracker(journalingConfig(900000, true, 30 * 60 * 1000));

      tracker.tick();
      await flush();

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('leaves ceiling behavior off (idle-only) when ceiling_ms is unset', async () => {
      // Never idle, started long ago — with no ceiling configured this must
      // never dispatch, matching pre-E30 behavior.
      insertSession(db, {
        lastActivityOffset: 0,
        startedAtOffset: 6 * 60 * 60 * 1000,
        claudeSessionId: 'cc-1',
      });
      const tracker = makeTracker(journalingConfig(900000)); // ceiling_ms omitted

      tracker.tick();
      await flush();

      expect(runner).not.toHaveBeenCalled();
    });
  });

  describe('overlap suppression (E30)', () => {
    it('does not dispatch a second journaling turn while one is already in flight for the same conversation', async () => {
      insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
      let resolveRunner: (v: { skipped?: boolean }) => void;
      runner.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunner = resolve;
          }),
      );
      const tracker = makeTracker(journalingConfig(900000));

      tracker.tick(); // dispatches, runner() pending
      await flush();
      tracker.tick(); // would re-select the same candidate — must be suppressed
      await flush();

      expect(runner).toHaveBeenCalledTimes(1);

      // Once the in-flight turn resolves and stamps last_journaled_at, the
      // session is no longer a candidate at all (journaled since last activity).
      resolveRunner!({});
      await flush();
      tracker.tick();
      await flush();

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('re-allows dispatch for a conversation once its in-flight turn settles and new activity re-arms it', async () => {
      const id = insertSession(db, { lastActivityOffset: 20 * 60 * 1000, claudeSessionId: 'cc-1' });
      let resolveRunner: (v: { skipped?: boolean }) => void;
      runner.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunner = resolve;
          }),
      );
      const tracker = makeTracker(journalingConfig(900000));

      tracker.tick();
      await flush();
      expect(runner).toHaveBeenCalledTimes(1);

      resolveRunner!({});
      await flush();

      // Simulate new activity after the first journaling turn (last_activity
      // advances past last_journaled_at), followed by enough idle time to
      // re-trip the debounce — mirrors the plain "re-arms" test above, since
      // real wall-clock time can't actually elapse 15+ minutes here.
      db.prepare('UPDATE sessions SET last_journaled_at = ?, last_activity = ? WHERE id = ?').run(
        new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        id,
      );
      runner.mockResolvedValue({});
      tracker.tick();
      await flush();

      expect(runner).toHaveBeenCalledTimes(2);
    });
  });

  describe('multi-instance routing (E23)', () => {
    function multiInstanceConfig(): AppConfig {
      return {
        ...stubConfig,
        adapters: {
          'cc-headless': {
            peggy: {
              agent_id: 'peggy',
              poll_interval_ms: 1000,
              system_prompt: 'x',
              claude_bin: 'claude',
              error_reply: 'err',
              memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
              journaling: { enabled: true, threshold_ms: 900000, prompt: 'journal please' },
            },
            pokeclaude: {
              agent_id: 'pokeclaude',
              poll_interval_ms: 1000,
              system_prompt: 'x',
              claude_bin: 'claude',
              error_reply: 'err',
              memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
              journaling: { enabled: true, threshold_ms: 900000, prompt: 'journal please' },
            },
          },
        },
      } as unknown as AppConfig;
    }

    it('dispatches a session to its own agent runner, not the other agent\'s', async () => {
      const peggyRunner = vi.fn().mockResolvedValue({});
      const pokeclaudeRunner = vi.fn().mockResolvedValue({});
      insertSession(db, {
        id: 'sess-poke',
        conversationId: 'conv-poke',
        lastActivityOffset: 20 * 60 * 1000,
        claudeSessionId: 'cc-poke',
      });
      db.prepare(`UPDATE sessions SET agent_id = 'agent:pokeclaude' WHERE id = 'sess-poke'`).run();

      const tracker = new SessionTracker({ db, config: multiInstanceConfig(), summarizer });
      tracker.registerJournalingRunner('agent:peggy', peggyRunner);
      tracker.registerJournalingRunner('agent:pokeclaude', pokeclaudeRunner);

      tracker.tick();
      await flush();

      expect(pokeclaudeRunner).toHaveBeenCalledWith('conv-poke');
      expect(peggyRunner).not.toHaveBeenCalled();
    });

    it('skips a session whose agent_id has no matching configured instance', async () => {
      const peggyRunner = vi.fn().mockResolvedValue({});
      const pokeclaudeRunner = vi.fn().mockResolvedValue({});
      insertSession(db, {
        id: 'sess-orphan',
        conversationId: 'conv-orphan',
        lastActivityOffset: 20 * 60 * 1000,
        claudeSessionId: 'cc-orphan',
      });
      db.prepare(`UPDATE sessions SET agent_id = 'agent:retired' WHERE id = 'sess-orphan'`).run();

      const tracker = new SessionTracker({ db, config: multiInstanceConfig(), summarizer });
      tracker.registerJournalingRunner('agent:peggy', peggyRunner);
      tracker.registerJournalingRunner('agent:pokeclaude', pokeclaudeRunner);

      expect(() => tracker.tick()).not.toThrow();
      await flush();

      expect(peggyRunner).not.toHaveBeenCalled();
      expect(pokeclaudeRunner).not.toHaveBeenCalled();
    });

    it('skips a session with no agent_id when multiple instances are configured (no safe attribution)', async () => {
      const peggyRunner = vi.fn().mockResolvedValue({});
      const pokeclaudeRunner = vi.fn().mockResolvedValue({});
      insertSession(db, {
        id: 'sess-null',
        conversationId: 'conv-null',
        lastActivityOffset: 20 * 60 * 1000,
        claudeSessionId: 'cc-null',
      });

      const tracker = new SessionTracker({ db, config: multiInstanceConfig(), summarizer });
      tracker.registerJournalingRunner('agent:peggy', peggyRunner);
      tracker.registerJournalingRunner('agent:pokeclaude', pokeclaudeRunner);

      tracker.tick();
      await flush();

      expect(peggyRunner).not.toHaveBeenCalled();
      expect(pokeclaudeRunner).not.toHaveBeenCalled();
    });
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
