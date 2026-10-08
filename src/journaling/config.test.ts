import { describe, it, expect, vi } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver, collectRuntimeRequirements, validateRuntimeRequirements } from '../core/runtime-resolver.js';
import {
  chainExhaustionRisk,
  compatibleChain,
  journalingRequirements,
  legacyJournalingBlocks,
  resolveJournalingSettings,
  thresholdForChannel,
} from './config.js';
import { CHAIN_RISK_CONDITION, reviewChains } from './advisories.js';

function makeConfig(agents: Record<string, unknown> = {}, headless: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-headless': { agent_id: 'baxter', system_prompt: 'You are Baxter.', model: 'sonnet', ...headless },
      'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude', model: 'opus' },
    },
    memory: {},
    agents,
    pipeline: {
      routes: [
        { match: { channel: 'email' }, target: { adapterId: 'claude-code', recipientId: 'agent:claude' } },
      ],
    },
  });
}

describe('per-agent journaling config (E66 S66.1)', () => {
  it('maps the deprecated cc-headless block to a [cc-headless] chain', () => {
    const cfg = makeConfig({}, { journaling: { threshold_ms: 60_000, ceiling_ms: 600_000, prompt: 'Journal now.' } });
    const s = resolveJournalingSettings(cfg).get('agent:baxter')!;
    expect(s).toMatchObject({
      source: 'cc-headless',
      enabled: true,
      chain: ['cc-headless'],
      thresholdMs: 60_000,
      ceilingMs: 600_000,
      minHumanMessages: 2,
      timeoutMs: 300_000,
      model: 'sonnet',
      prompt: 'Journal now.',
    });
  });

  it('applies defaults to agents.<id>.journaling and inherits the runtime model', () => {
    const cfg = makeConfig({ 'agent:peggy': { journaling: {} } });
    const s = resolveJournalingSettings(cfg).get('agent:peggy')!;
    expect(s.source).toBe('agents');
    expect(s.chain).toEqual(['system-message', 'cc-headless']); // script only when configured
    expect(s.minHumanMessages).toBe(2);
    expect(s.timeoutMs).toBe(300_000);
    expect(s.model).toBe('opus');
    expect(s.journalers['cc-headless'].model).toBe('opus');
    expect(s.journalers.script).toBeNull();
  });

  it('per-journaler settings override the journaling-level ones', () => {
    const cfg = makeConfig({
      peggy: {
        journaling: {
          chain: ['system-message', 'script'],
          model: 'haiku',
          timeout_ms: 120_000,
          'system-message': { timeout_ms: 60_000 },
          script: { command: '/bin/journal', args: ['--fast'], env: { A: 'b' }, model: 'sonnet' },
        },
      },
    });
    const s = resolveJournalingSettings(cfg).get('agent:peggy')!;
    expect(s.journalers['system-message']).toMatchObject({ timeoutMs: 60_000, model: 'haiku' });
    expect(s.journalers.script).toEqual({ command: '/bin/journal', args: ['--fast'], timeoutMs: 120_000, env: { A: 'b' }, model: 'sonnet' });
  });

  it('agents.<id>.journaling wins over the cc-headless block for the same agent', () => {
    const cfg = makeConfig({ baxter: { journaling: { chain: ['cc-headless'], min_human_messages: 5 } } }, { journaling: { threshold_ms: 1 } });
    const s = resolveJournalingSettings(cfg).get('agent:baxter')!;
    expect(s.source).toBe('agents');
    expect(s.minHumanMessages).toBe(5);
    expect(s.thresholdMs).toEqual({ default: 1_800_000 });
  });

  it('rejects "script" in the chain without script.command, and duplicates', () => {
    const bad = (journaling: unknown) => AppConfigSchema.safeParse({
      bus: { db_path: ':memory:' }, adapters: {}, memory: {}, agents: { 'agent:x': { journaling } },
    });
    const noScript = bad({ chain: ['script'] });
    expect(noScript.success).toBe(false);
    expect(JSON.stringify(noScript.error?.issues)).toContain('script.command');
    const dup = bad({ chain: ['cc-headless', 'cc-headless'] });
    expect(dup.success).toBe(false);
    expect(JSON.stringify(dup.error?.issues)).toContain('Duplicate journaler');
  });

  it('resolves per-channel thresholds', () => {
    expect(thresholdForChannel(5, 'telegram')).toBe(5);
    expect(thresholdForChannel({ default: 10, telegram: 3 }, 'telegram')).toBe(3);
    expect(thresholdForChannel({ default: 10, telegram: 3 }, 'email')).toBe(10);
  });

  it('finds explicit legacy blocks in the raw config', () => {
    expect(legacyJournalingBlocks({ adapters: { 'cc-headless': { system_prompt: 'x', journaling: {} } } }))
      .toEqual(['adapters.cc-headless.journaling']);
    expect(legacyJournalingBlocks({ adapters: { 'cc-headless': { a: { system_prompt: 'x' }, b: { system_prompt: 'y', journaling: {} } } } }))
      .toEqual(['adapters.cc-headless.b.journaling']);
    expect(legacyJournalingBlocks({ adapters: { 'cc-headless': { system_prompt: 'x' } } })).toEqual([]);
  });
});

