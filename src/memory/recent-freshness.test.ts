import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { RecentMemory } from './recent-service.js';
import { RecentFreshness, parseFreshnessQuery } from './recent-freshness.js';

let dir: string;
let db: Database.Database;
let now: Date;

function build(resolveAgent: (id: string) => string | null = (id) => (id.startsWith('pane-') ? 'agent:peggy' : null)) {
  const config = AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-pool': { agent_id: 'peggy', tmux_session: 'p', claude_bin: '/usr/local/bin/claude', working_dir: dir } },
    memory: {},
  });
  const resolver = new RuntimeResolver(config);
  const recent = new RecentMemory({ config, resolver, now: () => now, log: () => {} });
  return new RecentFreshness({
    db, recent, resolveAgent, now: () => now,
    knownAgent: (id) => resolver.resolve(id.startsWith('agent:') ? id : `agent:${id}`) !== undefined,
  });
}

const daily = (date: string, text: string) => writeFileSync(join(dir, 'memory', 'daily', `${date}.md`), text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  mkdirSync(join(dir, 'memory', 'daily'), { recursive: true });
  db = new Database(':memory:');
  runMigrations(db);
  now = new Date(2026, 9, 6, 10, 0);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RecentFreshness (E67 S67.4)', () => {
  it('session-start records a baseline; a prompt gets content only after it changes, once', () => {
    const f = build();
    daily('2026-10-06', '- morning note');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start' })).toMatchObject({ ok: true, agent_id: 'agent:peggy', changed: false, reason: 'baseline' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
    daily('2026-10-06', '- morning note\n- afternoon note'); // e.g. written in-turn; the check regenerates
    const changed = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(changed).toMatchObject({ ok: true, changed: true });
    expect((changed as { context: string }).context).toContain('memory/recent.md (your recent daily journals) changed');
    expect((changed as { context: string }).context).toContain('- afternoon note');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it("a session's first prompt is its baseline when SessionStart isn't registered; sessions are tracked separately", () => {
    const f = build();
    daily('2026-10-06', 'a');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ reason: 'baseline' });
    daily('2026-10-06', 'b');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: true });
    expect(f.check({ harnessSessionId: 'pane-2' })).toMatchObject({ reason: 'baseline' });
  });

  it('the midnight rollover counts as a change', () => {
    const f = build();
    daily('2026-10-06', 'a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    now = new Date(2026, 9, 7, 8, 0);
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: true });
  });

  it('404 for an unknown session; agent= is a fallback only for configured agents', () => {
    const f = build(() => null);
    expect(f.check({ harnessSessionId: 'x' })).toMatchObject({ ok: false, status: 404 });
    expect(f.check({ harnessSessionId: 'x', agentId: 'nobody' })).toMatchObject({ ok: false, status: 404 });
    expect(f.check({ harnessSessionId: 'x', agentId: 'peggy' })).toMatchObject({ ok: true, agent_id: 'agent:peggy' });
  });

  it('no-recent when the agent has no memory dir', () => {
    rmSync(join(dir, 'memory'), { recursive: true, force: true });
    expect(build().check({ harnessSessionId: 'pane-1' })).toMatchObject({ ok: true, changed: false, reason: 'no-recent' });
  });

  it('sweeps rows untouched for 30 days', () => {
    const f = build();
    db.prepare(`INSERT INTO memory_recent_seen VALUES ('old', 'agent:peggy', 'h', ?)`).run(new Date(2026, 7, 1).toISOString());
    f.check({ harnessSessionId: 'pane-1' }); // sweeps on the first check
    expect(db.prepare(`SELECT harness_session_id FROM memory_recent_seen`).all()).toEqual([{ harness_session_id: 'pane-1' }]);
  });

  it('parses the query', () => {
    expect(parseFreshnessQuery({})).toEqual({ error: 'harness_session_id is required' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'nope' })).toEqual({ error: 'event must be prompt or session-start' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'prompt', agent: 'baxter' })).toEqual({ harnessSessionId: 's', event: 'prompt', agentId: 'baxter' });
  });
});

// ── The hook script against a stub bus ──────────────────────────────────────

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/hooks/agentbus_recent_memory_hook.sh');
const hasJq = ['/usr/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].some((p) => existsSync(p));

describe.skipIf(!hasJq)('agentbus_recent_memory_hook.sh', { timeout: 30_000 }, () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  async function stubBus(response: unknown): Promise<{ url: string; seen: Array<{ url: string; token: string | undefined }> }> {
    const seen: Array<{ url: string; token: string | undefined }> = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', token: req.headers['x-bus-token'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  function runHook(input: unknown, env: Record<string, string>): Promise<string> {
    return new Promise((done) => {
      let out = '';
      const child = spawn('/bin/bash', [HOOK], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
      child.on('close', () => done(out));
      child.stdin.end(JSON.stringify(input));
    });
  }

  it('UserPromptSubmit prints the context when it changed, sending the token on stdin', async () => {
    const { url, seen } = await stubBus({ ok: true, changed: true, context: 'AgentBus: memory/recent.md changed\n\nnew stuff' });
    const out = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess 1', prompt: 'hi' }, { AGENTBUS_URL: url, AGENTBUS_BUS_TOKEN: 'tok' });
    expect(out).toContain('new stuff');
    expect(seen[0]!.url).toBe('/api/v1/memory/recent?harness_session_id=sess%201&event=prompt');
    expect(seen[0]!.token).toBe('tok');
  });

  it('prints nothing when unchanged, on SessionStart, or when the bus is down', async () => {
    const { url, seen } = await stubBus({ ok: true, changed: false, reason: 'unchanged' });
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: url })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, { AGENTBUS_URL: url, AGENTBUS_AGENT_ID: 'peggy' })).toBe('');
    expect(seen[1]!.url).toContain('event=session-start&agent=peggy');
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: 'http://127.0.0.1:9' })).toBe('');
  });

  it('exits 0 without a session id', () => {
    const r = spawnSync('/bin/bash', [HOOK], { input: '{}', env: { PATH: process.env['PATH'] } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
  });
});
