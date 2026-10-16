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
import { RecentFreshness, parseFreshnessQuery, recentDelta } from './recent-freshness.js';

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

describe('RecentFreshness, import mode (E67 S67.4)', () => {
  beforeEach(() => writeFileSync(join(dir, 'CLAUDE.md'), '# Peggy\n@memory/recent.md\n'));

  it('session-start records a baseline; a prompt gets content only after it changes, once', () => {
    const f = build();
    daily('2026-10-06', '- morning note');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start' })).toMatchObject({ ok: true, agent_id: 'agent:peggy', changed: false, reason: 'baseline', mode: 'import' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
    daily('2026-10-06', '- morning note\n- afternoon note'); // e.g. written in-turn; the check regenerates
    const changed = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(changed).toMatchObject({ ok: true, changed: true });
    const ctx = (changed as { context: string }).context;
    expect(ctx).toContain('new entries in memory/recent.md');
    expect(ctx).toContain('- afternoon note');
    expect(ctx).not.toContain('- morning note');
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

  it('sends only the appended lines, per day; a new day comes whole', () => {
    const f = build();
    daily('2026-10-05', '- yesterday note');
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    daily('2026-10-06', '- a\n- b');
    const r1 = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r1.context).toContain('- b');
    expect(r1.context).not.toContain('- a\n');
    expect(r1.context).not.toContain('yesterday note');
    // Next check diffs against what was just sent.
    daily('2026-10-06', '- a\n- b\n- c');
    const r2 = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r2.context).toContain('- c');
    expect(r2.context).not.toContain('- b');
  });

  it('a rewritten day is sent whole; losing a day alone sends nothing', () => {
    const f = build();
    daily('2026-10-05', '- old day');
    daily('2026-10-06', '- a\n- b');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    daily('2026-10-06', '- a\n- b edited');
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('rewritten');
    expect(r.context).toContain('- b edited');
    now = new Date(2026, 9, 9, 8, 0); // lookback window slides past both days
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'no-new-entries' });
  });

  it('a session row from before migration 035 (no stored text) gets the whole file once', () => {
    const f = build();
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    db.prepare(`UPDATE memory_recent_seen SET content = NULL, content_hash = 'stale' WHERE harness_session_id = 'pane-1'`).run();
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('changed since this session loaded it');
    expect(r.context).toContain('# Recent journal');
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('import mode ignores the start source: a compact start is a baseline, not a resend', () => {
    const f = build();
    daily('2026-10-06', '- a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start', source: 'startup' });
    daily('2026-10-06', '- a\n- b');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'session-start', source: 'compact' })).toMatchObject({ changed: false, reason: 'baseline', mode: 'import' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('an agent with no working dir is treated as import mode (the import cannot be checked)', () => {
    const real = build();
    const f = new RecentFreshness({
      db,
      recent: {
        regenerate: (id, reason) => (real as unknown as { deps: { recent: RecentMemory } }).deps.recent.regenerate(id, reason),
        layoutFor: (id) => ({ ...(real as unknown as { deps: { recent: RecentMemory } }).deps.recent.layoutFor(id), workingDir: null }),
      },
      resolveAgent: () => 'agent:peggy',
      now: () => now,
    });
    daily('2026-10-06', '- a');
    expect(f.check({ harnessSessionId: 's', event: 'session-start', source: 'startup' })).toMatchObject({ ok: true, changed: false, reason: 'baseline', mode: 'import' });
  });

  it('recentDelta ignores the budget-cut note and left-out marker', () => {
    const prev = '# Recent journal\n\n## 2026-10-06 (today)\n\n- a\n- b\n\n_[1 older day(s) left out to fit the 500-character budget: `x`.]_\n';
    const next = '# Recent journal\n\n## 2026-10-06 (today)\n\n_[Earlier entries of this day were cut to fit the budget; the full journal is `x`.]_\n\n- a\n- b\n- c\n';
    expect(recentDelta(prev, next)).toBe('## 2026-10-06 (new entries only)\n\n- c');
  });

  it('the midnight rollover alone sends nothing; the new day comes whole', () => {
    const f = build();
    daily('2026-10-06', 'a');
    f.check({ harnessSessionId: 'pane-1', event: 'session-start' });
    now = new Date(2026, 9, 7, 8, 0);
    expect(f.check({ harnessSessionId: 'pane-1' })).toMatchObject({ changed: false, reason: 'no-new-entries' });
    daily('2026-10-07', 'b');
    const r = f.check({ harnessSessionId: 'pane-1' }) as { context: string };
    expect(r.context).toContain('## 2026-10-07');
    expect(r.context).not.toContain('2026-10-06');
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
    db.prepare(`INSERT INTO memory_recent_seen (harness_session_id, agent_id, content_hash, seen_at) VALUES ('old', 'agent:peggy', 'h', ?)`).run(new Date(2026, 7, 1).toISOString());
    f.check({ harnessSessionId: 'pane-1' }); // sweeps on the first check
    expect(db.prepare(`SELECT harness_session_id FROM memory_recent_seen`).all()).toEqual([{ harness_session_id: 'pane-1' }]);
  });

  it('parses the query', () => {
    expect(parseFreshnessQuery({})).toEqual({ error: 'harness_session_id is required' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'nope' })).toEqual({ error: 'event must be prompt or session-start' });
    expect(parseFreshnessQuery({ harness_session_id: 's', event: 'prompt', agent: 'baxter' })).toEqual({ harnessSessionId: 's', event: 'prompt', agentId: 'baxter' });
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      expect(parseFreshnessQuery({ harness_session_id: 's', event: 'session-start', source })).toEqual({ harnessSessionId: 's', event: 'session-start', source });
    }
    expect(parseFreshnessQuery({ harness_session_id: 's', source: 'bogus' })).toEqual({ error: 'source must be one of startup, resume, clear, compact, fork' });
    expect(parseFreshnessQuery({ harness_session_id: 's', source: '' })).toMatchObject({ error: expect.stringContaining('source must be') });
  });
});

