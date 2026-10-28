/** E81 — POST /api/v1/messages/:id/{edit,pin,unpin} (S81.4, S81.5). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import type { AdapterInstance, OutboundActionResult } from '../core/registry.js';
import { OutboundStore } from '../outbound/store.js';
import { createHttpServer } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';

const config = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: {},
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

function stub(overrides: Partial<AdapterInstance> = {}): AdapterInstance {
  return {
    id: 'telegram',
    name: 'telegram',
    capabilities: { send: true, channels: ['telegram'] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    ...overrides,
  };
}

describe('outbound message actions (E81)', () => {
  let server: FastifyInstance;
  let registry: AdapterRegistry;
  let db: Database.Database;
  const seen: Array<unknown[]> = [];
  let result: OutboundActionResult;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    registry = new AdapterRegistry();
    seen.length = 0;
    result = { ok: true };
    server = await createHttpServer({ queue: new MessageQueue(db), registry, config, pipeline: new PipelineEngine(), db });
    new OutboundStore(db).record({ busMessageId: 'm1', channel: 'telegram', chatId: 1, platformMessageId: 2, kind: 'text' });
    registry.register(
      stub({
        editMessage: async (...a) => (seen.push(['edit', ...a]), result),
        pinMessage: async (...a) => (seen.push(['pin', ...a]), result),
        unpinMessage: async (...a) => (seen.push(['unpin', ...a]), result),
      }),
    );
  });

  afterEach(async () => {
    await server.close();
  });

  it('edit forwards body and validated choices to the adapter', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages/m1/edit', payload: { body: 'new', choices: ['A', { label: 'B', style: 'danger' }] } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(seen).toEqual([['edit', 'm1', 'new', ['A', { label: 'B', style: 'danger' }]]]);
  });

  it('edit without choices passes undefined (keyboard cleared)', async () => {
    await server.inject({ method: 'POST', url: '/api/v1/messages/m1/edit', payload: { body: 'new' } });
    expect(seen).toEqual([['edit', 'm1', 'new', undefined]]);
  });

  it('edit rejects a missing body and invalid choices', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/v1/messages/m1/edit', payload: {} })).statusCode).toBe(400);
    const bad = await server.inject({ method: 'POST', url: '/api/v1/messages/m1/edit', payload: { body: 'x', choices: [] } });
    expect(bad.statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('404s for a message with no registry row', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages/ghost/edit', payload: { body: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('No record');
  });

  it('surfaces an adapter error to the caller', async () => {
    result = { ok: false, error: 'This bot lacks the "Pin Messages" admin right in this chat.' };
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages/m1/pin', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Pin Messages');
  });

  it('pin is silent unless silent:false; unpin all flag is passed through', async () => {
    await server.inject({ method: 'POST', url: '/api/v1/messages/m1/pin', payload: {} });
    await server.inject({ method: 'POST', url: '/api/v1/messages/m1/pin', payload: { silent: false } });
    await server.inject({ method: 'POST', url: '/api/v1/messages/m1/unpin', payload: { all: true } });
    await server.inject({ method: 'POST', url: '/api/v1/messages/m1/unpin', payload: {} });
    expect(seen).toEqual([['pin', 'm1', true], ['pin', 'm1', false], ['unpin', 'm1', true], ['unpin', 'm1', false]]);
  });

  it('400s when the channel adapter does not implement the action', async () => {
    registry.deregister('telegram');
    registry.register(stub());
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages/m1/pin', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('does not support');
  });

  it('passes through a no-op note', async () => {
    result = { ok: true, note: 'nothing changed' };
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages/m1/edit', payload: { body: 'x' } });
    expect(JSON.parse(res.body)).toEqual({ ok: true, note: 'nothing changed' });
  });
});
