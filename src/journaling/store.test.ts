import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { JournalStore, MAX_ERROR_LENGTH } from './store.js';

let db: Database.Database;
let clock: Date;
let store: JournalStore;

function session(id = 's1', lastJournaledAt: string | null = null) {
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id, last_journaled_at)
    VALUES (?, 'conv-1', 'telegram', 'chris', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'agent:baxter', ?)`).run(id, lastJournaledAt);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  clock = new Date('2026-10-06T12:00:00.000Z');
  store = new JournalStore(db, () => clock);
  session();
});

describe('migration 026 (E66 S66.2)', () => {
  it('backfills the cursor from last_journaled_at', () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    runMigrations(raw);
    raw.prepare(`DELETE FROM schema_migrations WHERE version = 26`).run();
    for (const t of ['journal_runs', 'journal_hook_events', 'journal_agent_state', 'journal_snapshots', 'journal_state']) raw.exec(`DROP TABLE ${t}`);
    raw.exec('ALTER TABLE sessions DROP COLUMN journal_cursor_at');
    raw.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, last_journaled_at)
      VALUES ('old', 'c', 'telegram', 'chris', 'x', 'x', '2026-10-01T10:00:00.000Z')`).run();
    runMigrations(raw);
    expect(raw.prepare(`SELECT journal_cursor_at FROM sessions WHERE id = 'old'`).get()).toEqual({ journal_cursor_at: '2026-10-01T10:00:00.000Z' });
  });
});

describe('JournalStore (E66 S66.2)', () => {
  it('advances the cursor forward only and stamps last_journaled_at', () => {
    store.advanceCursor('s1', '2026-10-06T11:00:00.000Z');
    expect(store.getCursor('s1')).toBe('2026-10-06T11:00:00.000Z');
    store.advanceCursor('s1', '2026-10-06T10:00:00.000Z');
    expect(store.getCursor('s1')).toBe('2026-10-06T11:00:00.000Z');
    store.advanceCursor('s1', null);
    expect(store.getCursor('s1')).toBe('2026-10-06T11:00:00.000Z');
    expect(db.prepare(`SELECT last_journaled_at FROM sessions WHERE id = 's1'`).get()).toEqual({ last_journaled_at: clock.toISOString() });
  });

  it('persists a pending final trigger, keeping the first pending_since', () => {
    store.markPending('s1', 'clear', '2026-10-06T09:00:00.000Z');
    store.markPending('s1', 'shutdown', '2026-10-06T10:00:00.000Z');
    expect(store.getState('s1')).toMatchObject({ pending_trigger: 'shutdown', pending_since: '2026-10-06T09:00:00.000Z' });
    expect(store.listPending().map((r) => r.session_id)).toEqual(['s1']);
    store.recordSuccess('s1', 'done');
    expect(store.getState('s1')).toMatchObject({ pending_trigger: null, pending_since: null, last_outcome: 'done' });
  });

  it('counts exhausted attempts per window and re-arms when the window grows', () => {
    expect(store.recordExhausted('s1', 'w1')).toBe(1);
    expect(store.recordExhausted('s1', 'w1')).toBe(2);
    expect(store.attemptsFor('s1', 'w1')).toBe(2);
    expect(store.attemptsFor('s1', 'w2')).toBe(0);
    expect(store.recordExhausted('s1', 'w2')).toBe(1);
  });

  it('tracks turn ends (monotonic) and harness ids', () => {
    store.noteTurnEnded('s1', '2026-10-06T11:00:00.000Z');
    store.noteTurnEnded('s1', '2026-10-06T10:00:00.000Z');
    store.noteHarness('s1', 'claude-1', '/t.jsonl');
    store.noteHarness('s1', null, null);
    expect(store.getState('s1')).toMatchObject({
      last_turn_ended_at: '2026-10-06T11:00:00.000Z', harness_session_id: 'claude-1', harness_transcript_path: '/t.jsonl',
    });
  });

  it('registers and consumes snapshots', () => {
    const a = store.addSnapshot('s1', 'pre-compact', '/snap/a.jsonl');
    store.addSnapshot('s1', 'clear', '/snap/b.jsonl');
    expect(store.pendingSnapshots('s1').map((s) => s.path)).toEqual(['/snap/a.jsonl', '/snap/b.jsonl']);
    store.consumeSnapshots([a.id], 'run-1');
    expect(store.pendingSnapshots('s1').map((s) => s.path)).toEqual(['/snap/b.jsonl']);
  });

  it('keeps per-agent consecutive exhaustions until a success', () => {
    expect(store.recordAgentExhausted('agent:baxter', 'boom')).toBe(1);
    expect(store.recordAgentExhausted('agent:baxter', 'boom')).toBe(2);
    store.recordAgentSuccess('agent:baxter');
    expect(store.getAgentState('agent:baxter')).toMatchObject({ consecutive_exhaustions: 0, last_failure: 'boom', last_success_at: clock.toISOString() });
  });

  it('records runs with truncated errors and sweeps them after 90 days', () => {
    const base = {
      agentId: 'agent:baxter', sessionId: 's1', conversationId: 'conv-1', kind: 'session' as const, trigger: 'pause',
      chainPosition: 0, fallbackFrom: null, messageCount: 3,
    };
    store.insertRun({ ...base, runId: 'old', journaler: 'cc-headless', outcome: 'done', startedAt: '2026-06-01T00:00:00.000Z' });
    store.insertRun({ ...base, runId: 'new', journaler: 'cc-headless', outcome: 'failed-after-start', error: 'x'.repeat(2000),
      startedAt: '2026-10-06T11:00:00.000Z', filesChanged: ['memory/MEMORY.md'] });
    const runs = store.listRuns({ agentId: 'agent:baxter' });
    expect(runs.map((r) => r.run_id)).toEqual(['new', 'old']);
    expect(runs[0]!.error!.length).toBe(MAX_ERROR_LENGTH);
    expect(JSON.parse(runs[0]!.files_changed!)).toEqual(['memory/MEMORY.md']);
    expect(store.sweepRuns()).toBe(1);
    expect(store.listRuns().map((r) => r.run_id)).toEqual(['new']);
  });

  it('records hook sightings', () => {
    store.recordHookEvent('agent:peggy', 'turn-ended', '2026-10-06T10:00:00.000Z');
    store.recordHookEvent('agent:peggy', 'turn-ended', '2026-10-06T11:00:00.000Z');
    expect(store.hookEvents('agent:peggy')).toEqual([{ event: 'turn-ended', last_seen_at: '2026-10-06T11:00:00.000Z', count: 2 }]);
  });
});