describe('RecentFreshness, hook mode (E73 S73.2)', () => {
  const start = (f: RecentFreshness, id: string, source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork') =>
    f.check({ harnessSessionId: id, event: 'session-start', source });
  const ctx = (r: unknown) => (r as { context: string }).context;

  it('a new session gets the whole file on startup, then nothing while unchanged', () => {
    const f = build(); // no CLAUDE.md import
    daily('2026-10-05', '- yesterday note');
    daily('2026-10-06', '- a');
    const r = start(f, 'pane-1', 'startup');
    expect(r).toMatchObject({ ok: true, agent_id: 'agent:peggy', changed: true, mode: 'hook' });
    expect(r).not.toHaveProperty('reason');
    expect(ctx(r)).toContain('memory/recent.md, your recent daily journals (loaded by the freshness hook; later updates arrive as new entries only):');
    expect(ctx(r)).toContain('# Recent journal');
    expect(ctx(r)).toContain('- yesterday note');
    expect(ctx(r)).toContain('- a');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged', mode: 'hook' });
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('resume and prompt send only the lines appended since', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    daily('2026-10-06', '- a\n- b');
    const r = start(f, 'pane-1', 'resume');
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('new entries in memory/recent.md');
    expect(ctx(r)).toContain('- b');
    expect(ctx(r)).not.toContain('# Recent journal');
    daily('2026-10-06', '- a\n- b\n- c');
    const r2 = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(ctx(r2)).toContain('- c');
    expect(ctx(r2)).not.toContain('- b');
  });

  it('compact sends the whole file again, even when nothing changed; the resume before it does not', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged' }); // fires right before compact, same call
    const r = start(f, 'pane-1', 'compact');
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('(loaded by the freshness hook');
    expect(ctx(r)).toContain('# Recent journal');
    expect(ctx(r)).toContain('- a');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('clear and fork arrive with a new session id, so they get the whole file', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    for (const [id, source] of [['pane-2', 'clear'], ['pane-3', 'fork']] as const) {
      const r = start(f, id, source);
      expect(r).toMatchObject({ changed: true, mode: 'hook' });
      expect(ctx(r)).toContain('# Recent journal');
    }
  });

  it('a prompt for a session with no row (no SessionStart hook, or the bus was down) gets the whole file', () => {
    const f = build();
    daily('2026-10-06', '- a');
    const r = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(r).toMatchObject({ changed: true, mode: 'hook' });
    expect(ctx(r)).toContain('# Recent journal');
    expect(f.check({ harnessSessionId: 'pane-1', event: 'prompt' })).toMatchObject({ changed: false, reason: 'unchanged' });
    // The same for a check without an event.
    expect(f.check({ harnessSessionId: 'pane-2' })).toMatchObject({ changed: true });
  });

  it('a legacy row without stored text gets the whole file once', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    db.prepare(`UPDATE memory_recent_seen SET content = NULL, content_hash = 'stale' WHERE harness_session_id = 'pane-1'`).run();
    const r = start(f, 'pane-1', 'resume');
    expect(r).toMatchObject({ changed: true });
    expect(ctx(r)).toContain('changed since this session loaded it');
    expect(ctx(r)).toContain('# Recent journal');
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'unchanged' });
  });

  it('the midnight rollover alone sends nothing; the new day comes whole', () => {
    const f = build();
    daily('2026-10-06', '- a');
    start(f, 'pane-1', 'startup');
    now = new Date(2026, 9, 7, 8, 0);
    expect(start(f, 'pane-1', 'resume')).toMatchObject({ changed: false, reason: 'no-new-entries', mode: 'hook' });
    daily('2026-10-07', '- b');
    const r = f.check({ harnessSessionId: 'pane-1', event: 'prompt' });
    expect(ctx(r)).toContain('## 2026-10-07');
    expect(ctx(r)).not.toContain('2026-10-06');
  });

  it('an import added later switches the agent to import mode', () => {
    const f = build();
    daily('2026-10-06', '- a');
    expect(start(f, 'pane-1', 'startup')).toMatchObject({ changed: true, mode: 'hook' });
    writeFileSync(join(dir, 'CLAUDE.md'), '@memory/recent.md\n');
    expect(start(f, 'pane-2', 'startup')).toMatchObject({ changed: false, reason: 'baseline', mode: 'import' });
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

  const FULL = { ok: true, changed: true, context: 'AgentBus: memory/recent.md, your recent daily journals (loaded by the freshness hook; later updates arrive as new entries only):\n\n# Recent journal' };

  it('UserPromptSubmit prints the context when it changed, sending the token on stdin', async () => {
    const { url, seen } = await stubBus({ ok: true, changed: true, context: 'AgentBus: memory/recent.md changed\n\nnew stuff' });
    const out = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess 1', prompt: 'hi' }, { AGENTBUS_URL: url, AGENTBUS_BUS_TOKEN: 'tok' });
    expect(out).toContain('new stuff');
    expect(seen[0]!.url).toBe('/api/v1/memory/recent?harness_session_id=sess%201&event=prompt');
    expect(seen[0]!.token).toBe('tok');
  });

  it('SessionStart passes the source and prints the context when the bus says changed', async () => {
    const { url, seen } = await stubBus(FULL);
    const out = await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, { AGENTBUS_URL: url, AGENTBUS_AGENT_ID: 'peggy' });
    expect(out).toContain('# Recent journal');
    expect(seen[0]!.url).toBe('/api/v1/memory/recent?harness_session_id=s&event=session-start&source=startup&agent=peggy');
  });

  it('prints nothing when unchanged, and nothing when the bus is down on UserPromptSubmit', async () => {
    const { url } = await stubBus({ ok: true, changed: false, reason: 'unchanged' });
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: url })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, { AGENTBUS_URL: url })).toBe('');
    expect(await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, { AGENTBUS_URL: 'http://127.0.0.1:9', AGENTBUS_RECENT_FILE: recentFile() })).toBe('');
  });

  function recentFile(): string {
    const f = join(mkdtempSync(join(tmpdir(), 'hook-recent-')), 'recent.md');
    writeFileSync(f, '# Recent journal\n\n- from disk\n');
    return f;
  }

  it('SessionStart falls back to the file on disk when the bus is down, for startup, clear, compact and fork', async () => {
    const file = recentFile();
    for (const source of ['startup', 'clear', 'compact', 'fork']) {
      const out = await runHook({ hook_event_name: 'SessionStart', session_id: 's', source }, { AGENTBUS_URL: 'http://127.0.0.1:9', AGENTBUS_RECENT_FILE: file });
      expect(out).toContain('the bus was unreachable');
      expect(out).toContain(file);
      expect(out).toContain('- from disk');
    }
  });

  it('no disk fallback on resume, without AGENTBUS_RECENT_FILE, or for an unreadable file', async () => {
    const file = recentFile();
    const down = { AGENTBUS_URL: 'http://127.0.0.1:9' };
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, { ...down, AGENTBUS_RECENT_FILE: file })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's' }, { ...down, AGENTBUS_RECENT_FILE: file })).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, down)).toBe('');
    expect(await runHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, { ...down, AGENTBUS_RECENT_FILE: join(dirname(file), 'missing.md') })).toBe('');
  });

  it('falls back on a bus error (non-2xx) or an unparsable answer, but not when the bus says nothing changed', async () => {
    const file = recentFile();
    const input = { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' };
    server = createServer((_req, res) => { res.statusCode = 404; res.end('{"ok":false}'); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await runHook(input, { AGENTBUS_URL: url, AGENTBUS_RECENT_FILE: file })).toContain('- from disk');
    await new Promise<void>((r) => server!.close(() => r()));
    server = createServer((_req, res) => { res.end('not json'); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const url2 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await runHook(input, { AGENTBUS_URL: url2, AGENTBUS_RECENT_FILE: file })).toContain('- from disk');
    await new Promise<void>((r) => server!.close(() => r()));
    const { url: url3 } = await stubBus({ ok: true, changed: false, reason: 'baseline' });
    expect(await runHook(input, { AGENTBUS_URL: url3, AGENTBUS_RECENT_FILE: file })).toBe('');
  });

  it('exits 0 without a session id', () => {
    const r = spawnSync('/bin/bash', [HOOK], { input: '{}', env: { PATH: process.env['PATH'] } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
  });
});
