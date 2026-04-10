import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { normalize } from './normalize.js';
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

function makeCtx(envelope: Partial<MessageEnvelope> = {}): PipelineContext {
  return {
    envelope: {
      id: '',
      timestamp: '',
      channel: 'telegram',
      topic: '',
      sender: 'contact:alice',
      recipient: '',
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
    db: makeDb(),
  };
}

describe('normalize stage', () => {
  it('assigns a UUID when id is empty', async () => {
    const ctx = makeCtx({ id: '' });
    const result = await normalize(ctx);
    expect(result).not.toBeNull();
    expect(result!.envelope.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves an existing id', async () => {
    const id = randomUUID();
    const ctx = makeCtx({ id });
    const result = await normalize(ctx);
    expect(result!.envelope.id).toBe(id);
  });

  it('assigns timestamp when empty', async () => {
    const ctx = makeCtx({ timestamp: '' });
    const result = await normalize(ctx);
    expect(result!.envelope.timestamp).toBeTruthy();
    expect(() => new Date(result!.envelope.timestamp)).not.toThrow();
  });

  it('defaults topic to general when empty', async () => {
    const ctx = makeCtx({ topic: '' });
    const result = await normalize(ctx);
    expect(result!.envelope.topic).toBe('general');
  });

  it('preserves existing topic', async () => {
    const ctx = makeCtx({ topic: 'code' });
    const result = await normalize(ctx);
    expect(result!.envelope.topic).toBe('code');
  });

  it('defaults recipient to agent:claude when empty', async () => {
    const ctx = makeCtx({ recipient: '' });
    const result = await normalize(ctx);
    expect(result!.envelope.recipient).toBe('agent:claude');
  });

  it('sets raw_received_at in metadata', async () => {
    const ctx = makeCtx();
    const result = await normalize(ctx);
    expect(typeof result!.envelope.metadata['raw_received_at']).toBe('number');
  });

  it('throws on missing channel', async () => {
    const ctx = makeCtx({ channel: '' });
    await expect(normalize(ctx)).rejects.toThrow('channel');
  });

  it('throws on missing sender', async () => {
    const ctx = makeCtx({ sender: '' });
    await expect(normalize(ctx)).rejects.toThrow('sender');
  });

  it('throws on empty payload body', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '' } });
    await expect(normalize(ctx)).rejects.toThrow('payload.body');
  });
});
