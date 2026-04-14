import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { PipelineEngine } from './engine.js';
import type { PipelineContext, PipelineStage } from './types.js';
import type { AppConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:alice',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hello' },
    metadata: {},
    ...overrides,
  };
}

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {
    summarizer_interval_ms: 60000,
    session_idle_threshold_ms: 1800000,
    context_window_hours: 48,
    claude_api_model: 'claude-opus-4-6',
  },
  pipeline: {
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [],
    priority_weights: {
      base_score: 0,
      topic_bonus: 40,
      vip_sender_bonus: 20,
      urgency_keyword_bonus: 15,
    },
    urgency_keywords: ['urgent', 'asap'],
    vip_contacts: [],
    routes: [],
  },
} as unknown as AppConfig;

function makePipelineContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    envelope: makeEnvelope(),
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
    config: stubConfig,
    db: makeDb(),
    ...overrides,
  };
}

describe('PipelineEngine', () => {
  it('runs all stages in order and returns context', async () => {
    const engine = new PipelineEngine();
    const order: number[] = [];

    engine.use({ slot: 30, name: 'stage-3', stage: async (ctx) => { order.push(3); return ctx; } });
    engine.use({ slot: 10, name: 'stage-1', stage: async (ctx) => { order.push(1); return ctx; } });
    engine.use({ slot: 20, name: 'stage-2', stage: async (ctx) => { order.push(2); return ctx; } });

    const ctx = makePipelineContext();
    const result = await engine.process(ctx);

    expect(result).not.toBeNull();
    expect(order).toEqual([1, 2, 3]);
  });

  it('aborts when a stage returns null and skips remaining stages', async () => {
    const engine = new PipelineEngine();
    const stage3 = vi.fn(async (ctx: PipelineContext) => ctx);

    engine.use({ slot: 10, name: 'stage-1', stage: async (ctx) => ctx });
    engine.use({ slot: 20, name: 'stage-2', stage: async () => null });
    engine.use({ slot: 30, name: 'stage-3', stage: stage3 });

    const result = await engine.process(makePipelineContext());

    expect(result).toBeNull();
    expect(stage3).not.toHaveBeenCalled();
  });

  it('aborts on stage error when critical=true (default)', async () => {
    const engine = new PipelineEngine();
    const stage2 = vi.fn(async (ctx: PipelineContext) => ctx);

    engine.use({
      slot: 10,
      name: 'thrower',
      stage: async () => { throw new Error('boom'); },
    });
    engine.use({ slot: 20, name: 'stage-2', stage: stage2 });

    const result = await engine.process(makePipelineContext());

    expect(result).toBeNull();
    expect(stage2).not.toHaveBeenCalled();
  });

  it('skips and continues when critical=false and stage throws', async () => {
    const engine = new PipelineEngine();
    const stage2 = vi.fn(async (ctx: PipelineContext) => ctx);

    engine.use({
      slot: 10,
      name: 'non-critical-thrower',
      stage: async () => { throw new Error('non-fatal'); },
      critical: false,
    });
    engine.use({ slot: 20, name: 'stage-2', stage: stage2 });

    const result = await engine.process(makePipelineContext());

    expect(result).not.toBeNull();
    expect(stage2).toHaveBeenCalledOnce();
  });

  it('returns context unchanged with no stages registered', async () => {
    const engine = new PipelineEngine();
    const ctx = makePipelineContext();
    const result = await engine.process(ctx);
    expect(result).toBe(ctx);
  });

  it('sets ctx.abortReason when a stage returns null', async () => {
    const engine = new PipelineEngine();
    engine.use({ slot: 10, name: 'aborter', stage: async () => null });
    const ctx = makePipelineContext();
    const result = await engine.process(ctx);
    expect(result).toBeNull();
    expect(ctx.abortReason).toBe('Aborted at stage "aborter"');
  });

  it('sets ctx.abortReason when a critical stage throws', async () => {
    const engine = new PipelineEngine();
    engine.use({ slot: 10, name: 'thrower', stage: async () => { throw new Error('explode'); } });
    const ctx = makePipelineContext();
    const result = await engine.process(ctx);
    expect(result).toBeNull();
    expect(ctx.abortReason).toMatch(/thrower.*explode/);
  });

  it('each stage receives the context returned by the previous stage', async () => {
    const engine = new PipelineEngine();

    engine.use({
      slot: 10,
      name: 'set-topic',
      stage: async (ctx) => { ctx.envelope.topic = 'code'; return ctx; },
    });
    engine.use({
      slot: 20,
      name: 'read-topic',
      stage: async (ctx) => {
        expect(ctx.envelope.topic).toBe('code');
        return ctx;
      },
    });

    await engine.process(makePipelineContext());
  });
});
