/**
 * E68 S68.5 — end to end on one agent, with a fake LLM behind the real
 * script journaler:
 *
 *   1. `/feedback` in a conversation is recorded (not delivered, no run);
 *   2. the conversation's next journal run gets it (below min_human_messages)
 *      and the fake writes it to the daily journal;
 *   3. consolidation promotes it into a native `feedback` memory and the
 *      MEMORY.md index;
 *   4. the same correction recurs in another conversation after the rule
 *      exists: the next consolidation's recurring-correction check returns a
 *      proposal for CLAUDE.md (script `proposals[]`);
 *   5. the owner approves it through the approval path and the bus applies
 *      it; the protected-path check doesn't flag the bus's own write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { OwnerDirectory } from '../core/owners.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { ApprovalStore } from '../approvals/store.js';
import { resolveApproval } from '../approvals/resolve.js';
import type { ApprovalRequest } from '../approvals/types.js';
import { createFeedbackCommand, FEEDBACK_ACK } from '../commands/feedback.js';
import type { SlashCommandContext } from '../commands/registry.js';
import { JournalEngine } from '../journaling/engine.js';
import { JournalerRegistry } from '../journaling/registry.js';
import { ScriptJournaler } from '../journaling/journalers/script.js';
import { recordApprovalOutcome } from '../journaling/feedback-producers.js';
import { ProtectedPathMonitor, PROTECTED_CHANGE_CONDITION } from './monitor.js';
import { ProposalService, SELF_EDIT_ADAPTER } from './proposals.js';

/** The fake LLM: a script journaler that reads the payload and edits memory like a model would. */
const FAKE_LLM = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
const mem = p.memory_dir;
const daily = path.join(mem, 'daily');
fs.mkdirSync(daily, { recursive: true });
const memoryFile = path.join(mem, 'feedback_24-hour-time.md');
if (p.kind === 'session') {
  const lines = p.feedback.filter((f) => f.kind === 'user-feedback').map((f) => '- Correction from ' + f.contact_id + ': ' + f.text);
  if (lines.length === 0) process.exit(3);
  fs.appendFileSync(path.join(daily, '2026-10-06.md'), '## ' + p.conversation_id.slice(0, 8) + '\n' + lines.join('\n') + '\n');
  console.log(JSON.stringify({ notes: 'recorded ' + lines.length + ' correction(s)', files_changed: ['memory/daily/2026-10-06.md'] }));
  process.exit(0);
}
// consolidate
const recurring = (p.consolidation.feedback && p.consolidation.feedback.recurring) || [];
const timeFeedback = recurring.find((r) => /24-hour/i.test(r.text));
if (!timeFeedback) process.exit(3);
const out = { notes: '', proposals: [] };
if (!fs.existsSync(memoryFile)) {
  fs.writeFileSync(memoryFile, '---\nname: 24-hour time\ndescription: Chris wants times in 24-hour format\ntype: feedback\n---\n\nUse 24-hour time when listing meetings.\nFirst asked: ' + timeFeedback.first_at + '\n');
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# Memory\n\n- [24-hour time](feedback_24-hour-time.md): Chris wants 24-hour times\n');
  out.notes = 'promoted the 24-hour time correction';
} else {
  // Recurring-correction check: the rule exists, yet the correction came back.
  fs.appendFileSync(memoryFile, 'Recurred: ' + timeFeedback.last_at + ' (rule already existed)\n');
  out.notes = 'flagged a recurring correction';
  out.proposals.push({
    path: 'CLAUDE.md',
    diff: '@@ -2,1 +2,2 @@\n - Be brief.\n+- Always use 24-hour time (14:00, not 2pm), in every list of times.',
    rationale: 'Chris corrected the time format again after the feedback memory was added; make it a standing rule.',
    evidence: [timeFeedback.first_at, timeFeedback.last_at],
  });
}
console.log(JSON.stringify(out));
`;

let dir: string;
let db: Database.Database;
let clock: number;

const convA = computeConversationId('chris', 'telegram', 'general');
const convB = computeConversationId('chris', 'telegram', 'trip');

function makeConfig(): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 1 } } } },
    adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'You are Baxter.', working_dir: dir } },
    memory: {},
    agents: {
      'agent:baxter': {
        owners: [{ channel: 'telegram', contact_id: 'chris' }],
        journaling: { chain: ['script'], min_human_messages: 2, script: { command: join(dir, 'fake-llm.cjs') } },
      },
    },
  });
}

function session(id: string, conversationId: string, topic: string) {
  const started = new Date(clock - 60 * 60_000).toISOString();
  db.prepare(`INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen) VALUES (?, 'chris', 'telegram', ?, ?, ?)`)
    .run(conversationId, topic, started, started);
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id)
    VALUES (?, ?, 'telegram', 'chris', ?, ?, 'agent:baxter')`).run(id, conversationId, started, started);
}

