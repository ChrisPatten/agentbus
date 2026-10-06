import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/loader.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import {
  DEFAULT_RECENT_BUDGET_CHARS,
  legacyMemoryBlocks,
  memoryLayout,
  memorySettingsFor,
  resolveMemoryLayout,
  resolveMemorySettings,
} from './layout.js';

function makeConfig(agents: Record<string, unknown> = {}, headless: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-headless': { agent_id: 'baxter', system_prompt: 'You are Baxter.', working_dir: '/agents/baxter', ...headless },
      'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude', working_dir: '/agents/peggy' },
    },
    memory: {},
    agents,
  });
}

let dir: string | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('per-agent memory layout (E67 S67.1)', () => {
  it('defaults every headless and pool agent', () => {
    const all = resolveMemorySettings(makeConfig());
    expect([...all.keys()].sort()).toEqual(['agent:baxter', 'agent:peggy']);
    expect(all.get('agent:peggy')).toMatchObject({
      source: 'default', dir: 'memory', indexFile: 'MEMORY.md', dailySubdir: 'daily',
      lookbackDays: 3, recentBudgetChars: DEFAULT_RECENT_BUDGET_CHARS, native: true,
    });
    // The headless block always carries defaults after validation, so it is the source.
    expect(all.get('agent:baxter')!.source).toBe('cc-headless');
  });

  it('agents.<id>.memory wins per field over the deprecated cc-headless block', () => {
    const cfg = makeConfig(
      { 'agent:baxter': { memory: { lookback_days: 5, recent_budget_chars: 8000 } } },
      { memory: { dir: 'mem', journal_lookback_days: 1 } },
    );
    expect(memorySettingsFor(cfg, 'baxter')).toMatchObject({
      source: 'agents', dir: 'mem', lookbackDays: 5, recentBudgetChars: 8000, indexFile: 'MEMORY.md',
    });
  });

  it('maps journal_lookback_days from the deprecated block', () => {
    const cfg = makeConfig({}, { memory: { journal_lookback_days: 7 } });
    expect(memorySettingsFor(cfg, 'agent:baxter').lookbackDays).toBe(7);
  });

  it('includes agents with only an agents.<id>.memory block', () => {
    const cfg = makeConfig({ claude: { memory: { dir: '/abs/memory' } } });
    expect(resolveMemorySettings(cfg).get('agent:claude')!.dir).toBe('/abs/memory');
  });

  it('resolves paths against the working dir, or keeps an absolute dir', () => {
    const rel = memoryLayout(memorySettingsFor(makeConfig(), 'peggy'), '/agents/peggy');
    expect(rel).toMatchObject({
      memoryDir: '/agents/peggy/memory',
      indexPath: '/agents/peggy/memory/MEMORY.md',
      dailyDir: '/agents/peggy/memory/daily',
      recentPath: '/agents/peggy/memory/recent.md',
      archiveDir: '/agents/peggy/memory/archive',
    });
    expect(memoryLayout(memorySettingsFor(makeConfig(), 'peggy'), null).memoryDir).toBeNull();
    const abs = memoryLayout(memorySettingsFor(makeConfig({ x: { memory: { dir: '/m' } } }), 'x'), null);
    expect(abs.memoryDir).toBe('/m');
  });

  it('a pool pane id resolves to its pool layout', () => {
    const cfg = makeConfig({ peggy: { memory: { dir: 'notes' } } });
    const layout = resolveMemoryLayout(cfg, new RuntimeResolver(cfg), 'agent:peggy-pool-2');
    expect(layout.agentId).toBe('agent:peggy');
    expect(layout.memoryDir).toBe('/agents/peggy/notes');
  });

  it('rejects a too-small budget', () => {
    expect(() => makeConfig({ x: { memory: { recent_budget_chars: 10 } } })).toThrow();
  });

  it('finds the deprecated block in raw config', () => {
    expect(legacyMemoryBlocks({ adapters: { 'cc-headless': { system_prompt: 'x', memory: {} } } })).toEqual(['adapters.cc-headless.memory']);
    expect(legacyMemoryBlocks({ adapters: { 'cc-headless': { a: { system_prompt: 'x', memory: {} }, b: { system_prompt: 'y' } } } }))
      .toEqual(['adapters.cc-headless.a.memory']);
    expect(legacyMemoryBlocks({ adapters: {} })).toEqual([]);
  });

  it('the loader warns about the deprecated block', () => {
    dir = mkdtempSync(join(tmpdir(), 'layout-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, [
      'bus:',
      `  db_path: ${join(dir, 'bus.db')}`,
      'adapters:',
      '  cc-headless:',
      '    agent_id: baxter',
      '    system_prompt: hi',
      '    memory:',
      '      journal_lookback_days: 2',
      'memory: {}',
      '',
    ].join('\n'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig(path, join(dir, '.env'));
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('adapters.cc-headless.memory is deprecated; move it to agents.<agent-id>.memory'))).toBe(true);
  });
});
