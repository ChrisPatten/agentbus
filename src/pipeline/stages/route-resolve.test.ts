import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createRouteResolve } from './route-resolve.js';
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
    topics: ['general', 'code'],
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

function makeCtx(envelope: Partial<MessageEnvelope> = {}, config?: AppConfig, db?: Database.Database): PipelineContext {
  const theDb = db ?? makeDb();
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
    sessionCreated: false,
    config: config ?? makeConfig(),
    db: theDb,
  };
}

describe('route-resolve stage', () => {
  it('sets conversationId as a sha256 hex string', async () => {
    const db = makeDb();
    const config = makeConfig();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({}, config, db);
    const result = await stage(ctx);
    expect(result!.conversationId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('conversation_id is stable for same contact+channel+topic', async () => {
    const db = makeDb();
    const config = makeConfig();
    const stage = createRouteResolve(config, db);
    const ctx1 = makeCtx({ sender: 'contact:alice', channel: 'telegram', topic: 'general' }, config, db);
    const ctx2 = makeCtx({ sender: 'contact:alice', channel: 'telegram', topic: 'general' }, config, db);
    const r1 = await stage(ctx1);
    const r2 = await stage(ctx2);
    expect(r1!.conversationId).toBe(r2!.conversationId);
  });

  it('defaults to claude-code route when no rules configured', async () => {
    const db = makeDb();
    const config = makeConfig();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ recipient: 'agent:claude' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes).toHaveLength(1);
    expect(result!.routes[0]!.adapterId).toBe('claude-code');
    expect(result!.routes[0]!.recipientId).toBe('agent:claude');
  });

  it('matches route rule by channel', async () => {
    const config = makeConfig({
      routes: [
        { match: { channel: 'telegram' }, target: { adapterId: 'telegram-adapter', recipientId: 'bot:123' } },
      ],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ channel: 'telegram' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes[0]!.adapterId).toBe('telegram-adapter');
  });

  it('matches route rule by sender', async () => {
    const config = makeConfig({
      routes: [
        { match: { sender: 'contact:alice' }, target: { adapterId: 'special', recipientId: 'bot:x' } },
      ],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ sender: 'contact:alice' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes[0]!.adapterId).toBe('special');
  });

  it('includes also_notify targets in routes', async () => {
    const config = makeConfig({
      routes: [
        {
          match: { channel: 'telegram' },
          target: { adapterId: 'primary', recipientId: 'main' },
          also_notify: [{ adapterId: 'log-adapter', recipientId: 'log' }],
        },
      ],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ channel: 'telegram' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes).toHaveLength(2);
    expect(result!.routes[1]!.adapterId).toBe('log-adapter');
  });

  it('first matching rule wins', async () => {
    const config = makeConfig({
      routes: [
        { match: { channel: 'telegram' }, target: { adapterId: 'first', recipientId: 'a' } },
        { match: { channel: 'telegram' }, target: { adapterId: 'second', recipientId: 'b' } },
      ],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ channel: 'telegram' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes[0]!.adapterId).toBe('first');
  });

  it('returns null (abort) when drop_unrouted and no rule matches', async () => {
    const config = makeConfig({
      drop_unrouted: true,
      routes: [{ match: { channel: 'bluebubbles' }, target: { adapterId: 'bb', recipientId: 'x' } }],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ channel: 'telegram' }, config, db);
    const result = await stage(ctx);
    expect(result).toBeNull();
  });

  it('does not return null when drop_unrouted=false and no rule matches', async () => {
    const config = makeConfig({ drop_unrouted: false });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({}, config, db);
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });

  it('same contact on different telegram:* channels gets different conversation_ids', async () => {
    const db = makeDb();
    const config = makeConfig();
    const stage = createRouteResolve(config, db);
    const ctxPeggy = makeCtx({ sender: 'contact:alice', channel: 'telegram:peggy', topic: 'general' }, config, db);
    const ctxJarvis = makeCtx({ sender: 'contact:alice', channel: 'telegram:jarvis', topic: 'general' }, config, db);
    const rPeggy = await stage(ctxPeggy);
    const rJarvis = await stage(ctxJarvis);
    expect(rPeggy!.conversationId).not.toBe(rJarvis!.conversationId);
  });

  it('routes to correct adapter by named-instance channel', async () => {
    const config = makeConfig({
      routes: [
        { match: { channel: 'telegram:peggy' }, target: { adapterId: 'telegram:peggy', recipientId: 'contact:alice' } },
        { match: { channel: 'telegram:jarvis' }, target: { adapterId: 'telegram:jarvis', recipientId: 'contact:alice' } },
      ],
    });
    const db = makeDb();
    const stage = createRouteResolve(config, db);
    const ctx = makeCtx({ channel: 'telegram:jarvis' }, config, db);
    const result = await stage(ctx);
    expect(result!.routes[0]!.adapterId).toBe('telegram:jarvis');
  });
});
