import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { Summarizer } from './summarizer.js';
import type { AppConfig } from '../config/schema.js';

// ── Anthropic SDK mock ────────────────────────────────────────────────────────

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockCreate };
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    session_idle_threshold_ms: 900000,
    context_window_hours: 48,
    claude_api_model: 'claude-sonnet-4-6',
    summary_max_tokens: 512,
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

/** Insert a session row and return its ID */
function insertSession(db: Database.Database, id = 'sess-1') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, message_count, status, summary_attempts)
     VALUES (?, 'conv-1', 'telegram', 'contact:chris', ?, ?, ?, 2, 'summarize_pending', 0)`,
  ).run(id, now, now, now);
  return id;
}

/** Insert transcript rows for a session */
function insertTranscripts(db: Database.Database, sessionId: string, count = 3) {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, 'conv-1', ?, ?, 'telegram', 'contact:chris', 'inbound', ?, '{}')`,
    ).run(
      `tr-${i}`,
      `msg-${i}`,
      sessionId,
      new Date(Date.now() + i * 1000).toISOString(),
      `Message number ${i + 1}`,
    );
  }
}

function makeValidApiResponse(memories: unknown[] = []) {
  const summary = JSON.stringify({
    summary: 'Test conversation summary',
    key_topics: ['topic1'],
    decisions: [],
    open_questions: [],
    participants: ['contact:chris'],
    memories,
  });
  return {
    content: [{ type: 'text', text: summary }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Summarizer.summarize()', () => {
  let db: Database.Database;
  let summarizer: Summarizer;
  const originalEnv = process.env['ANTHROPIC_API_KEY'];

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    db = makeDb();
    mockCreate.mockReset();
    summarizer = new Summarizer({ db, config: stubConfig });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = originalEnv;
    }
  });

  it('returns false and logs warning when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const s = new Summarizer({ db, config: stubConfig });
    const result = await s.summarize('any-id');
    expect(result).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('marks session as summarized when no transcripts exist', async () => {
    const sessionId = insertSession(db);
    const result = await summarizer.summarize(sessionId);
    expect(result).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
      status: string;
    };
    expect(session.status).toBe('summarized');
  });

  it('returns false when session does not exist', async () => {
    const result = await summarizer.summarize('nonexistent');
    expect(result).toBe(false);
  });

  it('happy path: writes session_summary and memories', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId, 3);
    mockCreate.mockResolvedValueOnce(
      makeValidApiResponse([
        { contact_id: 'contact:chris', category: 'preference', content: 'Likes tea', confidence: 0.9 },
      ]),
    );

    const result = await summarizer.summarize(sessionId);
    expect(result).toBe(true);

    const summary = db
      .prepare('SELECT * FROM session_summaries WHERE session_id = ?')
      .get(sessionId) as { summary: string; model: string; token_count: number } | undefined;
    expect(summary).toBeTruthy();
    expect(summary!.model).toBe('claude-sonnet-4-6');
    expect(summary!.token_count).toBe(150);

    const memories = db
      .prepare('SELECT * FROM memories WHERE contact_id = ?')
      .all('contact:chris') as { content: string }[];
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toBe('Likes tea');

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
      status: string;
    };
    expect(session.status).toBe('summarized');
  });

  it('marks session as summarize_failed when JSON parsing fails', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId);
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'This is not JSON at all' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await summarizer.summarize(sessionId);
    expect(result).toBe(false);

    const session = db.prepare('SELECT status, summary_attempts FROM sessions WHERE id = ?').get(
      sessionId,
    ) as { status: string; summary_attempts: number };
    expect(session.status).toBe('summarize_failed');
    expect(session.summary_attempts).toBe(1);
  });

  it('handles JSON response wrapped in markdown code fences', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId);
    const jsonBody = JSON.stringify({
      summary: 'Fence test',
      key_topics: [],
      decisions: [],
      open_questions: [],
      participants: [],
      memories: [],
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: `\`\`\`json\n${jsonBody}\n\`\`\`` }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await summarizer.summarize(sessionId);
    expect(result).toBe(true);
    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
      status: string;
    };
    expect(session.status).toBe('summarized');
  });

  it('supersedes the old memory when inserting a new one for the same (contact_id, category)', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId);

    // Insert an existing active memory
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
       VALUES ('old-mem', 'contact:chris', 'preference', 'Old preference', 0.7, 'summarizer', ?, NULL, NULL)`,
    ).run(now);

    mockCreate.mockResolvedValueOnce(
      makeValidApiResponse([
        { contact_id: 'contact:chris', category: 'preference', content: 'New preference', confidence: 0.95 },
      ]),
    );

    await summarizer.summarize(sessionId);

    const oldMem = db
      .prepare('SELECT superseded_by FROM memories WHERE id = ?')
      .get('old-mem') as { superseded_by: string | null };
    expect(oldMem.superseded_by).not.toBeNull();

    const newMem = db
      .prepare("SELECT * FROM memories WHERE content = 'New preference'")
      .get() as { superseded_by: string | null } | undefined;
    expect(newMem).toBeTruthy();
    expect(newMem!.superseded_by).toBeNull();
  });

  it('marks session as failed after all retries exhausted (API throws)', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId);
    mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await summarizer.summarize(sessionId);
    expect(result).toBe(false);
    // 3 attempts
    expect(mockCreate).toHaveBeenCalledTimes(3);

    const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
      status: string;
    };
    expect(session.status).toBe('summarize_failed');
  });
});

describe('Summarizer.retrySummarize()', () => {
  let db: Database.Database;
  let summarizer: Summarizer;

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    db = makeDb();
    mockCreate.mockReset();
    summarizer = new Summarizer({ db, config: stubConfig });
  });

  it('cleans up partial summary and retries', async () => {
    const sessionId = insertSession(db);
    insertTranscripts(db, sessionId);

    // Simulate a partial write from a previous attempt
    db.prepare(
      `INSERT INTO session_summaries (id, session_id, created_at, channel, contact_id, started_at, ended_at, summary, model, token_count)
       VALUES ('partial-sum', ?, ?, 'telegram', 'contact:chris', ?, ?, '{"partial":true}', 'old-model', 0)`,
    ).run(sessionId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    mockCreate.mockResolvedValueOnce(makeValidApiResponse([]));

    await summarizer.retrySummarize(sessionId);

    // Old partial summary should be gone
    const summaries = db
      .prepare('SELECT * FROM session_summaries WHERE session_id = ?')
      .all(sessionId) as { id: string }[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.id).not.toBe('partial-sum');
  });
});
