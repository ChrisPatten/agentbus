/** E68 S68.3 — /api/v1/proposals routes. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../db/schema.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import type { AppConfig } from '../config/schema.js';
import { createHttpServer } from './api.js';

const config = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {}, contacts: {}, topics: ['general'], agents: {},
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000 },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

let db: Database.Database;
let server: FastifyInstance;
const row = { id: 'p1', agent_id: 'agent:baxter', path: 'CLAUDE.md', new_content: 'secret-ish content', status: 'pending', expires_at: 'x' };
const proposals = {
  submit: vi.fn(),
  list: vi.fn(() => [row]),
  get: vi.fn((id: string) => (id === 'p1' ? row : null)),
};

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  proposals.submit.mockReset();
  server = await createHttpServer({
    queue: new MessageQueue(db), registry: new AdapterRegistry(), config, pipeline: new PipelineEngine(), db, proposals: proposals as never,
  });
});
afterEach(async () => { await server.close(); db.close(); });

describe('/api/v1/proposals', () => {
  it('submits a proposal and maps errors to status codes', async () => {
    proposals.submit.mockResolvedValueOnce({ ok: true, proposal: row, notified: 2 });
    const ok = await server.inject({ method: 'POST', url: '/api/v1/proposals', payload: { agent_id: 'baxter', path: 'CLAUDE.md', new_content: 'x', rationale: 'why' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, id: 'p1', notified: 2 });
    expect(proposals.submit).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'baxter', path: 'CLAUDE.md', newContent: 'x', rationale: 'why', source: 'mcp' }));

    proposals.submit.mockResolvedValueOnce({ ok: false, error: 'rate_limited', message: 'later' });
    const limited = await server.inject({ method: 'POST', url: '/api/v1/proposals', payload: { agent_id: 'baxter', path: 'CLAUDE.md', new_content: 'x', rationale: 'why' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ ok: false, error: 'rate_limited', message: 'later' });

    const bad = await server.inject({ method: 'POST', url: '/api/v1/proposals', payload: { path: 'CLAUDE.md' } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists proposals without their content and returns one with it', async () => {
    const list = await server.inject({ method: 'GET', url: '/api/v1/proposals?agent=baxter&status=pending' });
    expect(list.json().proposals[0]).not.toHaveProperty('new_content');
    expect(proposals.list).toHaveBeenCalledWith({ agentId: 'baxter', status: 'pending', limit: 50 });
    expect((await server.inject({ method: 'GET', url: '/api/v1/proposals?status=bogus' })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/api/v1/proposals/p1' })).json().proposal.new_content).toBe('secret-ish content');
    expect((await server.inject({ method: 'GET', url: '/api/v1/proposals/nope' })).statusCode).toBe(404);
  });
});
