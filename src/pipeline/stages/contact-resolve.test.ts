import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createContactResolve } from './contact-resolve.js';
import type { PipelineContext } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import type { MessageEnvelope } from '../../types/envelope.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
    adapters: {},
    contacts: {
      chris: {
        id: 'chris',
        displayName: 'Chris',
        platforms: {
          telegram: { userId: 123456789, username: 'chrispatten' },
          bluebubbles: { handle: '+15551234567' },
        },
      },
    },
    topics: ['general'],
    memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
    pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
    ...overrides,
  } as unknown as AppConfig;
}

function makeCtx(envelope: Partial<MessageEnvelope> = {}, config?: AppConfig): PipelineContext {
  return {
    envelope: {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: '123456789',
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

describe('contact-resolve stage', () => {
  it('resolves known telegram sender by userId', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ channel: 'telegram', sender: '123456789' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('contact:chris');
    expect(result!.contact?.id).toBe('chris');
    expect(result!.contact?.displayName).toBe('Chris');
  });

  it('resolves known telegram sender by username', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ channel: 'telegram', sender: 'chrispatten' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('contact:chris');
  });

  it('resolves known bluebubbles sender by handle', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ channel: 'bluebubbles', sender: '+15551234567' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('contact:chris');
    expect(result!.contact?.id).toBe('chris');
  });

  it('passes through already-canonical contact: sender', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ sender: 'contact:chris' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('contact:chris');
    expect(result!.contact?.id).toBe('chris');
  });

  it('passes through agent: senders unchanged', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ sender: 'agent:claude' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('agent:claude');
    expect(result!.contact).toBeNull();
  });

  it('sets contact to null for unknown sender', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ channel: 'telegram', sender: '999999' });
    const result = await stage(ctx);
    expect(result!.contact).toBeNull();
  });

  it('reformats unknown sender to platform:channel:id', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ channel: 'telegram', sender: '999999' });
    const result = await stage(ctx);
    expect(result!.envelope.sender).toBe('platform:telegram:999999');
  });

  it('never returns null (does not abort pipeline)', async () => {
    const stage = createContactResolve(makeConfig());
    const ctx = makeCtx({ sender: 'completely:unknown:format' });
    const result = await stage(ctx);
    expect(result).not.toBeNull();
  });
});
