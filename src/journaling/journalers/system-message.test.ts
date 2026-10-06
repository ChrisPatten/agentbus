import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/schema.js';
import { AppConfigSchema } from '../../config/schema.js';
import { runtimeCapabilities } from '../../core/runtime-capabilities.js';
import { resolveJournalingSettings } from '../config.js';
import type { JournalJob } from '../types.js';
import { JournalRunGate, SystemMessageJournaler, type InstructionDelivery } from './system-message.js';

let db: Database.Database;
let dir: string;

const settings = resolveJournalingSettings(AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: {}, memory: {},
  agents: { 'agent:peggy': { journaling: { chain: ['system-message'], prompt: 'Journal now.', 'system-message': { timeout_ms: 200 } } } },
})).get('agent:peggy')!;

function job(overrides: Partial<JournalJob> = {}): JournalJob {
  return {
    runId: 'run-1', kind: 'session', trigger: 'pause', agentId: 'agent:peggy', sessionAgentId: 'agent:peggy-pool-1',
    runtime: 'cc-pool', workingDir: dir, memoryDir: join(dir, 'memory'), sessionId: 's1', conversationId: 'conv-1',
    channel: 'telegram', contactId: 'chris', topic: 'general', claudeSessionId: 'claude-1', harnessSessionId: null,
    harnessTranscriptPath: null, sessionOpen: true,
    window: { cursorAt: null, from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:05:00.000Z', advanceTo: '2026-10-06T10:06:00.000Z' },
    messages: [], humanMessageCount: 2, snapshots: [], prompt: 'Journal now.', model: null, timeoutMs: 1000, settings, ...overrides,
  };
}

const poolRuntime = { agentId: 'agent:peggy', kind: 'cc-pool' as const, poolAgentId: 'agent:peggy', capabilities: runtimeCapabilities('cc-pool') };
let lease: { agent_id: string; state: string; last_turn_ended_at: string | null } | null;

function resolver(live: Partial<Record<'liveAgent' | 'exclusiveSession', boolean>> = {}) {
  return {
    resolve: vi.fn(() => poolRuntime as never),
    checkLive: vi.fn((cap: string) => {
      const ok = live[cap as 'liveAgent'] ?? true;
      return { ok, capability: cap as never, check: 'pane-lease' as const, reason: ok ? 'leased' : 'no pane is leased to this conversation' };
    }),
  };
}

const poolManagers = () => new Map([['agent:peggy', {
  poolId: 'peggy',
  leaseStore: { findByConversation: () => lease },
}]]) as never;

function transcript(id: string, direction: 'inbound' | 'outbound', at: string, meta: Record<string, unknown> = {}, contact = 'chris') {
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, 'conv-1', 's1', ?, 'telegram', ?, ?, 'x', ?)`).run(id, `m-${id}`, at, contact, direction, JSON.stringify(meta));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sysmsg-'));
  mkdirSync(join(dir, 'memory'));
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen) VALUES ('conv-1','chris','telegram','general','x','x')`).run();
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id)
    VALUES ('s1', 'conv-1', 'telegram', 'chris', 'x', 'x', 'agent:peggy-pool-1')`).run();
  lease = { agent_id: 'agent:peggy-pool-1', state: 'leased', last_turn_ended_at: null };
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function make(deliver: InstructionDelivery, gate = new JournalRunGate(), live?: Parameters<typeof resolver>[0]) {
  const withdraw = vi.fn();
  const j = new SystemMessageJournaler({
    db, resolver: resolver(live), gate, deliver, poolManagers: poolManagers(), withdraw,
    owners: { ownerConversations: () => [{ channel: 'telegram', contactId: 'chris', topic: 'general', conversationId: 'conv-owner' }] },
  });
  return { j, gate, withdraw };
}

const okDeliver: InstructionDelivery = async () => ({ queued: true, messageId: 'instr-1', conversationId: 'conv-1' });

describe('SystemMessageJournaler.canJournal (S66.8)', () => {
  it('needs a live, exclusive pane, an open session and no other run', () => {
    const { j, gate } = make(okDeliver);
    expect(j.canJournal(job())).toEqual({ ok: true });
    expect(j.canJournal(job({ sessionOpen: false }))).toMatchObject({ ok: false, reason: expect.stringContaining('closed') });
    expect(make(okDeliver, new JournalRunGate(), { liveAgent: false }).j.canJournal(job())).toMatchObject({ ok: false, reason: expect.stringContaining('liveAgent') });
    void gate.start({ runId: 'other', agentId: 'agent:peggy', recipient: 'agent:peggy-pool-2', startedAt: 'x', conversationId: 'c2', channel: 'telegram', contactId: 'x', topic: 'general' });
    expect(j.canJournal(job())).toMatchObject({ ok: false, reason: expect.stringContaining('already open') });
  });

  it('needs an idle agent: nothing queued and the last human message answered', () => {
    const { j } = make(okDeliver);
    transcript('t1', 'inbound', '2026-10-06T10:00:00.000Z');
    expect(j.canJournal(job())).toMatchObject({ ok: false, reason: expect.stringContaining('not answered') });
    transcript('t2', 'outbound', '2026-10-06T10:01:00.000Z', {}, 'chris');
    expect(j.canJournal(job())).toEqual({ ok: true });
    // A turn-ended hook, once seen, is the authority: a reply without a turn end means still working.
    lease = { ...lease!, last_turn_ended_at: '2026-10-06T09:59:00.000Z' };
    expect(j.canJournal(job())).toMatchObject({ ok: false, reason: expect.stringContaining('still answering') });
    lease = { ...lease!, last_turn_ended_at: '2026-10-06T10:02:00.000Z' };
    expect(j.canJournal(job())).toEqual({ ok: true });
    db.prepare(`INSERT INTO message_queue (id, created_at, updated_at, channel, topic, sender, recipient, priority, status, payload, metadata)
      VALUES ('q1', 'x', 'x', 'telegram', 'general', 'contact:chris', 'agent:peggy-pool-1', 'normal', 'pending', '{}', '{}')`).run();
    expect(j.canJournal(job())).toMatchObject({ ok: false, reason: expect.stringContaining('waiting') });
  });

  it('ignores bus system-only turns when checking the last human message', () => {
    const { j } = make(okDeliver);
    transcript('t1', 'inbound', '2026-10-06T10:00:00.000Z', { system_only: true });
    expect(j.canJournal(job())).toEqual({ ok: true });
  });

  it('sends agent jobs to the default conversation', () => {
    const { j } = make(okDeliver);
    expect(j.target(job({ kind: 'consolidate', conversationId: '' }))).toMatchObject({ conversationId: 'conv-owner', channel: 'telegram', contactId: 'chris' });
  });
});

describe('SystemMessageJournaler.run (S66.8)', () => {
  it('delivers the instruction in a journal block, holds the conversation and finishes on journal_complete', async () => {
    let seenBlock = '';
    const gate = new JournalRunGate();
    const deliver: InstructionDelivery = async (req) => {
      seenBlock = req.block;
      // While the run is open: held messages, blocked sends, the instruction itself passes.
      expect(gate.isHeld({ recipient: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-1' } })).toBe(true);
      expect(gate.isHeld({ recipient: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-1', journal_run_id: 'run-1' } })).toBe(false);
      expect(gate.isHeld({ recipient: 'agent:peggy-pool-2', metadata: { conversation_id: 'conv-2' } })).toBe(false);
      expect(gate.blockedSend('agent:peggy-pool-1')?.runId).toBe('run-1');
      setTimeout(() => {
        writeFileSync(join(dir, 'memory', 'daily.md'), 'today');
        expect(gate.complete({ runId: 'run-1', agentId: 'peggy-pool-1', filesChanged: ['memory/MEMORY.md'], notes: 'Recorded the plan.' })).toEqual({ ok: true, runId: 'run-1' });
      }, 10);
      return { queued: true, messageId: 'instr-1', conversationId: 'conv-1' };
    };
    const { j } = make(deliver, gate);
    const result = await j.run(job());
    expect(result).toEqual({ outcome: 'done', fidelity: 'full-session', filesChanged: ['memory/MEMORY.md', 'memory/daily.md'], notes: 'Recorded the plan.' });
    expect(seenBlock).toMatch(/^<agentbus-system kind="journal" run_id="run-1">/);
    expect(seenBlock).toContain('Journal now.');
    expect(seenBlock).toContain('journal_complete');
    expect(gate.isHeld({ recipient: 'agent:peggy-pool-1', metadata: { conversation_id: 'conv-1' } })).toBe(false);
    expect(gate.blockedSend('agent:peggy-pool-1')).toBeNull();
  });

  it('reports nothing-to-do for nothing_new with no file changes', async () => {
    const gate = new JournalRunGate();
    const { j } = make(async () => {
      setTimeout(() => gate.complete({ runId: 'run-1', agentId: 'agent:peggy-pool-1', nothingNew: true }), 5);
      return { queued: true, messageId: 'i', conversationId: 'conv-1' };
    }, gate);
    expect((await j.run(job())).outcome).toBe('nothing-to-do');
  });

  it('times out with failed-after-start, withdraws a still-queued instruction and rejects a late completion as stale', async () => {
    const { j, gate, withdraw } = make(okDeliver);
    const result = await j.run(job());
    expect(result).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('no journal_complete within 200 ms') });
    expect(withdraw).toHaveBeenCalledWith('instr-1', expect.stringContaining('timed out'));
    expect(gate.complete({ runId: 'run-1', agentId: 'peggy-pool-1' })).toEqual({ ok: false, reason: 'stale_run' });
    expect(gate.complete({ runId: 'nope', agentId: 'peggy-pool-1' })).toEqual({ ok: false, reason: 'unknown_run' });
  });

  it('is failed-before-start when the instruction cannot be delivered, and ends the hold', async () => {
    const { j, gate } = make(async () => ({ queued: false, reason: 'adapter_paused' }));
    expect(await j.run(job())).toMatchObject({ outcome: 'failed-before-start', error: expect.stringContaining('adapter_paused') });
    expect(gate.active()).toEqual([]);
    const misrouted = make(async () => ({ queued: true, messageId: 'i', conversationId: 'conv-other' }));
    expect((await misrouted.j.run(job())).outcome).toBe('failed-before-start');
    expect(misrouted.withdraw).toHaveBeenCalledWith('i', expect.any(String));
  });

  it('stops waiting when the chain runner aborts', async () => {
    const { j } = make(okDeliver);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await j.run(job(), { signal: controller.signal })).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('aborted') });
  });
});

describe('JournalRunGate', () => {
  it('rejects another agent and repeats, and gives one busy notice per hold', () => {
    const gate = new JournalRunGate();
    void gate.start({ runId: 'r', agentId: 'agent:peggy', recipient: 'agent:peggy-pool-1', startedAt: 'x', conversationId: 'c', channel: 'telegram', contactId: 'chris', topic: 'general' });
    expect(gate.complete({ runId: 'r', agentId: 'baxter' })).toEqual({ ok: false, reason: 'wrong_agent' });
    expect(gate.claimNotice('c')?.runId).toBe('r');
    expect(gate.claimNotice('c')).toBeNull();
    expect(gate.complete({ runId: 'r', agentId: 'peggy-pool-1' })).toMatchObject({ ok: true });
    expect(gate.complete({ runId: 'r', agentId: 'peggy-pool-1' })).toEqual({ ok: false, reason: 'already_completed' });
  });
});
