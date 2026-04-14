import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createCommandSystem } from './index.js';
import type { AppConfig } from '../config/schema.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: {},
  topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 }, urgency_keywords: [], vip_contacts: [], routes: [] },
} as unknown as AppConfig;

function makeAdapterRegistry() {
  return {
    list: () => [],
    lookup: () => undefined,
  };
}

function makeQueue() {
  return { counts: () => ({ pending: 0, processing: 0, delivered: 0, dead_letter: 0 }) };
}

describe('createCommandSystem', () => {
  it('registers all built-in commands including help', () => {
    const db = makeDb();
    const { registry } = createCommandSystem({
      adapterRegistry: makeAdapterRegistry() as never,
      queue: makeQueue() as never,
      db,
      config: stubConfig,
    });

    const names = registry.list().map((c) => c.name);
    expect(names).toContain('status');
    expect(names).toContain('help');
    expect(names).toContain('pause');
    expect(names).toContain('resume');
    expect(names).toContain('sessions');
    expect(names).toContain('replay');
    expect(names).toContain('next');
    expect(names).toContain('cancel');
    expect(names).toContain('forget');
  });

  it('loads persisted pause state from database on startup', () => {
    const db = makeDb();
    // Insert a persisted pause record
    db.prepare('INSERT INTO paused_adapters (adapter_id, paused_at, paused_by) VALUES (?, ?, ?)').run('telegram', '2026-04-14T12:00:00Z', 'contact:chris');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pauseSet } = createCommandSystem({
      adapterRegistry: makeAdapterRegistry() as never,
      queue: makeQueue() as never,
      db,
      config: stubConfig,
    });

    expect(pauseSet.has('telegram')).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('telegram'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('paused'));
    consoleSpy.mockRestore();
  });

  it('starts with empty pauseSet when no persisted records', () => {
    const db = makeDb();
    const { pauseSet } = createCommandSystem({
      adapterRegistry: makeAdapterRegistry() as never,
      queue: makeQueue() as never,
      db,
      config: stubConfig,
    });

    expect(pauseSet.size).toBe(0);
  });
});
