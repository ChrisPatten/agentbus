import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { RuntimeResolver } from '../core/runtime-resolver.js';
import { OwnerDirectory } from '../core/owners.js';
import { AdvisoryStore } from '../advisories/store.js';
import { AdvisoryService } from '../advisories/service.js';
import { resolveMemoryLayout } from './layout.js';
import { checkMemorySetup } from './setup-check.js';
import { missesRecentImport, RECENT_NOT_IMPORTED_CONDITION, syncMemorySetupAdvisory } from './setup-advisory.js';

let dir: string;

function config(agents: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { 'cc-headless': { agent_id: 'baxter', system_prompt: 'x', working_dir: join(dir, 'baxter') } },
    contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 1 } } } },
    agents: { 'agent:baxter': { owners: [{ channel: 'telegram', contact_id: 'chris' }], ...agents } },
    memory: {},
  });
}

function setup(cfg = config()) {
  const db = new Database(':memory:');
  runMigrations(db);
  const resolver = new RuntimeResolver(cfg);
  const advisories = new AdvisoryService({ store: new AdvisoryStore(db), owners: new OwnerDirectory(cfg), resolver });
  const check = () => {
    const layout = resolveMemoryLayout(cfg, resolver, 'baxter');
    const status = checkMemorySetup(layout, resolver.resolve(layout.agentId));
    return { status, outcome: syncMemorySetupAdvisory(advisories, status, layout) };
  };
  const active = () => advisories.listActive('agent:baxter').filter((a) => a.condition_key === RECENT_NOT_IMPORTED_CONDITION);
  return { advisories, check, active };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-advisory-'));
  mkdirSync(join(dir, 'baxter', 'memory'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('memory:recent-not-imported advisory', () => {
  it('raises a warning when native loading lacks the import, and resolves once it is added', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    const { check, active } = setup();
    expect(check().outcome).toBe('raised');
    const [a] = active();
    expect(a).toMatchObject({ severity: 'warning', source: 'memory', agent_id: 'agent:baxter' });
    expect(a!.remediation).toContain('@memory/recent.md');

    // Re-checking without a fix keeps one advisory (keyed by condition).
    check();
    expect(active()).toHaveLength(1);

    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n@memory/recent.md\n');
    expect(check().outcome).toBe('resolved');
    expect(active()).toHaveLength(0);
  });

  it('says to create CLAUDE.md when there is none', () => {
    const { check, active } = setup();
    check();
    expect(active()[0]!.remediation).toMatch(/^Create the agent's CLAUDE.md with the line @memory\/recent.md/);
  });

  it('is not raised with bus injection (memory.native: false)', () => {
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    const { check, active } = setup(config({ memory: { native: false } }));
    expect(check()).toMatchObject({ outcome: 'resolved', status: { loading: 'injected' } });
    expect(active()).toHaveLength(0);
  });

  it('missesRecentImport only for native loading with importsRecent false', () => {
    expect(missesRecentImport({ loading: 'native', importsRecent: false })).toBe(true);
    expect(missesRecentImport({ loading: 'native', importsRecent: null })).toBe(false);
    expect(missesRecentImport({ loading: 'native', importsRecent: true })).toBe(false);
    expect(missesRecentImport({ loading: 'injected', importsRecent: false })).toBe(false);
  });

  it('works without an advisory service', () => {
    const raise = vi.fn();
    writeFileSync(join(dir, 'baxter', 'CLAUDE.md'), '# Baxter\n');
    const cfg = config();
    const resolver = new RuntimeResolver(cfg);
    const layout = resolveMemoryLayout(cfg, resolver, 'baxter');
    const status = checkMemorySetup(layout, resolver.resolve(layout.agentId));
    expect(syncMemorySetupAdvisory(undefined, status, layout)).toBe('raised');
    expect(syncMemorySetupAdvisory({ raise, resolve: vi.fn() }, status, layout)).toBe('raised');
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: RECENT_NOT_IMPORTED_CONDITION, agentId: 'agent:baxter' }));
  });
});
