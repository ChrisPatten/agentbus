import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { slashCommandDetect } from './slash-command.js';
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
    config: stubConfig,
    db: makeDb(),
  };
}

describe('slash-command stage', () => {
  it('passes through non-slash messages unchanged', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: 'hello world' } });
    const result = await slashCommandDetect(ctx);
    expect(result).not.toBeNull();
    expect(result!.isSlashCommand).toBe(false);
    expect(result!.slashCommand).toBeNull();
    expect(result!.envelope.payload.type).toBe('text');
  });

  it('detects a slash command with no args', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/status' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.isSlashCommand).toBe(true);
    expect(result!.slashCommand?.name).toBe('status');
    expect(result!.slashCommand?.args).toEqual([]);
    expect(result!.slashCommand?.argsRaw).toBe('');
  });

  it('parses command name and single arg', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/remind tomorrow' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.isSlashCommand).toBe(true);
    expect(result!.slashCommand?.name).toBe('remind');
    expect(result!.slashCommand?.args).toEqual(['tomorrow']);
    expect(result!.slashCommand?.argsRaw).toBe('tomorrow');
  });

  it('parses command name and multiple args', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/remind buy milk tomorrow' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.slashCommand?.name).toBe('remind');
    expect(result!.slashCommand?.args).toEqual(['buy', 'milk', 'tomorrow']);
    expect(result!.slashCommand?.argsRaw).toBe('buy milk tomorrow');
  });

  it('rewrites payload to slash_command type', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/status' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.envelope.payload.type).toBe('slash_command');
    expect((result!.envelope.payload as { command: string }).command).toBe('status');
  });

  it('preserves original body in rewritten payload', async () => {
    const body = '/remind buy milk tomorrow';
    const ctx = makeCtx({ payload: { type: 'text', body } });
    const result = await slashCommandDetect(ctx);
    expect(result!.envelope.payload.body).toBe(body);
  });

  it('never returns null (does not abort pipeline)', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/status' } });
    const result = await slashCommandDetect(ctx);
    expect(result).not.toBeNull();
  });

  it('strips @botname suffix from command name (Telegram group chats)', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/status@MyBotName' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.isSlashCommand).toBe(true);
    expect(result!.slashCommand?.name).toBe('status');
    expect(result!.slashCommand?.args).toEqual([]);
  });

  it('strips @botname suffix and preserves args', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/pause@MyBot telegram' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.slashCommand?.name).toBe('pause');
    expect(result!.slashCommand?.args).toEqual(['telegram']);
  });

  it('handles slash command with multiword args (argsRaw preserves spaces)', async () => {
    const ctx = makeCtx({ payload: { type: 'text', body: '/note this is a longer message' } });
    const result = await slashCommandDetect(ctx);
    expect(result!.slashCommand?.argsRaw).toBe('this is a longer message');
    expect(result!.slashCommand?.args).toEqual(['this', 'is', 'a', 'longer', 'message']);
  });
});
