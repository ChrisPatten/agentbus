import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { createFeedbackCommand, FEEDBACK_ACK, FEEDBACK_USAGE } from '../commands/feedback.js';
import type { SlashCommandContext } from '../commands/registry.js';
import type { ApprovalRequest } from '../approvals/types.js';
import { FeedbackStore, latestAgentMessageId } from './feedback.js';
import { deniedApprovalFeedback, recordApprovalOutcome, recordDeliveryFailure, recordToolError } from './feedback-producers.js';
import { assessEligibility } from './eligibility.js';
import { feedbackLines, feedbackSummaryLines } from './prompt.js';
import { buildScriptPayload } from './journalers/script.js';
import { JournalEngine } from './engine.js';
import { JournalerRegistry } from './registry.js';
import type { Journaler, JournalJob, JournalOutcome } from './types.js';

const MIN = 60_000;
let db: Database.Database;
let clock: number;
const conv = computeConversationId('chris', 'telegram', 'general');

const config = AppConfigSchema.parse({
  bus: { db_path: ':memory:' },
  adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'x' } },
  memory: {},
  agents: { 'agent:baxter': { journaling: { chain: ['cc-headless'], threshold_ms: 10 * MIN } } },
});

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clock = Date.UTC(2026, 9, 6, 12, 0);
});

function session(id = 's1') {
  const started = new Date(clock - 120 * MIN).toISOString();
  db.prepare(`INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity, agent_id, claude_session_id)
    VALUES (?, ?, 'telegram', 'chris', ?, ?, 'agent:baxter', 'claude-1')`).run(id, conv, started, started);
}

