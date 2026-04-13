import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createPriorityScore } from './priority-score.js';
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
    topics: ['general', 'code', 'urgent'],
    memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: ['urgent', 'asap', 'emergency', 'critical'],
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

describe('priority-score stage', () => {
  it('leaves priority normal for plain message with no bonuses', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ payload: { type: 'text', body: 'hello' } });
    const result = await stage(ctx);
    expect(result!.envelope.priority).toBe('normal');
    expect(result!.priorityScore).toBe(0);
  });

  it('stores priority_score in metadata', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx();
    const result = await stage(ctx);
    expect(typeof result!.envelope.metadata['priority_score']).toBe('number');
  });

  it('preserves urgent priority → score 100', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ priority: 'urgent' });
    const result = await stage(ctx);
    expect(result!.envelope.priority).toBe('urgent');
    expect(result!.priorityScore).toBe(100);
  });

  it('preserves high priority → score 80', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ priority: 'high' });
    const result = await stage(ctx);
    expect(result!.envelope.priority).toBe('high');
    expect(result!.priorityScore).toBe(80);
  });

  it('applies urgency keyword bonus', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ payload: { type: 'text', body: 'this is urgent please help' } });
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(15); // urgency_keyword_bonus
  });

  it('urgency keyword match is case-insensitive', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ payload: { type: 'text', body: 'EMERGENCY situation' } });
    const result = await stage(ctx);
    expect(result!.priorityScore).toBeGreaterThan(0);
  });

  it('applies VIP sender bonus', async () => {
    const config = makeConfig({ vip_contacts: ['chris'] });
    const stage = createPriorityScore(config);
    const ctx = makeCtx({ sender: 'contact:chris' }, config);
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(20); // vip_sender_bonus
  });

  it('applies urgent topic bonus for non-general topic', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx({ topic: 'code' });
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(40); // topic_bonus
  });

  it('stacks all bonuses and maps to urgent when >= 70', async () => {
    const config = makeConfig({ vip_contacts: ['chris'] });
    const stage = createPriorityScore(config);
    // VIP (20) + urgent keyword (15) + non-general topic (40) = 75
    const ctx = makeCtx({
      sender: 'contact:chris',
      topic: 'code',
      payload: { type: 'text', body: 'urgent fix needed' },
    }, config);
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(75);
    expect(result!.envelope.priority).toBe('urgent');
  });

  it('maps score 40-69 to high priority', async () => {
    const stage = createPriorityScore(makeConfig());
    // topic_bonus (40) alone → score 40 → high
    const ctx = makeCtx({ topic: 'code' });
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(40);
    expect(result!.envelope.priority).toBe('high');
  });

  it('clamps score to 100 maximum', async () => {
    const config = makeConfig({
      priority_weights: { base_score: 60, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      vip_contacts: ['chris'],
    });
    const stage = createPriorityScore(config);
    const ctx = makeCtx({
      sender: 'contact:alice',
      topic: 'code',
      payload: { type: 'text', body: 'urgent emergency' },
    }, config);
    const result = await stage(ctx);
    expect(result!.priorityScore).toBe(100);
  });

  it('never returns null', async () => {
    const stage = createPriorityScore(makeConfig());
    const ctx = makeCtx();
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });
});
