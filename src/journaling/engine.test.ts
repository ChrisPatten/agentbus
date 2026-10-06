import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { JournalEngine, MAX_ATTEMPTS_PER_WINDOW } from './engine.js';
import { JournalerRegistry } from './registry.js';
import type { Journaler, JournalJob, JournalOutcome, JournalerId } from './types.js';

const MIN = 60_000;
let db: Database.Database;
let clock: number;
let seq = 0;

function makeConfig(opts: { headless?: Record<string, unknown>; agents?: Record<string, unknown>; twoHeadless?: boolean } = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-headless': opts.twoHeadless
        ? {
            baxter: { agent_id: 'baxter', system_prompt: 'x', journaling: { threshold_ms: 10 * MIN } },
            other: { agent_id: 'other', system_prompt: 'y' },
          }
        : { agent_id: 'baxter', system_prompt: 'x', journaling: { threshold_ms: { default: 10 * MIN, telegram: 5 * MIN }, ...opts.headless } },
      'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude' },
    },
    memory: {},
    agents: opts.agents ?? {},
  });
}

function session(id: string, opts: { agentId?: string | null; channel?: string; startedMin?: number; endedAt?: string | null; claude?: string | null } = {}) {
  const started = new Date(clock - (opts.startedMin ?? 120) * MIN).toISOString();
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, ended_at, agent_id, claude_session_id)
    VALUES (?, ?, ?, 'chris', ?, ?, ?, ?, ?)`).run(
    id, `conv-${id}`, opts.channel ?? 'telegram', started, started, opts.endedAt ?? null,
    opts.agentId === undefined ? 'agent:baxter' : opts.agentId, opts.claude === undefined ? `claude-${id}` : opts.claude,
  );
}

/** A transcript row `minAgo` minutes before the clock; inbound rows bump last_activity like stage 80. */
function msg(sessionId: string, minAgo: number, opts: { dir?: 'inbound' | 'outbound'; meta?: Record<string, unknown> } = {}) {
  seq += 1;
  const at = new Date(clock - minAgo * MIN).toISOString();
  const dir = opts.dir ?? 'inbound';
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, (SELECT conversation_id FROM sessions WHERE id = ?), ?, ?, 'telegram', 'chris', ?, ?, json(?))`)
    .run(`t${seq}`, `m${seq}`, sessionId, sessionId, at, dir, `message ${seq}`, JSON.stringify(opts.meta ?? {}));
  if (dir === 'inbound') db.prepare(`UPDATE sessions SET last_activity = ? WHERE id = ? AND last_activity < ?`).run(at, sessionId, at);
}

function fakeJournaler(id: JournalerId = 'cc-headless', outcome: JournalOutcome = 'done') {
  const jobs: JournalJob[] = [];
  let release: (() => void) | null = null;
  const j: Journaler & { jobs: JournalJob[]; held: boolean; hold: () => void; release: () => void } = {
    id, requires: [], supportsKinds: ['session'], jobs,
    canJournal: () => ({ ok: true }),
    run: vi.fn(async (job: JournalJob) => {
      jobs.push(job);
      if (release === null && j.held) await new Promise<void>((r) => { release = r; });
      return { outcome };
    }),
    held: false,
    hold() { j.held = true; },
    release() { j.held = false; release?.(); release = null; },
  } as never;
  return j;
}

function engineFor(config: AppConfig, journalers: Journaler[], extra: Partial<ConstructorParameters<typeof JournalEngine>[0]> = {}) {
  const registry = new JournalerRegistry();
  for (const j of journalers) registry.register(j);
  return new JournalEngine({
    db, config, resolver: new RuntimeResolver(config), registry, now: () => new Date(clock), log: () => {}, ...extra,
  });
}

/** Run a tick and wait for every evaluation it queued. */
async function tickAndSettle(engine: JournalEngine) {
  engine.tick();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const cursor = (id: string) => (db.prepare('SELECT journal_cursor_at FROM sessions WHERE id = ?').get(id) as { journal_cursor_at: string | null }).journal_cursor_at;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  clock = Date.UTC(2026, 9, 6, 12, 0);
  seq = 0;
});

