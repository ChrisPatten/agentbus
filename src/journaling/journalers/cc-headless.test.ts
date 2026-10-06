import { describe, it, expect, vi } from 'vitest';
import { AppConfigSchema } from '../../config/schema.js';
import { resolveJournalingSettings } from '../config.js';
import type { RunProcessOptions, RunProcessResult } from '../process.js';
import type { JournalJob } from '../types.js';
import { CcHeadlessJournaler, NOTHING_TO_RECORD, parseClaudeJsonResult } from './cc-headless.js';

const settings = resolveJournalingSettings(AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: {}, memory: {},
  agents: { 'agent:peggy': { journaling: { chain: ['cc-headless'], prompt: 'Journal now.', 'cc-headless': { model: 'claude-haiku-4-5' } } } },
})).get('agent:peggy')!;

function job(overrides: Partial<JournalJob> = {}): JournalJob {
  return {
    runId: 'run-1', kind: 'session', trigger: 'pause', agentId: 'agent:peggy', sessionAgentId: 'agent:peggy-pool-1',
    runtime: 'cc-pool', workingDir: '/agents/peggy', memoryDir: '/agents/peggy/memory', sessionId: 's1', conversationId: 'conv-1',
    channel: 'telegram', contactId: 'chris', topic: null, claudeSessionId: 'claude-1', harnessSessionId: null,
    harnessTranscriptPath: null, sessionOpen: true,
    window: { cursorAt: null, from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:05:00.000Z', advanceTo: '2026-10-06T10:06:00.000Z' },
    messages: [], humanMessageCount: 2,
    snapshots: [{ id: 'snap-1', event: 'pre-compact', path: '/agents/peggy/snap.jsonl', created_at: '2026-10-06T10:04:00.000Z' }],
    prompt: 'journal', model: null, timeoutMs: 1000, settings, ...overrides,
  };
}

const poolRuntime = {
  agentId: 'agent:peggy-pool-1', kind: 'cc-pool' as const, poolAgentId: 'agent:peggy', workingDir: '/agents/peggy',
  pool: { claude_bin: '/usr/local/bin/claude', pane_env: { EXTRA: '1' } },
};

function resolver(liveOk = true) {
  return {
    checkLive: vi.fn(() => ({ ok: liveOk, capability: 'sessionResume' as const, check: 'transcript' as const, reason: liveOk ? 'on disk' : 'transcript claude-1 is missing' })),
    resolve: vi.fn(() => poolRuntime as never),
  };
}

const proc = (over: Partial<RunProcessResult> = {}): RunProcessResult => ({
  code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: null, durationMs: 10, ...over,
});

const resultJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', is_error: false, result: 'Updated the daily journal.', session_id: 'fork-1', total_cost_usd: 0.04,
  usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }, ...over,
});

describe('CcHeadlessJournaler.canJournal (S66.6)', () => {
  it('needs a Claude session, a runtime with transcripts, a running instance, and the transcript on disk', () => {
    const j = new CcHeadlessJournaler({ resolver: resolver() });
    expect(j.canJournal(job())).toEqual({ ok: true });
    expect(j.canJournal(job({ claudeSessionId: null }))).toMatchObject({ ok: false });
    expect(j.canJournal(job({ runtime: 'claude-code' }))).toMatchObject({ ok: false });
    const headless = job({ runtime: 'cc-headless', agentId: 'agent:baxter', sessionAgentId: 'agent:baxter' });
    expect(j.canJournal(headless)).toMatchObject({ ok: false, reason: expect.stringContaining('not running') });
    j.addHandle('agent:baxter', { journalSession: vi.fn() });
    expect(j.canJournal(headless)).toEqual({ ok: true });
    const missing = new CcHeadlessJournaler({ resolver: resolver(false) });
    expect(missing.canJournal(job())).toEqual({ ok: false, reason: 'transcript claude-1 is missing' });
  });

  it('checks the transcript for the pane the session belongs to', () => {
    const r = resolver();
    new CcHeadlessJournaler({ resolver: r }).canJournal(job());
    expect(r.checkLive).toHaveBeenCalledWith('sessionResume', { agentId: 'agent:peggy-pool-1', claudeSessionId: 'claude-1' });
  });
});

