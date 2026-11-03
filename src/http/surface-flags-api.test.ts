/** E96 S96.6 — answer_needed on POST /api/v1/messages and status(subject) on the tool-status route. */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { getAnswerNeeded, listAnswerNeeded, listSubjects } from '../surface/flags.js';
import { createHttpServer } from './api.js';

const config = { bus: { http_port: 0 }, adapters: {}, contacts: {}, agents: {}, pipeline: { routes: [] } } as unknown as AppConfig;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
  const queue = new MessageQueue(db);
  const server = await createHttpServer({ config, db, registry: new AdapterRegistry(), queue, pipeline: new PipelineEngine() });
  closers.push(async () => { await server.close(); db.close(); });
  return { db, server, queue };
}

const msg = (extra: Record<string, unknown>) => ({
  channel: 'telegram:peggy', topic: 'general', sender: 'agent:peggy-pool-1', recipient: 'contact:chris',
  payload: { type: 'text', body: 'Which time works?' }, ...extra,
});

describe('answer_needed on agent messages', () => {
  it('sets the flag for the reply conversation, stored as metadata.answer_needed', async () => {
    const { db, server, queue } = await setup();
    const res = await server.inject({ method: 'POST', url: '/api/v1/messages', payload: msg({ metadata: { answer_needed: true, conversation_id: 'conv-1' } }) });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    expect(getAnswerNeeded(db, 'conv-1')).toMatchObject({ conversation_id: 'conv-1', message_id: id, agent_id: 'peggy-pool-1' });
    expect(queue.getById(id)!.envelope.metadata['answer_needed']).toBe(true);
  });

  it('derives the conversation for a proactive send', async () => {
    const { db, server } = await setup();
    await server.inject({ method: 'POST', url: '/api/v1/messages', payload: msg({ metadata: { answer_needed: true } }) });
    expect(getAnswerNeeded(db, computeConversationId('chris', 'telegram:peggy', 'general'))).not.toBeNull();
  });

  it('never sets it without the flag, for non-agent senders, or for a non-true value', async () => {
    const { db, server } = await setup();
    await server.inject({ method: 'POST', url: '/api/v1/messages', payload: msg({ metadata: { conversation_id: 'conv-1' } }) });
    await server.inject({ method: 'POST', url: '/api/v1/messages', payload: msg({ sender: 'contact:chris', recipient: 'agent:peggy', metadata: { answer_needed: true } }) });
    await server.inject({ method: 'POST', url: '/api/v1/messages', payload: msg({ metadata: { answer_needed: 'yes', conversation_id: 'conv-2' } }) });
    expect(listAnswerNeeded(db)).toEqual([]);
  });
});

describe('status subject on the tool-status route', () => {
  it('stores a sanitised subject by conversation_id', async () => {
    const { db, server } = await setup();
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'chris', text: 'Checking', conversation_id: 'conv-1', subject: '  Kitchen **quote** comparison ' } });
    expect(listSubjects(db).get('conv-1')).toBe('Kitchen quote comparison');
  });

  it('finds the conversation from the pool lease, else from contact/channel/topic', async () => {
    const { db, server } = await setup();
    db.prepare(`INSERT INTO pool_leases (pool_id, pane_id, agent_id, conversation_id, claude_session_id, state) VALUES ('peggy','p1','agent:peggy-pool-1','conv-lease','h-1','leased')`).run();
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'contact:chris', topic: 'general', subject: 'Trip planning', session_id: 'h-1' } });
    await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'contact:chris', topic: 'thread:9', subject: 'Tax forms', session_id: 'unknown' } });
    const subjects = listSubjects(db);
    expect(subjects.get('conv-lease')).toBe('Trip planning');
    expect(subjects.get(computeConversationId('chris', 'telegram:peggy', 'thread:9'))).toBe('Tax forms');
  });

  it('ignores a missing, empty or over-long subject', async () => {
    const { db, server } = await setup();
    for (const subject of [undefined, '***', 'x'.repeat(61)]) {
      await server.inject({ method: 'POST', url: '/api/v1/adapters/telegram:peggy/tool-status', payload: { contact_id: 'chris', text: 'Checking', conversation_id: 'conv-1', subject } });
    }
    expect(listSubjects(db).size).toBe(0);
  });
});
