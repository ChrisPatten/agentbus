import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { runtimeCapabilities } from '../core/runtime-capabilities.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry } from '../core/registry.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { createHttpServer } from '../http/api.js';
import { JournalEngine } from './engine.js';
import { JournalerRegistry } from './registry.js';
import { JournalStore } from './store.js';
import {
  HarnessEvents,
  TURN_ENDED_GRACE_MS,
  checkSnapshotPath,
  createHookHealthTicker,
  hookHealth,
  parseHarnessEvent,
} from './events.js';
import { hookStoppedCondition } from './advisories.js';
import type { Journaler, JournalJob } from './types.js';

let db: Database.Database;
let dir: string;
let workDir: string;
let snapDir: string;
let config: AppConfig;

function session(id: string, agentId: string, claude: string, endedAt: string | null = null) {
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, agent_id, claude_session_id)
    VALUES (?, ?, 'telegram', 'chris', ?, ?, ?, ?, ?)`).run(id, `conv-${id}`, '2026-10-06T10:00:00.000Z', '2026-10-06T10:00:00.000Z', endedAt, agentId, claude);
}

function msg(sessionId: string, at: string, dir: 'inbound' | 'outbound' = 'inbound') {
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, (SELECT conversation_id FROM sessions WHERE id = ?), ?, ?, 'telegram', 'chris', ?, 'hi', '{}')`)
    .run(`${sessionId}-${at}-${dir}`, `${sessionId}-${at}`, sessionId, sessionId, at, dir);
}

function setup() {
  const jobs: JournalJob[] = [];
  const journaler: Journaler = {
    id: 'script', requires: [], supportsKinds: ['session'], canJournal: () => ({ ok: true }),
    run: async (job) => { jobs.push(job); return { outcome: 'done' }; },
  };
  const registry = new JournalerRegistry();
  registry.register(journaler);
  const engine = new JournalEngine({ db, config, resolver: new RuntimeResolver(config), registry, log: () => {} });
  const marks: string[] = [];
  const poolManagers = new Map([['agent:peggy', {
    poolId: 'peggy',
    leaseStore: {
      list: () => [{ pane_id: 'peggy-pool:2', claude_session_id: 'claude-p1' }, { pane_id: 'peggy-pool:3', claude_session_id: 'claude-orphan' }],
      markTurnEnded: (_pool: string, pane: string) => { marks.push(pane); },
    },
  }]]);
  const events = new HarnessEvents({ db, engine, store: engine.store, poolManagers, snapshotRoots: [snapDir] });
  return { engine, events, jobs, marks };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dir = mkdtempSync(join(tmpdir(), 'journal-events-'));
  workDir = join(dir, 'agent');
  snapDir = join(dir, 'snaps');
  mkdirSync(workDir);
  mkdirSync(snapDir);
  config = AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude', working_dir: workDir } },
    memory: {},
    agents: { peggy: { journaling: { chain: ['script'], script: { command: '/bin/true' } } } },
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseHarnessEvent (E66 S66.4)', () => {
  it('validates the body', () => {
    expect(parseHarnessEvent({ harness_session_id: 'x', event: 'pre-compact', snapshot_path: '/a' }))
      .toEqual({ harness_session_id: 'x', event: 'pre-compact', snapshot_path: '/a' });
    expect(parseHarnessEvent({ event: 'clear' })).toEqual({ error: 'harness_session_id is required' });
    expect(parseHarnessEvent({ harness_session_id: 'x', event: 'stop' })).toMatchObject({ error: expect.stringContaining('event must be one of') });
    expect(parseHarnessEvent({ harness_session_id: 'x', event: 'clear', snapshot_path: '' })).toMatchObject({ error: expect.stringContaining('snapshot_path') });
  });
});

describe('checkSnapshotPath (E66 S66.4)', () => {
  it('accepts files under an allowed root only', () => {
    const ok = join(snapDir, 'a.jsonl');
    writeFileSync(ok, '{}\n');
    const outside = join(dir, 'b.jsonl');
    writeFileSync(outside, '{}\n');
    expect(checkSnapshotPath(ok, [snapDir])).toHaveProperty('path');
    expect(checkSnapshotPath(outside, [snapDir])).toMatchObject({ error: expect.stringContaining('outside') });
    expect(checkSnapshotPath('rel.jsonl', [snapDir])).toMatchObject({ error: expect.stringContaining('absolute') });
    expect(checkSnapshotPath(join(snapDir, 'missing'), [snapDir])).toMatchObject({ error: expect.stringContaining('does not exist') });
    expect(checkSnapshotPath(snapDir, [snapDir])).toMatchObject({ error: expect.stringContaining('not a file') });
  });
});

