import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { createPoolRouteResolve } from './pool-route-resolve.js';
import type { PipelineContext, RouteTarget } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import type { MessageEnvelope } from '../../types/envelope.js';
import type { PoolManager } from '../../pool/pool-manager.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(): AppConfig {
  return {
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
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [],
      relays: [],
    },
  } as unknown as AppConfig;
}

function makeCtx(
  overrides: Partial<PipelineContext> = {},
  envelopeOverrides: Partial<MessageEnvelope> = {},
): PipelineContext {
  return {
    envelope: {
      id: 'test-id',
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      topic: 'general',
      sender: 'contact:alice',
      recipient: 'agent:peggy',
      reply_to: null,
      priority: 'normal',
      payload: { type: 'text', body: 'hello' },
      metadata: {},
      ...envelopeOverrides,
    },
    contact: null,
    dedupKey: null,
    isSlashCommand: false,
    slashCommand: null,
    topics: [],
    priorityScore: 0,
    routes: [],
    conversationId: 'conv-abc',
    sessionId: null,
    sessionCreated: false,
    config: makeConfig(),
    db: makeDb(),
    ...overrides,
  };
}

/** A fake PoolManager exposing only what this stage calls — `as unknown as
 *  PoolManager` is required since the real class has private fields, which
 *  makes a plain object literal structurally incompatible without the cast. */
function makeFakeManager(resolvedId: string): PoolManager {
  return {
    resolveRoute: vi.fn(async (_conversationId: string, _promptContext: { contact_id: string; channel: string }) => resolvedId),
  } as unknown as PoolManager;
}

describe('pool-route-resolve stage', () => {
  it('rewrites recipientId for a cc-pool route matching a configured manager', async () => {
    const manager = makeFakeManager('agent:peggy-pool-3');
    const poolManagers = new Map([['agent:peggy', manager]]);
    const stage = createPoolRouteResolve(poolManagers);
    const routes: RouteTarget[] = [{ adapterId: 'cc-pool', recipientId: 'agent:peggy' }];
    const ctx = makeCtx({ routes, conversationId: 'conv-1' });

    const result = await stage(ctx);

    expect(result).not.toBeNull();
    expect(result!.routes[0]!.recipientId).toBe('agent:peggy-pool-3');
    expect(manager.resolveRoute).toHaveBeenCalledWith('conv-1', { contact_id: 'alice', channel: 'telegram' });
  });

  it('leaves a non-cc-pool route untouched and never calls any manager', async () => {
    const manager = makeFakeManager('agent:peggy-pool-3');
    const poolManagers = new Map([['agent:peggy', manager]]);
    const stage = createPoolRouteResolve(poolManagers);
    const routes: RouteTarget[] = [{ adapterId: 'cc-headless', recipientId: 'agent:peggy' }];
    const ctx = makeCtx({ routes, conversationId: 'conv-1' });

    const result = await stage(ctx);

    expect(result!.routes[0]!.recipientId).toBe('agent:peggy');
    expect(manager.resolveRoute).not.toHaveBeenCalled();
  });

  it('leaves a cc-pool route with no matching configured manager untouched, without throwing', async () => {
    const poolManagers = new Map<string, PoolManager>();
    const stage = createPoolRouteResolve(poolManagers);
    const routes: RouteTarget[] = [{ adapterId: 'cc-pool', recipientId: 'agent:unknown-pool' }];
    const ctx = makeCtx({ routes, conversationId: 'conv-1' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await stage(ctx);

    expect(result!.routes[0]!.recipientId).toBe('agent:unknown-pool');
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('is a no-op (returns ctx unchanged, no manager calls) when ctx.conversationId is null', async () => {
    const manager = makeFakeManager('agent:peggy-pool-3');
    const poolManagers = new Map([['agent:peggy', manager]]);
    const stage = createPoolRouteResolve(poolManagers);
    const routes: RouteTarget[] = [{ adapterId: 'cc-pool', recipientId: 'agent:peggy' }];
    const ctx = makeCtx({ routes, conversationId: null });

    const result = await stage(ctx);

    expect(result).toBe(ctx);
    expect(result!.routes[0]!.recipientId).toBe('agent:peggy');
    expect(manager.resolveRoute).not.toHaveBeenCalled();
  });

  it('resolves multiple cc-pool routes (e.g. a primary target plus an also_notify target) independently', async () => {
    const managerA = makeFakeManager('agent:peggy-pool-1');
    const managerB = makeFakeManager('agent:jarvis-pool-2');
    const poolManagers = new Map([
      ['agent:peggy', managerA],
      ['agent:jarvis', managerB],
    ]);
    const stage = createPoolRouteResolve(poolManagers);
    const routes: RouteTarget[] = [
      { adapterId: 'cc-pool', recipientId: 'agent:peggy' },
      { adapterId: 'cc-pool', recipientId: 'agent:jarvis' },
    ];
    const ctx = makeCtx({ routes, conversationId: 'conv-1' });

    const result = await stage(ctx);

    expect(result!.routes[0]!.recipientId).toBe('agent:peggy-pool-1');
    expect(result!.routes[1]!.recipientId).toBe('agent:jarvis-pool-2');
    expect(managerA.resolveRoute).toHaveBeenCalledTimes(1);
    expect(managerB.resolveRoute).toHaveBeenCalledTimes(1);
  });
});