describe('chain validation against runtime capabilities (E66 S66.1)', () => {
  it('skips statically incompatible entries: system-message never runs on cc-headless', () => {
    const cfg = makeConfig({ baxter: { journaling: { chain: ['system-message', 'cc-headless'] } } });
    const runtime = new RuntimeResolver(cfg).resolve('agent:baxter')!;
    expect(compatibleChain(['system-message', 'cc-headless'], runtime)).toEqual(['cc-headless']);
    expect(collectRuntimeRequirements(cfg)).toEqual([]);
  });

  it('fails at load when no chain entry fits the runtime', () => {
    const cfg = makeConfig({ 'agent:claude': { journaling: { chain: ['system-message', 'cc-headless'] } } });
    const reqs = journalingRequirements(cfg, new RuntimeResolver(cfg));
    expect(reqs.map((r) => r.feature)).toEqual(['journaling chain: system-message', 'journaling chain: cc-headless']);
    expect(() => validateRuntimeRequirements(new RuntimeResolver(cfg), collectRuntimeRequirements(cfg)))
      .toThrow(/agent:claude runs on claude-code, which lacks systemMessages, exclusiveSession/);
  });

  it('fails at load for journaling on an agent with no runtime', () => {
    const cfg = makeConfig({ ghost: { journaling: { chain: ['script'], script: { command: '/bin/true' } } } });
    expect(() => validateRuntimeRequirements(new RuntimeResolver(cfg), collectRuntimeRequirements(cfg)))
      .toThrow(/journaling: agent agent:ghost has no runtime/);
  });

  it('accepts a script-only chain on claude-code', () => {
    const cfg = makeConfig({ claude: { journaling: { chain: ['script'], script: { command: '/bin/true' } } } });
    expect(collectRuntimeRequirements(cfg)).toEqual([]);
  });

  it('reports exhaustion risk unless the last runnable entry is script', () => {
    const cfg = makeConfig({
      peggy: { journaling: { chain: ['system-message', 'cc-headless'] } },
      claude: { journaling: { chain: ['script'], script: { command: '/bin/true' } } },
    });
    const resolver = new RuntimeResolver(cfg);
    const settings = resolveJournalingSettings(cfg);
    expect(chainExhaustionRisk(settings.get('agent:peggy')!, resolver.resolve('agent:peggy')!)).toContain('ends with cc-headless');
    expect(chainExhaustionRisk(settings.get('agent:claude')!, resolver.resolve('agent:claude')!)).toBeNull();
    expect(chainExhaustionRisk(settings.get('agent:baxter')!, resolver.resolve('agent:baxter')!)).toContain('ends with cc-headless on cc-headless');
  });

  it('reviewChains raises an info advisory for risky chains and resolves the rest', () => {
    const cfg = makeConfig({ claude: { journaling: { chain: ['script'], script: { command: '/bin/true' } } } });
    const advisories = { raise: vi.fn(), resolve: vi.fn() };
    const raised = reviewChains(resolveJournalingSettings(cfg).values(), new RuntimeResolver(cfg), advisories as never, () => {});
    expect(raised).toEqual(['agent:baxter']);
    expect(advisories.raise).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent:baxter', conditionKey: CHAIN_RISK_CONDITION, severity: 'info', source: 'journaling',
    }));
    expect(advisories.resolve).toHaveBeenCalledWith('agent:claude', CHAIN_RISK_CONDITION);
  });
});
