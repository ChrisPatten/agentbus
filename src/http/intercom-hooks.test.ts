import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry, type AdapterInstance } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { DeliveryWorker } from '../core/delivery.js';
import type { AppConfig } from '../config/schema.js';
import type { IntercomService } from '../intercom/service.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { createHttpServer } from './api.js';

const config = { bus: { http_port: 0 }, adapters: {}, contacts: {}, agents: {}, pipeline: { routes: [] } } as unknown as AppConfig;

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const queue = new MessageQueue(db);
  const calls: { fn: string; arg: unknown }[] = [];
  const intercom = {
    onTyping: (arg: unknown) => calls.push({ fn: 'onTyping', arg }),
    onToolStatus: (arg: unknown) => calls.push({ fn: 'onToolStatus', arg }),
    onTurnEnded: (arg: unknown) => calls.push({ fn: 'onTurnEnded', arg }),
  } as unknown as IntercomService;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES ('conv-1','chris','telegram:peggy','general',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity) VALUES ('s1','conv-1','telegram:peggy','chris',?,?)`).run(now, now);
  const journalEvents = { handle: () => ({ ok: true as const, session_id: 's1', agent_id: 'agent:peggy', action: 'turn-ended' as const }) };
  return { db, queue, calls, intercom, journalEvents };
}

describe('Intercom activity hooks', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('mirrors typing, tool-status and turn-ended to the Intercom service', async () => {
    const s = setup();
    const server = await createHttpServer({ config, db: s.db, registry: new AdapterRegistry(), queue: s.queue, pipeline: new PipelineEngine(), intercom: s.intercom, journalEvents: s.journalEvents });
    closers.push(() => server.close());
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/typing', payload: { contact_id: 'chris', topic: 'general', conversation_id: 'conv-1' } });
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'chris', text: 'Checking the calendar', topic: 'general' } });
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'chris' } });   // no text: ignored
    const res = await server.inject({ method: 'POST', url: '/api/v1/journal/events', payload: { harness_session_id: 'h1', event: 'turn-ended' } });
    expect(res.statusCode).toBe(200);
    await server.inject({ method: 'POST', url: '/api/v1/journal/events', payload: { harness_session_id: 'h1', event: 'session-end' } });
    expect(s.calls).toEqual([
      { fn: 'onTyping', arg: { channel: 'telegram:peggy', contactId: 'chris', topic: 'general', conversationId: 'conv-1' } },
      { fn: 'onToolStatus', arg: { channel: 'telegram:peggy', contactId: 'chris', topic: 'general', conversationId: undefined, text: 'Checking the calendar' } },
      { fn: 'onTurnEnded', arg: 'conv-1' },
    ]);
  });
});

describe('glance on agent messages (I3)', () => {
  async function post(payload: Record<string, unknown>) {
    const s = setup();
    const server = await createHttpServer({ config, db: s.db, registry: new AdapterRegistry(), queue: s.queue, pipeline: new PipelineEngine() });
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      channel: 'telegram:peggy', topic: 'general', recipient: 'contact:chris', payload: { type: 'text', body: 'Dentist is at 3. Bring the forms.' }, ...payload,
    } });
    const id = (res.json() as { id: string }).id;
    const stored = s.queue.getById(id)!.envelope.metadata;
    await server.close(); s.db.close();
    return stored;
  }
  it('derives a glance for an agent message that has none', async () => {
    expect((await post({ sender: 'agent:peggy-pool-1' }))['glance']).toBe('Dentist is at 3.');
  });
  it('keeps the agent glance and truncates a long one to 100 characters', async () => {
    expect((await post({ sender: 'agent:peggy-pool-1', metadata: { glance: 'At three' } }))['glance']).toBe('At three');
    const long = String((await post({ sender: 'agent:peggy-pool-1', metadata: { glance: 'word '.repeat(60) } }))['glance']);
    expect(Array.from(long).length).toBeLessThanOrEqual(100);
    expect(long.endsWith('…')).toBe(true);
  });
  it('leaves messages from other senders alone', async () => {
    expect((await post({ sender: 'system:bus' }))['glance']).toBeUndefined();
  });
});

describe('DeliveryWorker onDelivered', () => {
  it('fires after a confirmed delivery and not after a failed one', async () => {
    vi.useFakeTimers();
    const db = new Database(':memory:'); runMigrations(db);
    const queue = new MessageQueue(db); const registry = new AdapterRegistry();
    let ok = true;
    const adapter: AdapterInstance = { id: 'telegram:peggy', name: 't', capabilities: { send: true, channels: ['telegram:peggy'] },
      start: async () => {}, stop: async () => {}, health: async () => ({ status: 'healthy' }), send: async () => ok ? { success: true } : { success: false, error: 'no' } };
    registry.register(adapter);
    const seen: MessageEnvelope[] = [];
    const worker = new DeliveryWorker({ queue, registry, db, onDelivered: (e) => { seen.push(e); throw new Error('listener bug'); } });
    const env = (id: string): MessageEnvelope => ({ id, timestamp: new Date().toISOString(), channel: 'telegram:peggy', topic: 'general', sender: 'agent:p', recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'x' }, metadata: {} });
    queue.enqueue(env('a'));
    worker.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.map((e) => e.id)).toEqual(['a']);                    // and the listener's exception did not break delivery
    ok = false;
    queue.enqueue(env('b'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(seen.map((e) => e.id)).toEqual(['a']);
    worker.stop(); vi.useRealTimers(); db.close();
  });
});
