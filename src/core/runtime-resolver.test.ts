import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import type { PoolLeaseRow } from '../pool/types.js';
import {
  RuntimeResolver,
  validateRuntimeRequirements,
  collectRuntimeRequirements,
  type PoolLeaseLookup,
} from './runtime-resolver.js';

function makeConfig(): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-headless': { agent_id: 'baxter', system_prompt: 'You are Baxter.', working_dir: '/agents/baxter' },
      'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude', working_dir: '/agents/peggy' },
      'claude-code': { poll_interval_ms: 1000 },
    },
    memory: {},
    pipeline: {
      routes: [
        { match: { channel: 'telegram' }, target: { adapterId: 'cc-headless', recipientId: 'agent:baxter' } },
        {
          match: { channel: 'email' },
          target: { adapterId: 'claude-code', recipientId: 'agent:claude' },
          also_notify: [
            { adapterId: 'codex', recipientId: 'agent:codex' },
            { adapterId: 'telegram', recipientId: 'contact:alice' },
          ],
        },
        // Shadowed by the headless instance: config instances win over routes.
        { match: { channel: 'pebble' }, target: { adapterId: 'claude-code', recipientId: 'agent:baxter' } },
      ],
    },
  });
}

function lease(overrides: Partial<PoolLeaseRow>): PoolLeaseRow {
  return {
    pool_id: 'peggy', pane_id: 'peggy-pool:2', agent_id: 'agent:peggy-pool-2', conversation_id: 'conv-1',
    claude_session_id: 'claude-1', state: 'leased', leased_at: null, last_activity_at: null,
    last_turn_ended_at: null, model: null, ...overrides,
  };
}

function poolManagers(row: PoolLeaseRow | null): Map<string, PoolLeaseLookup> {
  return new Map([['agent:peggy', {
    poolId: 'peggy',
    leaseStore: { findByConversation: (_pool: string, conv: string) => (row && row.conversation_id === conv ? row : null) },
  }]]);
}

describe('RuntimeResolver.resolve (E64 S64.2)', () => {
  const resolver = new RuntimeResolver(makeConfig());

  it('resolves a cc-headless instance by bare or prefixed id', () => {
    for (const id of ['baxter', 'agent:baxter']) {
      const rt = resolver.resolve(id);
      expect(rt).toMatchObject({ agentId: 'agent:baxter', kind: 'cc-headless', workingDir: '/agents/baxter' });
      expect(rt?.capabilities.sessionFork).toBe(true);
    }
  });

  it('resolves both a pool and its derived pane ids to cc-pool', () => {
    expect(resolver.resolve('agent:peggy')).toMatchObject({ kind: 'cc-pool', poolAgentId: 'agent:peggy' });
    expect(resolver.resolve('agent:peggy')).not.toHaveProperty('paneAgentId');
    expect(resolver.resolve('peggy-pool-3')).toMatchObject({
      kind: 'cc-pool', agentId: 'agent:peggy-pool-3', poolAgentId: 'agent:peggy', paneAgentId: 'agent:peggy-pool-3',
    });
  });

  it('resolves route-declared agents to claude-code or mcp-polled', () => {
    expect(resolver.resolve('agent:claude')).toMatchObject({ kind: 'claude-code' });
    expect(resolver.resolve('agent:codex')).toMatchObject({ kind: 'mcp-polled', adapterId: 'codex' });
  });

  it('returns undefined for unknown agents and contact targets', () => {
    expect(resolver.resolve('agent:nobody')).toBeUndefined();
    expect(resolver.resolve('agent:nobody-pool-1')).toBeUndefined();
    expect(resolver.resolve('contact:alice')).toBeUndefined();
  });

  it('lists every agent once, pools without their panes', () => {
    expect(resolver.list().map((r) => [r.agentId, r.kind])).toEqual([
      ['agent:baxter', 'cc-headless'],
      ['agent:claude', 'claude-code'],
      ['agent:codex', 'mcp-polled'],
      ['agent:peggy', 'cc-pool'],
    ]);
  });
});

