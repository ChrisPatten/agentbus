import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema } from '../../config/schema.js';
import { resolveJournalingSettings } from '../config.js';
import type { JournalJob } from '../types.js';
import { buildScriptPayload, parseScriptOutput, ScriptJournaler } from './script.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'script-journaler-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeScript(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

function settingsFor(script: Record<string, unknown>) {
  return resolveJournalingSettings(AppConfigSchema.parse({
    bus: { db_path: ':memory:' }, adapters: {}, memory: {},
    agents: { 'agent:peggy': { journaling: { chain: ['script'], model: 'claude-haiku-4-5', script } } },
  })).get('agent:peggy')!;
}

function job(script: Record<string, unknown>, overrides: Partial<JournalJob> = {}): JournalJob {
  return {
    runId: 'run-1', kind: 'session', trigger: 'pause', agentId: 'agent:peggy', sessionAgentId: 'agent:peggy',
    runtime: 'claude-code', workingDir: dir, memoryDir: join(dir, 'memory'), sessionId: 's1', conversationId: 'conv-1',
    channel: 'telegram', contactId: 'chris', topic: 'general', claudeSessionId: null, harnessSessionId: null,
    harnessTranscriptPath: null, sessionOpen: true,
    window: { cursorAt: null, from: '2026-10-06T10:00:00.000Z', to: '2026-10-06T10:05:00.000Z', advanceTo: '2026-10-06T10:06:00.000Z' },
    messages: [{
      id: 't1', message_id: 'm1', created_at: '2026-10-06T10:00:00.000Z', direction: 'inbound',
      author: { id: 'chris', is_human: true, is_owner: true, is_agent: false },
      body: '$(rm -rf ~) hello', attachments: [{ type: 'image', path: '/tmp/a.png', mime_type: 'image/png' }], scheduled: false, context: false,
    }],
    humanMessageCount: 1, snapshots: [], prompt: 'Journal it.', model: 'claude-haiku-4-5', timeoutMs: 5000,
    settings: settingsFor(script), ...overrides,
  };
}

const journaler = () => new ScriptJournaler({ busUrl: 'http://127.0.0.1:3000', basePath: process.env['PATH'], home: dir, log: () => {} });

describe('ScriptJournaler (S66.7)', () => {
  it('feeds the version 1 payload on stdin, runs in the working dir and gives only the minimal environment', async () => {
    const cmd = writeScript('dump.sh', `cat > "${dir}/payload.json"; pwd > "${dir}/cwd.txt"; env | sort > "${dir}/env.txt"; echo '{"files_changed":["memory/daily/x.md"],"notes":"ok","cost_usd":0.01}'`);
    process.env['AGENTBUS_TEST_SECRET'] = 'leak';
    try {
      const result = await journaler().run(job({ command: cmd, env: { EXTRA: 'yes' } }));
      expect(result).toMatchObject({ outcome: 'done', fidelity: 'bus-transcript', filesChanged: ['memory/daily/x.md'], notes: 'ok', costUsd: 0.01 });
    } finally {
      delete process.env['AGENTBUS_TEST_SECRET'];
    }
    const payload = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf-8'));
    expect(payload).toMatchObject({
      version: 1, kind: 'session', run_id: 'run-1', trigger: 'pause', agent_id: 'agent:peggy', memory_dir: join(dir, 'memory'),
      conversation_id: 'conv-1', channel: 'telegram', topic: 'general', model: 'claude-haiku-4-5', human_message_count: 1,
    });
    expect(payload.messages[0]).toMatchObject({ body: '$(rm -rf ~) hello', author: { is_human: true, is_owner: true }, attachments: [{ path: '/tmp/a.png' }] });
    expect(readFileSync(join(dir, 'cwd.txt'), 'utf-8').trim()).toMatch(/script-journaler-/);
    const env = Object.fromEntries(readFileSync(join(dir, 'env.txt'), 'utf-8').trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
    const keys = Object.keys(env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)).sort();
    expect(keys).toEqual([
      'AGENTBUS_AGENT_ID', 'AGENTBUS_CONVERSATION_ID', 'AGENTBUS_JOB_KIND', 'AGENTBUS_MEMORY_DIR', 'AGENTBUS_MODEL',
      'AGENTBUS_PAYLOAD_VERSION', 'AGENTBUS_RUN_ID', 'AGENTBUS_SESSION_ID', 'AGENTBUS_TRIGGER', 'AGENTBUS_URL',
      'AGENTBUS_WORKING_DIR', 'EXTRA', 'HOME', 'PATH',
    ]);
    expect(env['AGENTBUS_MODEL']).toBe('claude-haiku-4-5');
  });

  it('maps exit codes 0, 3, 75 and others', async () => {
    const j = journaler();
    expect((await j.run(job({ command: writeScript('a.sh', 'exit 0') }))).outcome).toBe('done');
    expect((await j.run(job({ command: writeScript('b.sh', 'exit 3') }))).outcome).toBe('nothing-to-do');
    expect(await j.run(job({ command: writeScript('c.sh', 'echo "no network" >&2; exit 75') }))).toMatchObject({ outcome: 'unavailable', error: 'no network' });
    expect(await j.run(job({ command: writeScript('d.sh', 'echo broken >&2; exit 1') }))).toMatchObject({ outcome: 'failed-after-start', error: 'exit 1: broken' });
  });

  it('times out with failed-after-start and kills the process group', async () => {
    const cmd = writeScript('slow.sh', `sleep 30 & echo $! > "${dir}/bg.pid"; wait`);
    const result = await journaler().run(job({ command: cmd, timeout_ms: 300 }));
    expect(result).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('timed out') });
    const bg = Number(readFileSync(join(dir, 'bg.pid'), 'utf-8').trim());
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(bg, 0)).toThrow();
  }, 15_000);

  it('stops when the chain runner aborts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await journaler().run(job({ command: writeScript('slow.sh', 'sleep 30') }), { signal: controller.signal });
    expect(result).toMatchObject({ outcome: 'failed-after-start', error: expect.stringContaining('aborted') });
  }, 15_000);

  it('resolves a relative command against the working dir and checks it is executable', () => {
    writeScript('rel.sh', 'exit 0');
    writeScript('noexec.sh', 'exit 0', 0o644);
    const j = journaler();
    expect(j.canJournal(job({ command: 'rel.sh' }))).toEqual({ ok: true });
    expect(j.commandPath(job({ command: 'rel.sh' }))).toBe(join(dir, 'rel.sh'));
    expect(j.canJournal(job({ command: 'noexec.sh' }))).toMatchObject({ ok: false });
    expect(j.canJournal(job({ command: '/nonexistent/x' }))).toMatchObject({ ok: false });
  });

  it('marks fidelity snapshot when the job carries snapshots', async () => {
    const result = await journaler().run(job({ command: writeScript('a.sh', 'exit 0') }, {
      snapshots: [{ id: 'sn', event: 'pre-compact', path: '/x.jsonl', created_at: 'now' }],
    }));
    expect(result.fidelity).toBe('snapshot');
  });
});

describe('script payload helpers', () => {
  it('parses the last JSON object on stdout and ignores noise', () => {
    expect(parseScriptOutput('log line\n{"notes":"n","files_changed":["a",1]}')).toEqual({ notes: 'n', filesChanged: ['a'] });
    expect(parseScriptOutput('no json')).toBeNull();
    expect(parseScriptOutput('')).toBeNull();
  });

  it('builds a payload without settings internals', () => {
    const payload = buildScriptPayload(job({ command: '/bin/true' }));
    expect(payload).not.toHaveProperty('settings');
    expect(payload.timeout_ms).toBe(300_000); // script.timeout_ms defaults to the journaling timeout
  });
});
