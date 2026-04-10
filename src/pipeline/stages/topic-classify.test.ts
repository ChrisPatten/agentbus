import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createTopicClassify } from './topic-classify.js';
import type { PipelineContext } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import type { MessageEnvelope } from '../../types/envelope.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<AppConfig['pipeline']> = {}): AppConfig {
  return {
    bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
    adapters: {},
    contacts: {},
    topics: ['general', 'code', 'health', 'urgent'],
    memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [],
      ...overrides,
    },
  } as unknown as AppConfig;
}

function makeCtx(envelope: Partial<MessageEnvelope> = {}, config?: AppConfig): PipelineContext {
  return {
    envelope: {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: 'contact:alice',
      recipient: 'agent:claude',
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
    config: config ?? makeConfig(),
    db: makeDb(),
  };
}

describe('topic-classify stage', () => {
  it('defaults to general when no rules and topic is general', async () => {
    const stage = createTopicClassify(makeConfig());
    const ctx = makeCtx({ topic: 'general' });
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('general');
    expect(result!.topics).toEqual(['general']);
  });

  it('preserves existing non-general topic that is in config.topics', async () => {
    const stage = createTopicClassify(makeConfig());
    const ctx = makeCtx({ topic: 'code' });
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('code');
    expect(result!.topics).toEqual(['code']);
  });

  it('does not preserve unrecognized non-general topic (applies rules instead)', async () => {
    const stage = createTopicClassify(makeConfig());
    const ctx = makeCtx({ topic: 'unknown-topic' });
    const result = await stage(ctx);
    // unknown-topic is not in config.topics, so it falls through to rules → defaults to general
    expect(result!.envelope.topic).toBe('general');
  });

  it('matches topic by keyword', async () => {
    const config = makeConfig({
      topic_rules: [{ topic: 'code', keywords: ['bug', 'python', 'typescript'] }],
    });
    const stage = createTopicClassify(config);
    const ctx = makeCtx({ topic: 'general', payload: { type: 'text', body: 'I found a bug in the code' } }, config);
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('code');
    expect(result!.topics).toEqual(['code']);
  });

  it('keyword match is case-insensitive', async () => {
    const config = makeConfig({
      topic_rules: [{ topic: 'health', keywords: ['doctor', 'medicine'] }],
    });
    const stage = createTopicClassify(config);
    const ctx = makeCtx({ topic: 'general', payload: { type: 'text', body: 'I need to see a DOCTOR' } }, config);
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('health');
  });

  it('matches topic by regex pattern', async () => {
    const config = makeConfig({
      topic_rules: [{ topic: 'code', pattern: '\\bPR #\\d+\\b' }],
    });
    const stage = createTopicClassify(config);
    const ctx = makeCtx({ topic: 'general', payload: { type: 'text', body: 'Review PR #42 please' } }, config);
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('code');
  });

  it('first matching rule wins', async () => {
    const config = makeConfig({
      topic_rules: [
        { topic: 'code', keywords: ['bug'] },
        { topic: 'urgent', keywords: ['bug'] },
      ],
    });
    const stage = createTopicClassify(config);
    const ctx = makeCtx({ topic: 'general', payload: { type: 'text', body: 'there is a bug' } }, config);
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('code');
  });

  it('falls back to general when no rule matches', async () => {
    const config = makeConfig({
      topic_rules: [{ topic: 'code', keywords: ['typescript'] }],
    });
    const stage = createTopicClassify(config);
    const ctx = makeCtx({ topic: 'general', payload: { type: 'text', body: 'what is for dinner?' } }, config);
    const result = await stage(ctx);
    expect(result!.envelope.topic).toBe('general');
  });

  it('never returns null', async () => {
    const stage = createTopicClassify(makeConfig());
    const ctx = makeCtx();
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });
});
