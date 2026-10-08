import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { JournalEngine } from '../journaling/engine.js';
import { JournalerRegistry } from '../journaling/registry.js';
import { buildScriptPayload } from '../journaling/journalers/script.js';
import type { Journaler, JournalJob } from '../journaling/types.js';
import {
  denyablePaths,
  diffProtected,
  isProtectedPath,
  protectedSpecs,
  resolveProtectedPaths,
  snapshotProtected,
  systemPromptImports,
  hashFile,
} from './protected-paths.js';
import { PROTECTED_CHANGE_CONDITION, ProtectedPathMonitor } from './monitor.js';

let dir: string;

function makeConfig(agent: Record<string, unknown> = {}, systemPrompt = 'You are Baxter.\n@prompts/baxter.md\nBe brief.'): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: systemPrompt, working_dir: dir } },
    memory: {},
    agents: { 'agent:baxter': { journaling: { chain: ['cc-headless'] }, ...agent } },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'protected-'));
  mkdirSync(join(dir, 'skills/briefing'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# Baxter\n@memory/vocabulary.md\n');
  writeFileSync(join(dir, 'prompts/baxter.md'), 'prompt');
  writeFileSync(join(dir, 'skills/briefing/SKILL.md'), 'skill');
  writeFileSync(join(dir, '.claude/settings.json'), '{}');
  writeFileSync(join(dir, 'memory/vocabulary.md'), 'glossary');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('protected path resolution (S68.4)', () => {
  it('defaults to CLAUDE.md, the system prompt imports, skills/ and .claude/', () => {
    expect(systemPromptImports('a @x.md b\n@dir/y.md @x.md')).toEqual(['x.md', 'dir/y.md']);
    const config = makeConfig();
    expect(protectedSpecs(config, 'baxter')).toEqual(['CLAUDE.md', 'prompts/baxter.md', 'skills/', '.claude/']);
    const paths = resolveProtectedPaths(config, new RuntimeResolver(config), 'baxter');
    expect(paths.entries.map((e) => e.path)).toEqual([
      join(dir, 'CLAUDE.md'), join(dir, 'prompts/baxter.md'), `${join(dir, 'skills')}/`, `${join(dir, '.claude')}/`,
    ]);
    expect(isProtectedPath(paths, join(dir, 'skills/briefing/SKILL.md'))).toBe(true);
    expect(isProtectedPath(paths, join(dir, 'CLAUDE.md'))).toBe(true);
    expect(isProtectedPath(paths, join(dir, 'memory/vocabulary.md'))).toBe(false);
    expect(isProtectedPath(paths, join(dir, 'notes.md'))).toBe(false);
  });

  it('uses the configured list and never protects the memory dir', () => {
    const config = makeConfig({ protected_paths: ['CLAUDE.md', 'memory/', 'memory/MEMORY.md', '/etc/hosts'] });
    const paths = resolveProtectedPaths(config, new RuntimeResolver(config), 'agent:baxter');
    expect(paths.entries.map((e) => e.spec)).toEqual(['CLAUDE.md', '/etc/hosts']);
  });

  it('leaves a protected directory holding the memory dir to hashing (no deny rule)', () => {
    const config = makeConfig({ protected_paths: ['.claude/', 'CLAUDE.md'], memory: { dir: '.claude/memory' } });
    const paths = resolveProtectedPaths(config, new RuntimeResolver(config), 'baxter');
    expect(denyablePaths(paths)).toEqual([join(dir, 'CLAUDE.md')]);
    mkdirSync(join(dir, '.claude/memory'), { recursive: true });
    writeFileSync(join(dir, '.claude/memory/MEMORY.md'), 'x');
    expect([...snapshotProtected(paths).keys()]).not.toContain(join(dir, '.claude/memory/MEMORY.md'));
  });

  it('snapshots and diffs files in protected entries', () => {
    const config = makeConfig();
    const paths = resolveProtectedPaths(config, new RuntimeResolver(config), 'baxter');
    const before = snapshotProtected(paths);
    expect(before.size).toBe(4);
    writeFileSync(join(dir, 'CLAUDE.md'), 'changed');
    writeFileSync(join(dir, 'skills/new.md'), 'new');
    unlinkSync(join(dir, '.claude/settings.json'));
    writeFileSync(join(dir, 'memory/MEMORY.md'), 'memory is free');
    const changes = diffProtected(before, snapshotProtected(paths));
    expect(changes.map((c) => c.path)).toEqual([join(dir, '.claude/settings.json'), join(dir, 'CLAUDE.md'), join(dir, 'skills/new.md')]);
    expect(changes[0]!.hash).toBe('absent');
    expect(changes[1]!.hash).toBe(hashFile(join(dir, 'CLAUDE.md')));
  });
});

describe('ProtectedPathMonitor around journal runs (S68.4)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  function setup(edit: (job: JournalJob) => void) {
    const config = makeConfig();
    const resolver = new RuntimeResolver(config);
    const raise = vi.fn();
    const monitor = new ProtectedPathMonitor({ config, resolver, advisories: { raise, resolve: vi.fn() } as never, log: () => {} });
    const jobs: JournalJob[] = [];
    const j: Journaler = {
      id: 'cc-headless', requires: [], supportsKinds: ['session', 'consolidate'], canJournal: () => ({ ok: true }),
      run: async (job) => { jobs.push(job); edit(job); return { outcome: 'done' }; },
    };
    const registry = new JournalerRegistry();
    registry.register(j);
    const engine = new JournalEngine({ db, config, resolver, registry, protectedPaths: monitor, log: () => {} });
    return { engine, monitor, raise, jobs };
  }

  it('hands deny paths to the job and raises a warning when a protected file changed', async () => {
    const { engine, raise, jobs } = setup(() => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'rewritten by the run');
      writeFileSync(join(dir, 'memory/MEMORY.md'), 'fine');
    });
    await engine.consolidate('baxter', 'manual').done;
    expect(jobs[0]!.protectedPaths).toEqual([
      join(dir, 'CLAUDE.md'), join(dir, 'prompts/baxter.md'), `${join(dir, 'skills')}/`, `${join(dir, '.claude')}/`,
    ]);
    expect(jobs[0]!.prompt).toContain('Protected (do not edit; propose a change with the propose_change tool');
    expect(jobs[0]!.prompt).toContain('CLAUDE.md, prompts/baxter.md, skills/, .claude/');
    expect(buildScriptPayload(jobs[0]!).protected_paths).toHaveLength(4);
    expect(raise).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentId: 'agent:baxter', conditionKey: PROTECTED_CHANGE_CONDITION, severity: 'warning', body: expect.stringContaining('CLAUDE.md'),
    }));
  });

  it('does not report a change the bus applied for an approved proposal', async () => {
    let monitorRef: ProtectedPathMonitor | null = null;
    const { engine, monitor, raise } = setup(() => {
      writeFileSync(join(dir, 'CLAUDE.md'), 'approved content');
      monitorRef!.noteApproved(join(dir, 'CLAUDE.md'), hashFile(join(dir, 'CLAUDE.md')));
    });
    monitorRef = monitor;
    await engine.consolidate('baxter', 'manual').done;
    expect(raise).not.toHaveBeenCalled();
  });

  it('raises nothing when only memory files changed', async () => {
    const { engine, raise } = setup(() => writeFileSync(join(dir, 'memory/vocabulary.md'), 'more words'));
    await engine.consolidate('baxter', 'manual').done;
    expect(raise).not.toHaveBeenCalled();
  });
});
