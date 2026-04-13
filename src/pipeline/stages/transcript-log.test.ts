import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createTranscriptLog } from './transcript-log.js';
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
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

function convId(contactId: string, channel: string, topic: string): string {
  const parts = [contactId, channel, topic].sort();
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

function makeCtx(
  envelope: Partial<MessageEnvelope> = {},
  db?: Database.Database,
  conversationId?: string,
): PipelineContext {
  const e = {
    id: 'msg-1',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:chris',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal' as const,
    payload: { type: 'text' as const, body: 'hello' },
    metadata: { dedup_key: 'key-abc' },
    ...envelope,
  };
  const theDb = db ?? makeDb();
  const cid = conversationId ?? convId('chris', e.channel, e.topic);
  return {
    envelope: e,
    contact: null,
    dedupKey: 'key-abc',
    isSlashCommand: false,
    slashCommand: null,
    topics: [e.topic],
    priorityScore: 0,
    routes: [{ adapterId: 'claude-code', recipientId: 'agent:claude' }],
    conversationId: cid,
    sessionId: null,
    config: stubConfig,
    db: theDb,
  };
}

describe('transcript-log stage', () => {
  it('creates a new session when none exists', async () => {
    const db = makeDb();
    const stage = createTranscriptLog(db, stubConfig);
    const ctx = makeCtx({}, db);
    const result = await stage(ctx);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBeTruthy();

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result!.sessionId);
    expect(session).toBeTruthy();
  });

  it('inserts a transcript row', async () => {
    const db = makeDb();
    const stage = createTranscriptLog(db, stubConfig);
    const ctx = makeCtx({}, db);
    await stage(ctx);

    const row = db.prepare('SELECT * FROM transcripts LIMIT 1').get() as { direction: string; body: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.direction).toBe('inbound');
    expect(row!.body).toBe('hello');
  });

  it('upserts conversation_registry', async () => {
    const db = makeDb();
    const stage = createTranscriptLog(db, stubConfig);
    const ctx = makeCtx({}, db);
    await stage(ctx);

    const row = db.prepare('SELECT * FROM conversation_registry LIMIT 1').get() as { contact_id: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.contact_id).toBe('chris');
  });

  it('reuses existing active session within idle threshold', async () => {
    const db = makeDb();
    const config: AppConfig = { ...stubConfig, memory: { ...stubConfig.memory, session_idle_threshold_ms: 1800000 } };
    const stage = createTranscriptLog(db, config);
    const cid = convId('chris', 'telegram', 'general');

    const ctx1 = makeCtx({}, db, cid);
    const r1 = await stage(ctx1);
    const sessionId1 = r1!.sessionId!;

    const ctx2 = makeCtx({ id: 'msg-2' }, db, cid);
    const r2 = await stage(ctx2);

    expect(r2!.sessionId).toBe(sessionId1);
  });

  it('starts a new session after idle threshold exceeded', async () => {
    const db = makeDb();
    // Very short idle threshold
    const config: AppConfig = { ...stubConfig, memory: { ...stubConfig.memory, session_idle_threshold_ms: 1 } };
    const stage = createTranscriptLog(db, config);
    const cid = convId('chris', 'telegram', 'general');

    // First message — creates session
    const ctx1 = makeCtx({}, db, cid);
    const r1 = await stage(ctx1);
    const sessionId1 = r1!.sessionId!;

    // Wait 5ms to exceed the 1ms threshold
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Second message — should create a new session
    const ctx2 = makeCtx({ id: 'msg-2' }, db, cid);
    const r2 = await stage(ctx2);

    expect(r2!.sessionId).not.toBe(sessionId1);

    // Old session should now have ended_at set
    const oldSession = db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(sessionId1) as { ended_at: string | null } | undefined;
    expect(oldSession!.ended_at).not.toBeNull();
  });

  it('increments message_count on session extension', async () => {
    const db = makeDb();
    const config: AppConfig = { ...stubConfig, memory: { ...stubConfig.memory, session_idle_threshold_ms: 1800000 } };
    const stage = createTranscriptLog(db, config);
    const cid = convId('chris', 'telegram', 'general');

    const ctx1 = makeCtx({}, db, cid);
    await stage(ctx1);

    const ctx2 = makeCtx({ id: 'msg-2' }, db, cid);
    await stage(ctx2);

    const session = db.prepare('SELECT message_count FROM sessions WHERE conversation_id = ?').get(cid) as { message_count: number } | undefined;
    expect(session!.message_count).toBe(1); // incremented once (first message creates, second extends)
  });

  it('never returns null', async () => {
    const db = makeDb();
    const stage = createTranscriptLog(db, stubConfig);
    const ctx = makeCtx({}, db);
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });
});