describe('RuntimeResolver.checkLive', () => {
  it('fails unresolved agents and statically missing capabilities', () => {
    const resolver = new RuntimeResolver(makeConfig());
    expect(resolver.checkLive('liveAgent', { agentId: 'agent:nobody' })).toMatchObject({ ok: false, check: 'unresolved' });
    expect(resolver.checkLive('liveAgent', { agentId: 'agent:baxter' })).toMatchObject({
      ok: false, check: 'static', runtime: 'cc-headless', reason: 'cc-headless does not support liveAgent',
    });
    expect(resolver.checkLive('systemMessages', { agentId: 'agent:claude' })).toMatchObject({ ok: false, check: 'static' });
  });

  it('passes static-only capabilities on the static value', () => {
    const resolver = new RuntimeResolver(makeConfig());
    expect(resolver.checkLive('systemMessages', { agentId: 'agent:baxter' })).toMatchObject({ ok: true, check: 'static' });
    expect(resolver.checkLive('exclusiveSession', { agentId: 'agent:baxter' })).toMatchObject({ ok: true, check: 'static' });
  });

  describe('pane still leased to this conversation (cc-pool)', () => {
    it('passes when the conversation holds a leased pane', () => {
      const resolver = new RuntimeResolver(makeConfig(), { poolManagers: poolManagers(lease({})) });
      for (const cap of ['liveAgent', 'exclusiveSession'] as const) {
        expect(resolver.checkLive(cap, { agentId: 'agent:peggy-pool-2', conversationId: 'conv-1' })).toMatchObject({
          ok: true, check: 'pane-lease', runtime: 'cc-pool',
        });
      }
    });

    it('fails when the pane was released, is relaunching, or the pool is not running', () => {
      const released = new RuntimeResolver(makeConfig(), { poolManagers: poolManagers(null) });
      expect(released.checkLive('liveAgent', { agentId: 'agent:peggy-pool-2', conversationId: 'conv-1' }))
        .toMatchObject({ ok: false, reason: 'no pane is leased to this conversation' });

      const launching = new RuntimeResolver(makeConfig(), { poolManagers: poolManagers(lease({ state: 'launching' })) });
      expect(launching.checkLive('liveAgent', { agentId: 'agent:peggy', conversationId: 'conv-1' }))
        .toMatchObject({ ok: false, reason: 'pane peggy-pool:2 is launching' });

      const noPool = new RuntimeResolver(makeConfig());
      expect(noPool.checkLive('liveAgent', { agentId: 'agent:peggy', conversationId: 'conv-1' }))
        .toMatchObject({ ok: false, check: 'pane-lease' });
      expect(noPool.checkLive('liveAgent', { agentId: 'agent:peggy' }))
        .toMatchObject({ ok: false, reason: 'no conversation to check a pane lease for' });
    });
  });

  describe('Claude transcript still on disk', () => {
    const seen: Array<[string, string]> = [];
    const transcriptExists = (id: string, cwd: string) => { seen.push([id, cwd]); return id === 'claude-on-disk'; };

    it('checks the given claude_session_id in the runtime working dir', () => {
      const resolver = new RuntimeResolver(makeConfig(), { transcriptExists });
      expect(resolver.checkLive('sessionResume', { agentId: 'agent:baxter', claudeSessionId: 'claude-on-disk' }))
        .toMatchObject({ ok: true, check: 'transcript' });
      expect(seen.at(-1)).toEqual(['claude-on-disk', '/agents/baxter']);
      expect(resolver.checkLive('sessionResume', { agentId: 'agent:peggy-pool-1', claudeSessionId: 'claude-gone' }))
        .toMatchObject({ ok: false, check: 'transcript', runtime: 'cc-pool' });
      expect(seen.at(-1)).toEqual(['claude-gone', '/agents/peggy']);
      expect(resolver.checkLive('sessionFork', { agentId: 'agent:peggy-pool-1', claudeSessionId: 'claude-on-disk' }))
        .toMatchObject({ ok: false, check: 'static' });
    });

    it('looks up claude_session_id by session or conversation when not given', () => {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, conversation_id TEXT, claude_session_id TEXT,
        started_at TEXT, ended_at TEXT)`);
      const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)');
      insert.run('s-old', 'conv-1', 'claude-gone', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
      insert.run('s-open', 'conv-1', 'claude-on-disk', '2026-09-30T00:00:00Z', null);
      insert.run('s-none', 'conv-2', null, '2026-10-01T00:00:00Z', null);
      const resolver = new RuntimeResolver(makeConfig(), { db, transcriptExists });

      expect(resolver.checkLive('sessionResume', { agentId: 'agent:baxter', sessionId: 's-old' }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('claude-gone') });
      // The open session wins over a newer closed one.
      expect(resolver.checkLive('sessionResume', { agentId: 'agent:baxter', conversationId: 'conv-1' }))
        .toMatchObject({ ok: true });
      expect(resolver.checkLive('sessionResume', { agentId: 'agent:baxter', conversationId: 'conv-2' }))
        .toMatchObject({ ok: false, reason: 'session has no claude_session_id' });
      db.close();
    });
  });

  describe('harness currently polling (claude-code, mcp-polled)', () => {
    const now = () => new Date('2026-10-05T12:00:00Z');

    it('passes on a recent poll and fails on a stale or missing one', () => {
      const polls: Record<string, string> = { claude: '2026-10-05T11:59:50Z', codex: '2026-10-05T11:50:00Z' };
      const resolver = new RuntimeResolver(makeConfig(), { now, lastPollAt: (id) => polls[id] ?? null });
      expect(resolver.checkLive('liveAgent', { agentId: 'agent:claude' })).toMatchObject({ ok: true, check: 'polling' });
      expect(resolver.checkLive('liveAgent', { agentId: 'agent:codex' }))
        .toMatchObject({ ok: false, check: 'polling', reason: expect.stringContaining('stale after 15s') });
      polls['claude'] = '';
      expect(resolver.checkLive('liveAgent', { agentId: 'agent:claude' }))
        .toMatchObject({ ok: false, reason: 'harness has not polled since bus start' });
    });

    it('scales freshness with the configured poll interval', () => {
      const config = makeConfig();
      config.adapters['claude-code']!.poll_interval_ms = 20_000;
      const resolver = new RuntimeResolver(config, { now, lastPollAt: () => '2026-10-05T11:59:10Z' });
      expect(resolver.checkLive('liveAgent', { agentId: 'agent:claude' })).toMatchObject({ ok: true });
    });
  });
});

describe('validateRuntimeRequirements (E64 S64.3)', () => {
  const resolver = new RuntimeResolver(makeConfig());

  it('accepts satisfiable requirements', () => {
    expect(() => validateRuntimeRequirements(resolver, [
      { feature: 'advisories', agentId: 'baxter', requires: ['systemMessages'] },
      { feature: 'journal hook', agentId: 'agent:peggy', requires: ['hookEvents:pre-compact', 'liveAgent'] },
    ])).not.toThrow();
  });

  it('names the feature, agent, runtime and every missing capability', () => {
    expect(() => validateRuntimeRequirements(resolver, [
      { feature: 'journaling chain: system-message', agentId: 'agent:claude', requires: ['systemMessages', 'liveAgent', 'exclusiveSession'] },
      { feature: 'journal hook', agentId: 'agent:baxter', requires: ['hookEvents:turn-ended'] },
      { feature: 'advisories', agentId: 'agent:ghost', requires: ['systemMessages'] },
    ])).toThrow(
      'Runtime capability check failed:\n' +
        '  journaling chain: system-message: agent agent:claude runs on claude-code, which lacks systemMessages, exclusiveSession\n' +
        '  journal hook: agent agent:baxter runs on cc-headless, which lacks hookEvents:turn-ended\n' +
        '  advisories: agent agent:ghost has no runtime (no cc-headless/cc-pool instance or agent route)',
    );
  });

  it('collects no requirements from config yet', () => {
    expect(collectRuntimeRequirements(makeConfig())).toEqual([]);
  });
});