describe('CcHeadlessJournaler on cc-headless (through the instance handle)', () => {
  const headless = () => job({ runtime: 'cc-headless', agentId: 'agent:baxter', sessionAgentId: 'agent:baxter' });

  it('passes the journaler model, timeout, abort signal and a prompt with the job context', async () => {
    const journalSession = vi.fn().mockResolvedValue({ error: null, costUsd: 0.02, inputTokens: 10, outputTokens: 5, resultText: 'Recorded the plan.' });
    const j = new CcHeadlessJournaler({ resolver: resolver() });
    j.addHandle('agent:baxter', { journalSession });
    const controller = new AbortController();
    const result = await j.run(headless(), { signal: controller.signal });
    expect(result).toMatchObject({ outcome: 'done', fidelity: 'full-session', costUsd: 0.02, inputTokens: 10, outputTokens: 5, notes: 'Recorded the plan.' });
    const req = journalSession.mock.calls[0]![0];
    expect(req).toMatchObject({ conversationId: 'conv-1', claudeSessionId: 'claude-1', model: 'claude-haiku-4-5', timeoutMs: 1000, signal: controller.signal });
    expect(req.prompt).toContain('Journal now.');
    expect(req.prompt).toContain('2 message(s) from people');
    expect(req.prompt).toContain('/agents/peggy/snap.jsonl');
    expect(req.prompt).toContain(NOTHING_TO_RECORD);
  });

  it('maps NOTHING_TO_RECORD, errors and timeouts', async () => {
    const journalSession = vi.fn()
      .mockResolvedValueOnce({ error: null, costUsd: 0.01, inputTokens: 1, outputTokens: 1, resultText: `Nothing new.\n${NOTHING_TO_RECORD}` })
      .mockResolvedValueOnce({ error: 'spawn failed: ENOENT', costUsd: null, inputTokens: null, outputTokens: null })
      .mockResolvedValueOnce({ error: 'journaling turn timed out after 1000 ms; process group killed', timedOut: true, costUsd: null, inputTokens: null, outputTokens: null })
      .mockResolvedValueOnce({ error: 'exit code 1', costUsd: 0.01, inputTokens: null, outputTokens: null });
    const j = new CcHeadlessJournaler({ resolver: resolver() });
    j.addHandle('agent:baxter', { journalSession });
    expect((await j.run(headless())).outcome).toBe('nothing-to-do');
    expect((await j.run(headless())).outcome).toBe('failed-before-start');
    expect(await j.run(headless())).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('timed out') });
    expect(await j.run(headless())).toMatchObject({ outcome: 'failed-after-start', costUsd: 0.01 });
  });
});

describe('CcHeadlessJournaler on cc-pool (direct claude -p)', () => {
  it('forks the pane session in the pool working dir with the model, no MCP servers and a scrubbed env', async () => {
    const runProcess = vi.fn(async (_o: RunProcessOptions) => proc({ stdout: resultJson() }));
    const j = new CcHeadlessJournaler({
      resolver: resolver(), runProcess,
      env: () => ({ PATH: '/bin', HOME: '/home/me', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', TMUX: '/tmp/t' }),
    });
    const controller = new AbortController();
    const result = await j.run(job(), { signal: controller.signal });
    expect(result).toMatchObject({ outcome: 'done', fidelity: 'full-session', costUsd: 0.04, inputTokens: 1000, outputTokens: 50 });
    const opts = runProcess.mock.calls[0]![0];
    expect(opts.command).toBe('/usr/local/bin/claude');
    expect(opts.cwd).toBe('/agents/peggy');
    expect(opts.timeoutMs).toBe(1000);
    expect(opts.signal).toBe(controller.signal);
    const args = opts.args.join(' ');
    expect(args).toContain('--resume claude-1 --fork-session');
    expect(args).toContain('--output-format json');
    expect(args).toContain('--model claude-haiku-4-5');
    expect(args).toContain('--strict-mcp-config');
    expect(opts.env).toEqual({ PATH: '/bin', HOME: '/home/me', EXTRA: '1' });
  });

  it('reports spawn failures, timeouts, CLI errors and nothing-to-do', async () => {
    const runProcess = vi.fn()
      .mockResolvedValueOnce(proc({ code: null, spawnError: 'ENOENT' }))
      .mockResolvedValueOnce(proc({ code: null, signal: 'SIGTERM', timedOut: true }))
      .mockResolvedValueOnce(proc({ code: 1, stdout: resultJson({ is_error: true, result: 'Session not found' }) }))
      .mockResolvedValueOnce(proc({ code: 1, stderr: 'boom' }))
      .mockResolvedValueOnce(proc({ stdout: resultJson({ result: `Nothing worth keeping. ${NOTHING_TO_RECORD}` }) }));
    const j = new CcHeadlessJournaler({ resolver: resolver(), runProcess, env: () => ({}) });
    expect((await j.run(job())).outcome).toBe('failed-before-start');
    expect(await j.run(job())).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('process group killed') });
    expect(await j.run(job())).toMatchObject({ outcome: 'failed-after-start', error: 'Session not found' });
    expect(await j.run(job())).toMatchObject({ outcome: 'failed-after-start', error: 'boom' });
    expect((await j.run(job())).outcome).toBe('nothing-to-do');
  });
});

describe('parseClaudeJsonResult', () => {
  it('reads the result object, summing cache tokens into input tokens', () => {
    expect(parseClaudeJsonResult(resultJson())).toMatchObject({ isError: false, costUsd: 0.04, inputTokens: 1000, outputTokens: 50, sessionId: 'fork-1' });
    expect(parseClaudeJsonResult(`noise\n${resultJson({ total_cost_usd: 1 })}`)).toMatchObject({ costUsd: 1 });
    expect(parseClaudeJsonResult('')).toBeNull();
    expect(parseClaudeJsonResult('not json')).toBeNull();
  });
});
