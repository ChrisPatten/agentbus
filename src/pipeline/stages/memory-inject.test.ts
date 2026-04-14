import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../db/schema.js';
import { createMemoryInject } from './memory-inject.js';
import type { PipelineContext } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import type { MessageEnvelope } from '../../types/envelope.js';

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
    session_idle_threshold_ms: 1800000,
    context_window_hours: 48,
    claude_api_model: 'claude-opus-4-6',
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

function makeCtx(
  db: Database.Database,
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const envelope: MessageEnvelope = {
    id: 'msg-1',
    timestamp: new Date().toISOString(),
    channel: 'claude-code',
    topic: 'general',
    sender: 'contact:alice',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hello' },
    metadata: {},
  };
  return {
    envelope,
    contact: { id: 'alice', displayName: 'Alice', platforms: {} },
    dedupKey: 'key-abc',
    isSlashCommand: false,
    slashCommand: null,
    topics: ['general'],
    priorityScore: 0,
    routes: [],
    conversationId: 'conv-abc',
    sessionId: 'sess-abc',
    sessionCreated: true,
    config: stubConfig,
    db,
    ...overrides,
  };
}

function insertMemory(
  db: Database.Database,
  opts: {
    contactId?: string;
    category?: string;
    content?: string;
    confidence?: number;
    supersededBy?: string | null;
    expiresAt?: string | null;
  } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, session_id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
     VALUES (?, NULL, ?, ?, ?, ?, 'summarizer', ?, ?, ?)`,
  ).run(
    id,
    opts.contactId ?? 'alice',
    opts.category ?? 'fact',
    opts.content ?? 'Alice likes hiking',
    opts.confidence ?? 0.9,
    now,
    opts.expiresAt ?? null,
    opts.supersededBy ?? null,
  );
  return id;
}

function insertSession(db: Database.Database, contactId = 'alice'): string {
  const id = randomUUID();
  const convId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, status)
     VALUES (?, ?, 'claude-code', ?, ?, ?, ?, 'summarized')`,
  ).run(id, convId, contactId, now, now, now);
  return id;
}

function insertSummary(
  db: Database.Database,
  opts: {
    sessionId?: string;
    contactId?: string;
    summaryText?: string;
    createdAt?: string;
    startedAt?: string;
    endedAt?: string;
  } = {},
): void {
  const now = new Date().toISOString();
  const sessionId = opts.sessionId ?? insertSession(db, opts.contactId ?? 'alice');
  const summaryObj = { summary: opts.summaryText ?? 'Discussed project timeline.', key_topics: [], decisions: [], open_questions: [], participants: ['alice'], memories: [] };
  db.prepare(
    `INSERT INTO session_summaries (id, session_id, created_at, channel, contact_id, started_at, ended_at, summary, model, token_count)
     VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?, 'claude-opus-4-6', 100)`,
  ).run(
    randomUUID(),
    sessionId,
    opts.createdAt ?? now,
    opts.contactId ?? 'alice',
    opts.startedAt ?? now,
    opts.endedAt ?? now,
    JSON.stringify(summaryObj),
  );
}

describe('memory-inject stage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns ctx unchanged when sessionCreated is false', async () => {
    insertMemory(db);
    const ctx = makeCtx(db, { sessionCreated: false });
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result).not.toBeNull();
    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('returns ctx unchanged when contact is null', async () => {
    insertMemory(db);
    const ctx = makeCtx(db, { contact: null });
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result).not.toBeNull();
    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('returns ctx unchanged when no memories or summaries exist', async () => {
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result).not.toBeNull();
    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('injects memory_context when sessionCreated is true and memories exist', async () => {
    insertMemory(db, { content: 'Alice likes hiking', confidence: 0.9 });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    const mc = result!.envelope.metadata.memory_context as string;
    expect(mc).toBeTruthy();
    expect(mc).toContain('<memory contact="alice">');
    expect(mc).toContain('Alice likes hiking');
    expect(mc).toContain('</memory>');
  });

  it('formats memories with category, content, and confidence', async () => {
    insertMemory(db, { category: 'preference', content: 'Prefers dark mode', confidence: 0.95 });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    const mc = result!.envelope.metadata.memory_context as string;
    expect(mc).toContain('[preference]');
    expect(mc).toContain('Prefers dark mode');
    expect(mc).toContain('0.95');
  });

  it('excludes superseded memories', async () => {
    const newId = randomUUID();
    insertMemory(db, { content: 'Old memory', supersededBy: newId });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('excludes expired memories', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    insertMemory(db, { content: 'Expired memory', expiresAt: pastDate });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('includes session summaries within context_window_hours', async () => {
    insertSummary(db, { summaryText: 'Discussed deployment.' });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    const mc = result!.envelope.metadata.memory_context as string;
    expect(mc).toContain('Discussed deployment.');
    expect(mc).toContain('## Recent conversations');
  });

  it('excludes session summaries older than context_window_hours', async () => {
    // 3 days ago — outside 48h window
    const oldDate = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    insertSummary(db, { summaryText: 'Old summary.', createdAt: oldDate });
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    // No memories either, so nothing injected
    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('does not inject for a different contact', async () => {
    // Memory is for 'bob', not 'alice'
    insertMemory(db, { contactId: 'bob', content: 'Bob likes coffee' });
    const ctx = makeCtx(db); // contact.id = 'alice'
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    expect(result!.envelope.metadata.memory_context).toBeUndefined();
  });

  it('applies 4000 character cap by trimming summaries first', async () => {
    // Insert a memory
    insertMemory(db, { content: 'Short memory' });
    // Insert a summary with a very long text
    const longText = 'x'.repeat(5000);
    insertSummary(db, { summaryText: longText });

    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);

    const mc = result!.envelope.metadata.memory_context as string;
    expect(mc.length).toBeLessThanOrEqual(4000);
    // Memory should still be present since we trim summaries first
    expect(mc).toContain('Short memory');
  });

  it('never returns null', async () => {
    const ctx = makeCtx(db);
    const stage = createMemoryInject(db, stubConfig);
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });
});
