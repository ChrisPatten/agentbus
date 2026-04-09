import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createDedup } from './dedup.js';
import type { PipelineContext } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import type { MessageEnvelope } from '../../types/envelope.js';

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
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

function makeCtx(envelope: Partial<MessageEnvelope> = {}, db?: Database.Database): PipelineContext {
  return {
    envelope: {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: 'contact:chris',
      recipient: 'agent:peggy',
      reply_to: null,
      priority: 'normal',
      payload: { type: 'text', body: 'hello' },
      metadata: {},
      ...envelope,
    },
    contact: null,
    dedupKey: null,
    isSlashCommand: false,
    slashCommand: null,
    topics: [],
    priorityScore: 0,
    routes: [],
    conversationId: null,
    sessionId: null,
    config: stubConfig,
    db: db ?? makeDb(),
  };
}

describe('dedup stage', () => {
  it('passes through first occurrence', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    const ctx = makeCtx({}, db);
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });

  it('sets dedupKey on ctx', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    const ctx = makeCtx({}, db);
    const result = await stage(ctx);
    expect(result!.dedupKey).toBeTruthy();
    expect(typeof result!.dedupKey).toBe('string');
    expect(result!.dedupKey!.length).toBe(64); // sha256 hex
  });

  it('sets dedup_key in envelope metadata', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    const ctx = makeCtx({}, db);
    const result = await stage(ctx);
    expect(result!.envelope.metadata['dedup_key']).toBe(result!.dedupKey);
  });

  it('returns null (abort) for duplicate within window — in-memory Map path', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    // First call: records the key in the in-memory Map
    const ctx1 = makeCtx({ sender: 'contact:chris', payload: { type: 'text', body: 'duplicate' } }, db);
    const result1 = await stage(ctx1);
    expect(result1).not.toBeNull();

    // Second call with same stage instance: Map already holds the key → abort
    const ctx2 = makeCtx({ sender: 'contact:chris', payload: { type: 'text', body: 'duplicate' } }, db);
    const result2 = await stage(ctx2);
    expect(result2).toBeNull();
  });

  it('DB cold-start fallback — detects duplicate from transcripts when Map is empty', async () => {
    const db = makeDb();
    // First stage instance populates DB via Map
    const stage1 = createDedup(db);
    const ctx1 = makeCtx({ sender: 'contact:chris', payload: { type: 'text', body: 'cold-start-dup' } }, db);
    const result1 = await stage1(ctx1);
    expect(result1).not.toBeNull();
    const dedupKey = result1!.dedupKey!;

    // Simulate transcript row being written (as transcript-log stage would do)
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity) VALUES (?, ?, ?, ?, ?, ?)`).run('s-1', 'c-1', 'telegram', 'chris', now, now);
    db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))`).run('t-1', 'msg-1', 'c-1', 's-1', now, 'telegram', 'chris', 'inbound', 'cold-start-dup', JSON.stringify({ dedup_key: dedupKey }));

    // New stage instance (fresh Map) — must fall back to DB
    const stage2 = createDedup(db);
    const ctx2 = makeCtx({ sender: 'contact:chris', payload: { type: 'text', body: 'cold-start-dup' } }, db);
    const result2 = await stage2(ctx2);
    expect(result2).toBeNull();
  });

  it('different body produces different key (no false dedup)', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    const ctx1 = makeCtx({ payload: { type: 'text', body: 'hello' } }, db);
    const ctx2 = makeCtx({ payload: { type: 'text', body: 'world' } }, db);
    const r1 = await stage(ctx1);
    const r2 = await stage(ctx2);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.dedupKey).not.toBe(r2!.dedupKey);
  });

  it('different sender produces different key', async () => {
    const db = makeDb();
    const stage = createDedup(db);
    const ctx1 = makeCtx({ sender: 'contact:chris', payload: { type: 'text', body: 'hello' } }, db);
    const ctx2 = makeCtx({ sender: 'contact:alice', payload: { type: 'text', body: 'hello' } }, db);
    const r1 = await stage(ctx1);
    const r2 = await stage(ctx2);
    expect(r1!.dedupKey).not.toBe(r2!.dedupKey);
  });
});