describe('JournalEngine pause and ceiling triggers (E66 S66.3)', () => {
  it('journals a paused session past the per-channel threshold and advances the cursor', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1');
    msg('s1', 20); msg('s1', 19, { dir: 'outbound' }); msg('s1', 8); msg('s1', 7, { dir: 'outbound' });
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(1);
    expect(j.jobs[0]).toMatchObject({ trigger: 'pause', agentId: 'agent:baxter', runtime: 'cc-headless', humanMessageCount: 2, claudeSessionId: 'claude-s1' });
    expect(cursor('s1')).toBe(new Date(clock - 7 * MIN).toISOString());
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(1); // nothing new past the cursor
  });

  it('waits for the threshold, measured from the latest of inbound, agent reply and turn-ended', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1');
    msg('s1', 20); msg('s1', 10);
    engine.noteTurnEnded('s1', new Date(clock - 2 * MIN).toISOString()); // a long turn ended 2 min ago
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(0);
    clock += 4 * MIN;
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(1);
  });

  it('keeps below-threshold content pending, then journals it once it is 24 h old', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1');
    msg('s1', 30);
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(0);
    clock += 24 * 60 * MIN;
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(1);
  });

  it('fires the ceiling for a session that never pauses, measured from the last journal', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig({ headless: { ceiling_ms: 60 * MIN } }), [j]);
    session('s1', { startedMin: 61 });
    msg('s1', 3); msg('s1', 1);
    await tickAndSettle(engine);
    expect(j.jobs.map((x) => x.trigger)).toEqual(['ceiling']);
    msg('s1', 0.5); msg('s1', 0.2);
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(1); // last_journaled_at is now
  });

  it('ignores scheduled-only activity', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1');
    msg('s1', 30, { meta: { scheduled: true } }); msg('s1', 29, { dir: 'outbound' });
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(0);
  });

  it('never journals when journaling is disabled or not configured', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig({ headless: { enabled: false } }), [j]);
    session('s1'); msg('s1', 30); msg('s1', 29);
    session('s2', { agentId: 'agent:nobody' }); msg('s2', 30); msg('s2', 29);
    await tickAndSettle(engine);
    expect(j.jobs).toHaveLength(0);
    expect(engine.trigger({ reason: 'manual', sessionId: 's2' }).status).toBe('not-configured');
  });
});

describe('JournalEngine final triggers (E66 S66.3)', () => {
  it('/clear on a closed session bypasses min_human_messages and is persisted across a restart', async () => {
    const config = makeConfig();
    session('s1', { endedAt: new Date(clock).toISOString() });
    msg('s1', 30);
    const first = engineFor(config, []); // no journalers: the chain is exhausted
    const handle = first.trigger({ reason: 'clear', sessionId: 's1' });
    expect(handle.status).toBe('queued');
    expect((await handle.done).status).toBe('exhausted');
    expect(first.store.getState('s1')).toMatchObject({ pending_trigger: 'clear' });

    const j = fakeJournaler();
    const restarted = engineFor(config, [j]);
    await tickAndSettle(restarted);
    expect(j.jobs.map((x) => [x.trigger, x.sessionOpen])).toEqual([['clear', false]]);
    expect(restarted.store.getState('s1')).toMatchObject({ pending_trigger: null, last_outcome: 'done' });
  });

  it('a final trigger with nothing eligible clears the pending state without running', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1'); msg('s1', 5, { meta: { scheduled: true } });
    expect((await engine.trigger({ reason: 'close', sessionId: 's1' }).done).status).toBe('nothing');
    expect(engine.store.getState('s1')!.pending_trigger).toBeNull();
    expect(j.jobs).toHaveLength(0);
  });

  it('resolves pool sessions to the pool agent and accepts evict by conversation id', async () => {
    const j = fakeJournaler('script');
    const config = makeConfig({ agents: { peggy: { journaling: { chain: ['script'], script: { command: '/bin/true' } } } } });
    const engine = engineFor(config, [j]);
    session('p1', { agentId: 'agent:peggy-pool-2' });
    msg('p1', 3);
    const handle = engine.trigger({ reason: 'evict', conversationId: 'conv-p1' });
    expect(handle).toMatchObject({ status: 'queued', agentId: 'agent:peggy', sessionId: 'p1' });
    await handle.done;
    expect(j.jobs[0]).toMatchObject({ agentId: 'agent:peggy', sessionAgentId: 'agent:peggy-pool-2', runtime: 'cc-pool', trigger: 'evict' });
  });

  it('manual bypasses the threshold and min_human_messages but respects the cursor', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1'); msg('s1', 1);
    expect((await engine.trigger({ reason: 'manual', sessionId: 's1' }).done).status).toBe('journaled');
    expect((await engine.trigger({ reason: 'manual', sessionId: 's1' }).done).status).toBe('nothing');
  });

  it('shutdown persists a trigger for sessions with unjournaled human content', async () => {
    const engine = engineFor(makeConfig(), [fakeJournaler()]);
    session('s1'); msg('s1', 1);
    session('s2'); msg('s2', 1, { meta: { scheduled: true } });
    expect(await engine.shutdown({ waitMs: 10 })).toEqual(['s1']);
    expect(engine.store.listPending().map((r) => [r.session_id, r.pending_trigger])).toEqual([['s1', 'shutdown']]);
  });
});