let seq = 0;
function message(sessionId: string, conversationId: string, minAgo: number, direction: 'inbound' | 'outbound', body: string) {
  seq += 1;
  const at = new Date(clock - minAgo * 60_000).toISOString();
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, ?, ?, ?, 'telegram', 'chris', ?, ?, '{}')`).run(`t${seq}`, `m${seq}`, conversationId, sessionId, at, direction, body);
  if (direction === 'inbound') db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(at, sessionId);
}

const ctx = (topic: string, argsRaw: string, config: AppConfig): SlashCommandContext => ({
  channel: 'telegram', sender: 'contact:chris', adapterId: 'telegram', argsRaw,
  envelope: { id: `e${seq}`, timestamp: '', channel: 'telegram', topic, sender: 'contact:chris', recipient: '', reply_to: null, priority: 'normal', payload: { type: 'text', body: `/feedback ${argsRaw}` }, metadata: {} },
  db: db as never, config,
} as SlashCommandContext);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-learning-e2e-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# Baxter\n- Be brief.\n');
  writeFileSync(join(dir, 'fake-llm.cjs'), FAKE_LLM);
  chmodSync(join(dir, 'fake-llm.cjs'), 0o755);
  db = new Database(':memory:');
  runMigrations(db);
  clock = Date.UTC(2026, 9, 6, 12, 0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('agent learning end to end (E68 S68.5)', { timeout: 60_000 }, () => {
  it('/feedback → journal → feedback memory → recurring correction → approved CLAUDE.md change', async () => {
    const config = makeConfig();
    const resolver = new RuntimeResolver(config);
    const owners = new OwnerDirectory(config);
    const raise = vi.fn();
    const advisories = { raise, resolve: vi.fn() };
    const monitor = new ProtectedPathMonitor({ config, resolver, advisories: advisories as never, log: () => {} });
    const approvals = new ApprovalStore(db);
    const dispatched: Array<{ request: ApprovalRequest; channel: string }> = [];
    const proposals = new ProposalService({
      db, owners, protectedPaths: monitor, approvals, now: () => new Date(clock), log: () => {},
      dispatch: async (request, channel) => { dispatched.push({ request, channel }); approvals.updateNotify(request.id, channel, '1:100'); },
    });
    const registry = new JournalerRegistry();
    registry.register(new ScriptJournaler({ basePath: process.env['PATH'], home: dir, log: () => {} }));
    const engine = new JournalEngine({
      db, config, resolver, registry, owners, advisories: advisories as never, protectedPaths: monitor, proposals,
      now: () => new Date(clock), log: () => {},
    });
    const feedbackCmd = createFeedbackCommand({ db, engine });

    // 1. A conversation with one human message (below min_human_messages) and a reply, then /feedback.
    session('s1', convA, 'general');
    message('s1', convA, 30, 'inbound', 'What is on tomorrow?');
    message('s1', convA, 29, 'outbound', 'Standup at 9am, review at 2pm.');
    expect((await feedbackCmd.handler([], ctx('general', 'Use 24-hour time when you list my meetings.', config))).body).toBe(FEEDBACK_ACK);
    expect(engine.store.listRuns({ agentId: 'agent:baxter' })).toHaveLength(0);

    // 2. The next journal run gets the feedback and journals despite one human message.
    clock += 31 * 60_000;
    const first = await engine.trigger({ reason: 'pause', sessionId: 's1' }).done;
    expect(first.status).toBe('journaled');
    expect(readFileSync(join(dir, 'memory/daily/2026-10-06.md'), 'utf-8')).toContain('Correction from chris: Use 24-hour time when you list my meetings.');
    expect(engine.feedback.pendingForConversation(convA)).toHaveLength(0);

    // 3. Consolidation promotes it into a native feedback memory.
    clock += 60 * 60_000;
    expect((await engine.consolidate('baxter', 'scheduled').done).status).toBe('journaled');
    const memory = readFileSync(join(dir, 'memory/feedback_24-hour-time.md'), 'utf-8');
    expect(memory).toMatch(/^---\nname: 24-hour time\n/);
    expect(memory).toContain('type: feedback');
    expect(readFileSync(join(dir, 'memory/MEMORY.md'), 'utf-8')).toContain('(feedback_24-hour-time.md)');
    expect(engine.store.listRuns({ agentId: 'agent:baxter' }).filter((r) => r.kind === 'consolidate')).toHaveLength(1);
    expect(proposals.list()).toHaveLength(0);
    // Nothing new since: the next scheduled pass is skipped.
    clock += 60_000;
    expect((await engine.consolidate('baxter', 'scheduled').done).status).toBe('nothing');

    // 4. The correction comes back in another conversation, after the rule exists.
    clock += 24 * 60 * 60_000;
    session('s2', convB, 'trip');
    message('s2', convB, 20, 'inbound', 'When do we land?');
    message('s2', convB, 19, 'outbound', 'You land at 6:30pm.');
    await feedbackCmd.handler([], ctx('trip', 'use 24-hour time.', config));
    clock += 31 * 60_000;
    expect((await engine.trigger({ reason: 'pause', sessionId: 's2' }).done).status).toBe('journaled');
    clock += 60 * 60_000;
    const second = await engine.consolidate('baxter', 'scheduled').done;
    expect(second.status).toBe('journaled');
    expect(readFileSync(join(dir, 'memory/feedback_24-hour-time.md'), 'utf-8')).toContain('rule already existed');
    // The proposal goes to the owner (submitted in the background).
    for (let i = 0; i < 20 && proposals.list().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const [proposal] = proposals.list();
    expect(proposal).toMatchObject({ agent_id: 'agent:baxter', path: 'CLAUDE.md', status: 'pending', source: 'script', run_id: second.summary!.runId });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ channel: 'telegram', request: { adapter_id: SELF_EDIT_ADAPTER, contact_id: 'chris' } });
    expect(JSON.parse(dispatched[0]!.request.raw_context!).details).toContain('+- Always use 24-hour time');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Baxter\n- Be brief.\n');

    // 5. The owner approves; the bus applies it, and the next run's protected-path check stays quiet.
    const out = await resolveApproval({
      store: approvals, poolManagers: new Map(),
      backends: { [SELF_EDIT_ADAPTER]: (r, d) => proposals.decide(r, d) },
      onResolved: (r, s) => recordApprovalOutcome({ db, feedback: engine.feedback, logicalAgentId: (id) => owners.logicalAgentId(id) }, r, s),
    }, dispatched[0]!.request.id, 'approve', 'contact:chris', new Date(clock), 'chris');
    expect(out.outcome).toBe('approved');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Baxter\n- Be brief.\n- Always use 24-hour time (14:00, not 2pm), in every list of times.\n');
    expect(proposals.get(proposal!.id)!.status).toBe('applied');
    await engine.consolidate('baxter', 'manual').done;
    expect(raise.mock.calls.filter(([a]) => (a as { conditionKey: string }).conditionKey === PROTECTED_CHANGE_CONDITION)).toHaveLength(0);
    expect(readdirSync(join(dir, 'memory')).sort()).toEqual(['MEMORY.md', 'daily', 'feedback_24-hour-time.md']);
    expect(existsSync(join(dir, 'memory/archive'))).toBe(false);
  });
});