let seq = 0;
function msg(minAgo: number, opts: { dir?: 'inbound' | 'outbound'; body?: string; meta?: Record<string, unknown> } = {}) {
  seq += 1;
  const at = new Date(clock - minAgo * MIN).toISOString();
  const dir = opts.dir ?? 'inbound';
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES (?, ?, ?, 's1', ?, 'telegram', 'chris', ?, ?, json(?))`)
    .run(`t${seq}`, `m${seq}`, conv, at, dir, opts.body ?? `message ${seq}`, JSON.stringify(opts.meta ?? {}));
  if (dir === 'inbound') db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ? AND last_activity < ?').run(at, 's1', at);
  return `m${seq}`;
}

function journaler(outcome: JournalOutcome = 'done') {
  const jobs: JournalJob[] = [];
  const j: Journaler & { jobs: JournalJob[] } = {
    id: 'cc-headless', requires: [], supportsKinds: ['session', 'consolidate'], jobs,
    canJournal: () => ({ ok: true }),
    run: vi.fn(async (job: JournalJob) => { jobs.push(job); return { outcome }; }),
  };
  return j;
}

function engineWith(j: Journaler) {
  const registry = new JournalerRegistry();
  registry.register(j);
  return new JournalEngine({ db, config, resolver: new RuntimeResolver(config), registry, now: () => new Date(clock), log: () => {} });
}

async function settle(engine: JournalEngine) {
  engine.tick();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('FeedbackStore (S68.2)', () => {
  it('records, lists pending per conversation, consumes and summarizes', () => {
    const store = new FeedbackStore(db, () => new Date(clock));
    const listener = vi.fn();
    store.onRecorded(listener);
    const a = store.record({ agentId: 'baxter', kind: 'user-feedback', text: '  Use 24-hour time.  ', conversationId: conv, contactId: 'contact:chris' });
    clock += MIN;
    store.record({ agentId: 'agent:baxter', kind: 'user-feedback', text: 'use 24-hour   time.', conversationId: 'other' });
    clock += MIN;
    store.record({ agentId: 'agent:baxter', kind: 'tool-error', text: 'Tool Bash failed', conversationId: conv });
    expect(a).toMatchObject({ agent_id: 'agent:baxter', text: 'Use 24-hour time.', contact_id: 'chris' });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.pendingForConversation(conv).map((r) => r.kind)).toEqual(['user-feedback', 'tool-error']);
    expect(store.latestBypass(conv)).toBe(a.created_at);
    store.consume([a.id], 'run-1');
    expect(store.pendingForConversation(conv)).toHaveLength(1);
    expect(store.latestBypass(conv)).toBeNull();

    const summary = store.summary('baxter', null);
    expect(summary.counts).toEqual({ 'user-feedback': 2, 'denied-approval': 0, 'tool-error': 1, 'lapsed-proposal': 0 });
    expect(summary.recurring[0]).toMatchObject({ kind: 'user-feedback', count: 2, conversations: 2 });
    expect(store.summary('baxter', new Date(clock - 30_000).toISOString()).counts['tool-error']).toBe(1);
    expect(store.summary('baxter', new Date(clock).toISOString()).counts['tool-error']).toBe(0);
  });

  it('truncates long text and sweeps after 90 days', () => {
    const store = new FeedbackStore(db, () => new Date(clock));
    expect(store.record({ agentId: 'baxter', kind: 'tool-error', text: 'x'.repeat(5000) }).text).toHaveLength(2000);
    clock += 91 * 86_400_000;
    expect(store.sweep()).toBe(1);
  });

  it('finds the latest agent message, ignoring command responses', () => {
    session();
    const reply = msg(10, { dir: 'outbound' });
    msg(5, { dir: 'outbound', meta: { command_response: true } });
    expect(latestAgentMessageId(db, conv)).toBe(reply);
    expect(latestAgentMessageId(db, 'nope')).toBeNull();
  });
});

describe('feedback producers (S68.2)', () => {
  const deps = () => ({ db, feedback: new FeedbackStore(db, () => new Date(clock)), logicalAgentId: (id: string) => (id.includes('peggy') ? 'agent:peggy' : `agent:${id.replace(/^agent:/, '')}`) });
  const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id: 'a1', adapter_id: 'cc-pool', agent_id: 'peggy-pool-1', conversation_id: conv, contact_id: 'chris', tool_name: 'Bash',
    summary: 'rm -rf build', raw_context: null, status: 'denied', requested_at: '', resolved_at: '', resolved_by: 'contact:chris',
    notify_channel: null, notify_message_id: null, expires_at: '', ...over,
  });

  it('records denied approvals (pane ids map to the pool) and ignores approvals', () => {
    const d = deps();
    session();
    const ref = msg(3, { dir: 'outbound' });
    expect(deniedApprovalFeedback(d, approval())).toMatchObject({
      agentId: 'agent:peggy', kind: 'denied-approval', text: 'Denied Bash: rm -rf build', conversationId: conv, refMessageId: ref, contactId: 'chris',
    });
    recordApprovalOutcome(d, approval(), 'approved');
    expect(d.feedback.list()).toHaveLength(0);
    recordApprovalOutcome(d, approval(), 'denied');
    expect(d.feedback.list()[0]).toMatchObject({ kind: 'denied-approval', agent_id: 'agent:peggy' });
  });

  it('records tool errors and delivery failures of agent messages only', () => {
    const d = deps();
    recordToolError(d, { agentId: 'agent:baxter', conversationId: conv, sessionId: 's1', toolName: 'Bash', error: 'exit 1', delivery: false });
    const env = (sender: string, metadata: Record<string, unknown> = {}) => ({
      id: 'e1', timestamp: '', channel: 'telegram', topic: 'general', sender, recipient: 'contact:chris', reply_to: null,
      priority: 'normal' as const, payload: { type: 'text' as const, body: 'hi' }, metadata,
    });
    recordDeliveryFailure(d, env('agent:baxter', { conversation_id: conv }), 'chat not found');
    recordDeliveryFailure(d, env('system:bus'), 'x');
    recordDeliveryFailure(d, env('agent:baxter', { bus_notice: true }), 'x');
    const rows = d.feedback.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.text)).toEqual(expect.arrayContaining([
      'Tool Bash failed: exit 1', 'Message to chris on telegram could not be delivered: chat not found',
    ]));
    expect(rows.every((r) => r.kind === 'tool-error' && r.conversation_id === conv)).toBe(true);
  });
});

describe('/feedback (S68.2)', () => {
  const ctx = (argsRaw: string): SlashCommandContext => ({
    channel: 'telegram', sender: 'contact:chris', adapterId: 'telegram', argsRaw,
    envelope: { id: 'e', timestamp: '', channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient: '', reply_to: null, priority: 'normal', payload: { type: 'text', body: `/feedback ${argsRaw}` }, metadata: {} },
    db: db as never, config,
  } as SlashCommandContext);

  it('acknowledges, records a user-feedback event about the last agent message, and starts no run', async () => {
    session();
    const ref = msg(2, { dir: 'outbound', body: 'Your 3pm meeting…' });
    const j = journaler();
    const engine = engineWith(j);
    const cmd = createFeedbackCommand({ db, engine });
    expect((await cmd.handler([], ctx('Use 24-hour time.'))).body).toBe(FEEDBACK_ACK);
    expect(engine.feedback.list()[0]).toMatchObject({
      kind: 'user-feedback', agent_id: 'agent:baxter', conversation_id: conv, session_id: 's1', ref_message_id: ref, contact_id: 'chris', text: 'Use 24-hour time.',
    });
    expect(j.jobs).toHaveLength(0);
    expect((await cmd.handler([], ctx('   '))).body).toBe(FEEDBACK_USAGE);
  });
});

describe('feedback in eligibility and journal runs (S68.2)', () => {
  it('assessEligibility: feedback bypasses min_human_messages, even with no human message', () => {
    const now = new Date(clock);
    expect(assessEligibility({ humanTimes: [] }, { minHumanMessages: 2, trigger: 'pause', now, feedback: true })).toMatchObject({ kind: 'eligible', reason: 'feedback' });
    expect(assessEligibility({ humanTimes: [now.toISOString()] }, { minHumanMessages: 2, trigger: 'pause', now, feedback: true })).toMatchObject({ kind: 'eligible', reason: 'feedback' });
    expect(assessEligibility({ humanTimes: [now.toISOString()] }, { minHumanMessages: 2, trigger: 'pause', now })).toMatchObject({ kind: 'pending' });
  });

  it('a /feedback below min_human_messages journals at the next pause with feedback[], then is consumed', async () => {
    session();
    msg(30);
    msg(29, { dir: 'outbound' });
    const j = journaler();
    const engine = engineWith(j);
    engine.feedback.record({ agentId: 'baxter', kind: 'user-feedback', text: 'Use 24-hour time.', conversationId: conv, contactId: 'chris' });
    // The feedback re-anchors the pause clock: nothing yet.
    await settle(engine);
    expect(j.jobs).toHaveLength(0);
    clock += 11 * MIN;
    await settle(engine);
    expect(j.jobs).toHaveLength(1);
    expect(j.jobs[0]!.humanMessageCount).toBe(1);
    expect(j.jobs[0]!.feedback).toEqual([expect.objectContaining({ kind: 'user-feedback', text: 'Use 24-hour time.', contact_id: 'chris' })]);
    expect(j.jobs[0]!.prompt).toBeDefined();
    expect(engine.feedback.pendingForConversation(conv)).toHaveLength(0);
    clock += 11 * MIN;
    await settle(engine);
    expect(j.jobs).toHaveLength(1);
  });

  it('a denied approval after the session was journaled re-opens it; tool errors alone do not', async () => {
    session();
    msg(40); msg(39); msg(38, { dir: 'outbound' });
    const j = journaler();
    const engine = engineWith(j);
    await settle(engine);
    expect(j.jobs).toHaveLength(1);
    engine.feedback.record({ agentId: 'baxter', kind: 'tool-error', text: 'Bash failed', conversationId: conv });
    clock += 11 * MIN;
    await settle(engine);
    expect(j.jobs).toHaveLength(1);
    engine.feedback.record({ agentId: 'baxter', kind: 'denied-approval', text: 'Denied Bash: rm', conversationId: conv });
    clock += 11 * MIN;
    await settle(engine);
    expect(j.jobs).toHaveLength(2);
    expect(j.jobs[1]!.humanMessageCount).toBe(0);
    expect(j.jobs[1]!.feedback!.map((f) => f.kind)).toEqual(['tool-error', 'denied-approval']);
  });

  it('keeps feedback when the chain is exhausted', async () => {
    session();
    msg(30); msg(29);
    const j = journaler('failed-after-start');
    const engine = engineWith(j);
    engine.feedback.record({ agentId: 'baxter', kind: 'user-feedback', text: 'x', conversationId: conv });
    clock += 11 * MIN;
    await settle(engine);
    expect(j.jobs).toHaveLength(1);
    expect(engine.feedback.pendingForConversation(conv)).toHaveLength(1);
  });

  it('feeds prompts and the script payload; consolidation gets cross-conversation counts', async () => {
    const lines = feedbackLines([{ id: 'f1', kind: 'user-feedback', created_at: 't', text: 'Say "hi"', ref_message_id: 'm9', contact_id: 'chris', detail: null }]);
    expect(lines.join('\n')).toContain('feedback from a person (/feedback) from chris, about your message m9: "Say \\"hi\\""');
    expect(feedbackSummaryLines({ since: null, counts: { 'user-feedback': 0, 'denied-approval': 0, 'tool-error': 0, 'lapsed-proposal': 0 }, recurring: [] })).toEqual(['Feedback signals since the last pass: none.']);

    const j = journaler();
    const engine = engineWith(j);
    engine.feedback.record({ agentId: 'baxter', kind: 'user-feedback', text: 'Use 24-hour time.', conversationId: conv });
    engine.feedback.record({ agentId: 'baxter', kind: 'user-feedback', text: 'Use 24-hour time.', conversationId: 'c2' });
    await engine.consolidate('baxter', 'manual').done;
    const job = j.jobs[0]!;
    expect(job.consolidation?.feedback?.recurring[0]).toMatchObject({ count: 2, conversations: 2 });
    expect(job.prompt).toContain('2× in 2 conversation(s)');
    expect(buildScriptPayload(job).consolidation?.feedback?.counts['user-feedback']).toBe(2);
    expect(buildScriptPayload({ ...job, kind: 'session', consolidation: undefined, feedback: [] }).feedback).toEqual([]);
  });
});