describe('JournalEngine concurrency (E66 S66.3)', () => {
  it('single-flight per session: a trigger while queued merges, one while running re-evaluates after', async () => {
    const j = fakeJournaler();
    j.hold();
    const engine = engineFor(makeConfig(), [j]);
    session('s1'); msg('s1', 30); msg('s1', 29);
    const first = engine.trigger({ reason: 'pause', sessionId: 's1' });
    const second = engine.trigger({ reason: 'ceiling', sessionId: 's1' });
    expect(second.status).toBe('merged');
    await new Promise((r) => setImmediate(r));
    const third = engine.trigger({ reason: 'clear', sessionId: 's1' }); // arrives while running
    expect(third.status).toBe('merged');
    j.release();
    await first.done;
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(j.jobs).toHaveLength(1); // re-evaluation found nothing new past the cursor
    expect(engine.store.getState('s1')!.pending_trigger).toBeNull();
  });

  it('one run per agent at a time across sessions', async () => {
    const j = fakeJournaler();
    j.hold();
    const engine = engineFor(makeConfig(), [j]);
    session('s1'); msg('s1', 30); msg('s1', 29);
    session('s2'); msg('s2', 30); msg('s2', 29);
    const a = engine.trigger({ reason: 'manual', sessionId: 's1' });
    const b = engine.trigger({ reason: 'manual', sessionId: 's2' });
    await new Promise((r) => setImmediate(r));
    expect(j.run).toHaveBeenCalledTimes(1);
    expect(engine.isAgentBusy('agent:baxter')).toBe(true);
    j.release();
    await a.done;
    await b.done;
    expect(j.run).toHaveBeenCalledTimes(2);
  });

  it(`stops retrying a window after ${MAX_ATTEMPTS_PER_WINDOW} exhausted runs until new content arrives`, async () => {
    const j = fakeJournaler('cc-headless', 'failed-after-start');
    const engine = engineFor(makeConfig(), [j]);
    session('s1'); msg('s1', 30); msg('s1', 29);
    for (let i = 0; i < MAX_ATTEMPTS_PER_WINDOW; i++) {
      expect((await engine.trigger({ reason: 'pause', sessionId: 's1' }).done).status).toBe('exhausted');
    }
    expect((await engine.trigger({ reason: 'pause', sessionId: 's1' }).done).status).toBe('attempt-cap');
    expect((await engine.trigger({ reason: 'manual', sessionId: 's1' }).done).status).toBe('exhausted'); // manual ignores the cap
    expect(cursor('s1')).toBeNull();
    msg('s1', 0);
    expect((await engine.trigger({ reason: 'pause', sessionId: 's1' }).done).status).toBe('exhausted');
  });
});

describe('JournalEngine agent attribution (E66 S66.3)', () => {
  it('a session without agent_id falls back to the sole cc-headless instance', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig(), [j]);
    session('s1', { agentId: null }); msg('s1', 30); msg('s1', 29);
    await tickAndSettle(engine);
    expect(j.jobs[0]!.agentId).toBe('agent:baxter');
  });

  it('with several instances, an unattributed session is skipped', async () => {
    const j = fakeJournaler();
    const engine = engineFor(makeConfig({ twoHeadless: true }), [j]);
    session('s1', { agentId: null }); msg('s1', 30); msg('s1', 29);
    session('s2', { agentId: 'agent:baxter' }); msg('s2', 30); msg('s2', 29);
    await tickAndSettle(engine);
    expect(j.jobs.map((x) => x.sessionId)).toEqual(['s2']);
  });
});
