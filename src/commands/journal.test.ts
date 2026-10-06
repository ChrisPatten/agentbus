import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { JournalEngine } from '../journaling/engine.js';
import { JournalerRegistry } from '../journaling/registry.js';
import { journalingHealth } from '../journaling/status.js';
import type { Journaler, JournalOutcome } from '../journaling/types.js';
import type { SlashCommandContext } from './registry.js';
import { createJournalCommand } from './journal.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0);
let db: Database.Database;
const conv = computeConversationId('chris', 'telegram', 'general');

const config = AppConfigSchema.parse({
  bus: { db_path: ':memory:' },
  adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'x' } },
  memory: {},
  agents: { 'agent:baxter': { journaling: { chain: ['cc-headless'] } } },
});

function journaler(outcome: JournalOutcome = 'done'): Journaler {
  return {
    id: 'cc-headless', requires: [], supportsKinds: ['session', 'consolidate'], canJournal: () => ({ ok: true }),
    run: vi.fn(async () => ({ outcome, fidelity: 'full-session' as const, costUsd: 0.03, notes: 'Recorded the trip.' })),
  };
}

function setup(outcome: JournalOutcome = 'done') {
  const registry = new JournalerRegistry();
  registry.register(journaler(outcome));
  const resolver = new RuntimeResolver(config);
  const engine = new JournalEngine({ db, config, resolver, registry, now: () => new Date(NOW), log: () => {} });
  const cmd = createJournalCommand({ db, engine, resolver, now: () => new Date(NOW) });
  return { engine, cmd, resolver };
}

const ctx = (): SlashCommandContext => ({
  channel: 'telegram', sender: 'contact:chris', adapterId: 'telegram', argsRaw: '',
  envelope: { id: 'e', timestamp: '', channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient: '', reply_to: null, priority: 'normal', payload: { type: 'text', body: '/journal' }, metadata: {} },
  db: db as never, config,
} as SlashCommandContext);

function message(id: string, minAgo: number, direction: 'inbound' | 'outbound' = 'inbound') {
  const at = new Date(NOW - minAgo * 60_000).toISOString();
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, ?, 's1', ?, 'telegram', 'chris', ?, ?, '{}')`).run(id, id, conv, at, direction, `msg ${id}`);
  if (direction === 'inbound') db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(at, 's1');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const started = new Date(NOW - 60 * 60_000).toISOString();
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id, claude_session_id)
    VALUES ('s1', ?, 'telegram', 'chris', ?, ?, 'agent:baxter', 'claude-1')`).run(conv, started, started);
});

describe('/journal (E66 S66.10)', () => {
  it('shows conversation and agent status', async () => {
    const { cmd } = setup();
    message('m1', 30);
    const body = (await cmd.handler([], ctx())).body!;
    expect(body).toContain('last journaled: never');
    expect(body).toContain('waiting: 1 message(s) from people (journaled at 2, or when the session ends)');
    expect(body).toContain('Agent agent:baxter (cc-headless)');
    expect(body).toContain('chain: cc-headless');
  });

  it('/journal now journals one message (manual bypasses min_human_messages) and respects the cursor', async () => {
    const { cmd, engine } = setup();
    message('m1', 30);
    message('m2', 29, 'outbound');
    expect((await cmd.handler(['now'], ctx())).body).toBe('Journaled with cc-headless.');
    expect(engine.store.listRuns({ agentId: 'agent:baxter' })[0]).toMatchObject({ trigger: 'manual', outcome: 'done' });
    expect((await cmd.handler(['now'], ctx())).body).toBe('Nothing new to journal since the last run.');
  });

  it('/journal runs lists attempts with journaler, outcome, fidelity and cost', async () => {
    const { cmd } = setup();
    expect((await cmd.handler(['runs'], ctx())).body).toBe('No journal runs yet.');
    message('m1', 30);
    await cmd.handler(['now'], ctx());
    const body = (await cmd.handler(['runs', '3'], ctx())).body!;
    expect(body).toContain('Last 1 journal attempt(s):');
    expect(body).toContain('manual cc-headless: done, saw full-session $0.03 — Recorded the trip.');
  });

  it('/journal consolidate runs a manual pass and /journal shows consolidation status (E68)', async () => {
    const { cmd } = setup();
    expect((await cmd.handler(['consolidate'], ctx())).body).toBe('Consolidated with cc-headless.');
    const runs = (await cmd.handler(['runs'], ctx())).body!;
    expect(runs).toContain('consolidate(manual) cc-headless: done');
    expect((await cmd.handler([], ctx())).body).toContain('consolidation: last 0s ago');
  });

  it('prints usage for an unknown subcommand', async () => {
    const { cmd } = setup();
    expect((await cmd.handler(['bogus'], ctx())).body).toContain('Usage:');
  });
});

describe('journaling health summary (E66 S66.10)', () => {
  it('reports backlog age and consecutive exhaustions per agent', async () => {
    const { engine, resolver } = setup('failed-after-start');
    message('m1', 120);
    message('m2', 100);
    await engine.trigger({ reason: 'manual', sessionId: 's1' }).done;
    const health = journalingHealth({ db, engine, resolver, now: () => new Date(NOW) });
    expect(health.agents['agent:baxter']).toMatchObject({
      consecutive_exhaustions: 1, backlog_sessions: 1, backlog_age_ms: 100 * 60_000, last_failure: expect.stringContaining('cc-headless'),
    });
    expect(health.status).toBe('warning');
  });
});