describe('HarnessEvents (E66 S66.4)', () => {
  it('turn-ended resolves the session by harness id, re-anchors the pause clock and marks the pane, without journaling', () => {
    const { events, engine, jobs, marks } = setup();
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    const result = events.handle({ harness_session_id: 'claude-p1', event: 'turn-ended', transcript_path: '/t.jsonl' });
    expect(result).toMatchObject({ ok: true, session_id: 'p1', agent_id: 'agent:peggy', action: 'turn-ended' });
    expect(engine.store.getState('p1')).toMatchObject({ harness_session_id: 'claude-p1', harness_transcript_path: '/t.jsonl', last_turn_ended_at: expect.any(String) });
    expect(marks).toEqual(['peggy-pool:2']);
    expect(engine.store.hookEvents('agent:peggy')).toMatchObject([{ event: 'turn-ended', count: 1 }]);
    expect(jobs).toHaveLength(0);
  });

  it('pre-compact registers the snapshot and fires a final trigger the next run receives', async () => {
    const { events, engine, jobs } = setup();
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    msg('p1', '2026-10-06T10:01:00.000Z');
    const snap = join(snapDir, 'claude-p1-pre-compact.jsonl');
    writeFileSync(snap, '{"type":"user"}\n');
    const result = events.handle({ harness_session_id: 'claude-p1', event: 'pre-compact', snapshot_path: snap });
    expect(result).toMatchObject({ ok: true, action: 'triggered', trigger: 'queued', snapshot_id: expect.any(String) });
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect(jobs[0]).toMatchObject({ trigger: 'pre-compact', snapshots: [expect.objectContaining({ event: 'pre-compact' })] });
    await vi.waitFor(() => expect(engine.store.pendingSnapshots('p1')).toEqual([]));
  });

  it('a snapshot outside the allowed roots is rejected but the trigger still fires', () => {
    const { events } = setup();
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    const bad = join(dir, 'elsewhere.jsonl');
    writeFileSync(bad, 'x');
    expect(events.handle({ harness_session_id: 'claude-p1', event: 'clear', snapshot_path: bad }))
      .toMatchObject({ ok: true, trigger: 'queued', snapshot_error: expect.stringContaining('outside') });
  });

  it('snapshots under the agent working directory are accepted', () => {
    const { events } = setup();
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    const snap = join(workDir, 'snap.jsonl');
    writeFileSync(snap, 'x');
    expect(events.handle({ harness_session_id: 'claude-p1', event: 'session-end', snapshot_path: snap })).toHaveProperty('snapshot_id');
  });

  it('unknown harness sessions are 404, still marking a matching pool pane on turn-ended', () => {
    const { events, marks } = setup();
    expect(events.handle({ harness_session_id: 'nope', event: 'clear' })).toMatchObject({ ok: false, status: 404 });
    expect(events.handle({ harness_session_id: 'claude-orphan', event: 'turn-ended' })).toMatchObject({ ok: false, status: 404 });
    expect(marks).toEqual(['peggy-pool:3']);
  });
});

describe('hook health (E66 S66.4)', () => {
  const pool = { capabilities: runtimeCapabilities('cc-pool') };
  const now = new Date('2026-10-06T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('reports declared events: idle, never-seen, ok, stopped, unverifiable', () => {
    const store = new JournalStore(db);
    expect(hookHealth(db, store, 'agent:peggy', pool, now).map((e) => [e.event, e.status])).toEqual([
      ['turn-ended', 'idle'], ['pre-compact', 'unverifiable'], ['session-end', 'unverifiable'], ['clear', 'unverifiable'],
    ]);
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    msg('p1', ago(TURN_ENDED_GRACE_MS + 60_000), 'outbound');
    expect(hookHealth(db, store, 'agent:peggy', pool, now)[0]!.status).toBe('never-seen');
    store.recordHookEvent('agent:peggy', 'turn-ended', ago(TURN_ENDED_GRACE_MS + 30_000));
    store.recordHookEvent('agent:peggy', 'pre-compact', ago(1000));
    const entries = hookHealth(db, store, 'agent:peggy', pool, now);
    expect(entries[0]!.status).toBe('ok');
    expect(entries[1]!.status).toBe('ok');
    msg('p1', ago(TURN_ENDED_GRACE_MS + 1000), 'outbound');
    db.prepare(`UPDATE journal_hook_events SET last_seen_at = ? WHERE event = 'turn-ended'`).run(ago(3 * TURN_ENDED_GRACE_MS));
    expect(hookHealth(db, store, 'agent:peggy', pool, now)[0]!.status).toBe('stopped');
  });

  it('the ticker raises a warning for a stopped hook and resolves it when it reports again', () => {
    const store = new JournalStore(db);
    const advisories = { raise: vi.fn(), resolve: vi.fn() };
    const tick = createHookHealthTicker({
      db, store, advisories, now: () => now,
      agents: () => [{ agentId: 'agent:peggy', runtime: new RuntimeResolver(config).resolve('agent:peggy') }],
    });
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    msg('p1', ago(TURN_ENDED_GRACE_MS + 1000), 'outbound');
    store.recordHookEvent('agent:peggy', 'turn-ended', ago(3 * TURN_ENDED_GRACE_MS));
    tick();
    expect(advisories.raise).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: hookStoppedCondition('turn-ended'), severity: 'warning' }));
    store.recordHookEvent('agent:peggy', 'turn-ended', ago(0));
    tick();
    expect(advisories.resolve).toHaveBeenCalledWith('agent:peggy', hookStoppedCondition('turn-ended'));
  });
});

describe('POST /api/v1/journal/events (E66 S66.4)', () => {
  it('validates, resolves and reports', async () => {
    const { events } = setup();
    session('p1', 'agent:peggy-pool-2', 'claude-p1');
    const server = await createHttpServer({
      queue: new MessageQueue(db), registry: new AdapterRegistry(), config, pipeline: new PipelineEngine(), db, journalEvents: events,
    });
    try {
      const bad = await server.inject({ method: 'POST', url: '/api/v1/journal/events', payload: { event: 'clear' } });
      expect(bad.statusCode).toBe(400);
      const missing = await server.inject({ method: 'POST', url: '/api/v1/journal/events', payload: { harness_session_id: 'zzz', event: 'clear' } });
      expect(missing.statusCode).toBe(404);
      const ok = await server.inject({ method: 'POST', url: '/api/v1/journal/events', payload: { harness_session_id: 'claude-p1', event: 'turn-ended' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, session_id: 'p1', action: 'turn-ended' });
    } finally {
      await server.close();
    }
  });
});
