import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { resolveMemoryLayout } from './layout.js';
import { checkMemorySetup, importClosure, parseImports, settingsRegisterRecentHook } from './setup-check.js';
import { memoryLines } from '../commands/journal.js';

let dir: string;

function config(opts: { agents?: Record<string, unknown>; launchArgs?: string[] } = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-headless': { agent_id: 'baxter', system_prompt: 'x', working_dir: join(dir, 'baxter') },
      'cc-pool': { agent_id: 'peggy', tmux_session: 'p', claude_bin: '/usr/local/bin/claude', working_dir: join(dir, 'peggy'), launch_args: opts.launchArgs ?? [] },
    },
    memory: {},
    agents: opts.agents ?? {},
  });
}

function check(agentId: string, cfg = config()) {
  const resolver = new RuntimeResolver(cfg);
  const layout = resolveMemoryLayout(cfg, resolver, agentId);
  return checkMemorySetup(layout, resolver.resolve(layout.agentId));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-check-'));
  for (const a of ['baxter', 'peggy']) mkdirSync(join(dir, a, 'memory'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('memory setup checks (E67 S67.5)', () => {
  it('parses @imports outside code', () => {
    expect(parseImports('See @memory/recent.md.\n`@not/this.md`\n```\n@nor/this.md\n```\n@~/x.md and email a@b.com')).toEqual(['memory/recent.md', '~/x.md']);
  });

  it('follows nested imports up to depth 4, counting targets that do not exist yet', () => {
    const root = join(dir, 'baxter');
    writeFileSync(join(root, 'CLAUDE.md'), '@docs/a.md');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), '@../memory/recent.md');
    expect(importClosure([join(root, 'CLAUDE.md')]).has(join(root, 'memory', 'recent.md'))).toBe(true);
    for (let i = 1; i <= 5; i++) writeFileSync(join(root, `l${i}.md`), i < 5 ? `@l${i + 1}.md` : '@memory/recent.md');
    expect(importClosure([join(root, 'l1.md')]).has(join(root, 'memory', 'recent.md'))).toBe(false); // 5 hops
  });

  it('native headless: the bus supplies the dir; warns when CLAUDE.md lacks the import', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    const s = check('baxter');
    expect(s).toMatchObject({ loading: 'native', autoMemorySource: 'bus', importsRecent: false, memoryDirExists: true });
    expect(s).toMatchObject({ hooksRecent: false, recentDelivery: 'none' });
    expect(s.warnings).toEqual([
      'CLAUDE.md does not import @memory/recent.md and no SessionStart hook runs agentbus_recent_memory_hook.sh, ' +
      'so the agent never sees its recent journals; register the hook in .claude/settings.json (or add the import)',
    ]);
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n@memory/recent.md\n');
    expect(check('baxter')).toMatchObject({ importsRecent: true, hooksRecent: false, recentDelivery: 'import', warnings: [] });
  });

  function writeSettings(agent: string, file: string, body: unknown) {
    mkdirSync(join(dir, agent, '.claude'), { recursive: true });
    writeFileSync(join(dir, agent, '.claude', file), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const hookSettings = (command: string, event = 'SessionStart') => ({ hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] } });

  it('hook delivery (E73): the SessionStart hook replaces the import, with no warning', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    writeSettings('baxter', 'settings.json', hookSettings('AGENTBUS_AGENT_ID=baxter /opt/agentbus/scripts/hooks/agentbus_recent_memory_hook.sh'));
    expect(check('baxter')).toMatchObject({ importsRecent: false, hooksRecent: true, recentDelivery: 'hook', warnings: [] });
  });

  it('hook delivery is also found in settings.local.json', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    writeSettings('baxter', 'settings.local.json', hookSettings('scripts/hooks/agentbus_recent_memory_hook.sh'));
    expect(check('baxter')).toMatchObject({ hooksRecent: true, recentDelivery: 'hook', warnings: [] });
  });

  it('import plus hook is a recommendation: the hook only sends updates', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '@memory/recent.md');
    writeSettings('baxter', 'settings.json', hookSettings('/x/agentbus_recent_memory_hook.sh'));
    const s = check('baxter');
    expect(s.recentDelivery).toBe('both');
    expect(s.warnings).toEqual(['CLAUDE.md imports @memory/recent.md, so the freshness hook agentbus_recent_memory_hook.sh only sends updates; Claude Code re-reads the whole file whenever it changes. Remove the import to let the hook deliver it (full on session start, new entries after)']);
  });

  it('bus injection with the hook registered would also load it twice', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    writeSettings('baxter', 'settings.json', hookSettings('/x/agentbus_recent_memory_hook.sh'));
    const s = check('baxter', config({ agents: { baxter: { memory: { native: false } } } }));
    expect(s.warnings).toEqual(['the SessionStart hook agentbus_recent_memory_hook.sh delivers recent.md and the bus injects it too (memory.native: false); remove one']);
  });

  it('detects the hook script through quotes, relative paths and symlinks; ignores other events and bad JSON', () => {
    const wd = join(dir, 'baxter');
    const reg = (body: unknown) => { writeSettings('baxter', 'settings.json', body); return settingsRegisterRecentHook(join(wd, '.claude', 'settings.json'), wd); };
    expect(reg(hookSettings('"/a b/../agentbus_recent_memory_hook.sh"'))).toBe(true);
    expect(reg(hookSettings('AGENTBUS_AGENT_ID=baxter FOO=1 ./hooks/agentbus_recent_memory_hook.sh'))).toBe(true);
    expect(reg(hookSettings('AGENTBUS_RECENT_FILE=/x/y bash -c agentbus_recent_memory_hook.sh'))).toBe(true);
    expect(reg(hookSettings('/x/agentbus_recent_memory_hook.sh', 'UserPromptSubmit'))).toBe(false);
    expect(reg(hookSettings('/x/other_hook.sh'))).toBe(false);
    expect(reg(hookSettings('/x/not_agentbus_recent_memory_hook.sh.bak'))).toBe(false);
    expect(reg({ disableAllHooks: true, ...hookSettings('/x/agentbus_recent_memory_hook.sh') })).toBe(false);
    expect(reg({ hooks: { SessionStart: 'nope' } })).toBe(false);
    expect(reg('{ not json')).toBe(false);
    // A symlink under another name that points at the script.
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'agentbus_recent_memory_hook.sh'), '#!/bin/sh\n');
    symlinkSync(join(dir, 'real', 'agentbus_recent_memory_hook.sh'), join(wd, 'recent-hook'));
    expect(reg(hookSettings('./recent-hook'))).toBe(true);
    expect(settingsRegisterRecentHook(join(wd, '.claude', 'missing.json'), wd)).toBe(false);
  });

  it('no working dir cannot tell how recent.md is delivered', () => {
    const cfg = config();
    const resolver = new RuntimeResolver(cfg);
    const layout = { ...resolveMemoryLayout(cfg, resolver, 'baxter'), workingDir: null };
    const s = checkMemorySetup(layout, resolver.resolve(layout.agentId));
    expect(s).toMatchObject({ importsRecent: null, hooksRecent: null, recentDelivery: null });
    expect(s.warnings.join()).toContain("can't check how recent.md is delivered");
  });

  it('flags autoMemoryDirectory in checked-in settings, and an overridden local one', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '@memory/recent.md');
    mkdirSync(join(dir, 'baxter', '.claude'));
    writeFileSync(join(dir, 'baxter', '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: './memory' }));
    writeFileSync(join(dir, 'baxter', '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/elsewhere' }));
    const w = check('baxter').warnings.join('\n');
    expect(w).toContain('Claude Code ignores in checked-in project settings');
    expect(w).toContain("the bus's --settings");
  });

  it('pool with its own --settings in launch_args: the operator must set it', () => {
    writeFileSync(join(dir, 'peggy', 'CLAUDE.md'), '@memory/recent.md');
    const s = check('agent:peggy-pool-1', config({ launchArgs: ['--settings', '/s.json'] }));
    expect(s.autoMemorySource).toBe('operator');
    expect(s.warnings[0]).toContain('that settings file must set it');
  });

  it('bus injection: an import would load recent.md twice', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '@memory/recent.md');
    const s = check('baxter', config({ agents: { baxter: { memory: { native: false } } } }));
    expect(s.loading).toBe('injected');
    expect(s.warnings).toEqual(['CLAUDE.md imports @memory/recent.md and the bus injects it too (memory.native: false); remove one']);
  });

  it('missing memory dir and missing CLAUDE.md', () => {
    rmSync(join(dir, 'peggy', 'memory'), { recursive: true });
    const w = check('peggy').warnings;
    expect(w[0]).toContain('does not exist');
    expect(w[1]).toContain('no CLAUDE.md');
  });

  it('renders for /journal', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# nothing');
    const lines = memoryLines(check('baxter'));
    expect(lines[0]).toBe(`Memory (${join(dir, 'baxter', 'memory')}):`);
    expect(lines).toContain('  loading: native (auto memory, set by the bus)');
    expect(lines).toContain('  recent.md delivery: none');
    expect(lines.some((l) => l.startsWith('  warning: CLAUDE.md does not import'))).toBe(true);

    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '@memory/recent.md');
    expect(memoryLines(check('baxter'))).toContain('  recent.md delivery: import (CLAUDE.md imports it)');
    mkdirSync(join(dir, 'baxter', '.claude'));
    writeFileSync(join(dir, 'baxter', '.claude', 'settings.json'), JSON.stringify(hookSettings('/x/agentbus_recent_memory_hook.sh')));
    expect(memoryLines(check('baxter'))).toContain('  recent.md delivery: import, hook sends updates');
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# nothing');
    expect(memoryLines(check('baxter'))).toContain('  recent.md delivery: hook (SessionStart freshness hook)');
  });
});
