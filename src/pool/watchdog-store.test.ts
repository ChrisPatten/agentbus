import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { IncidentStore } from './watchdog-store.js';
import { resolveWatchdogConfig } from './watchdog-config.js';

function makeStore() {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IncidentStore(db);
}

const base = {
  poolId: 'p',
  paneId: 'p:1',
  conversationId: 'c1',
  class: 'unknown_blocked' as const,
  unhandledSince: '2026-01-01T00:00:00.000Z',
  screenSnapshot: 'screen',
};

describe('IncidentStore', () => {
  it('inserts and finds the open incident', () => {
    const s = makeStore();
    const row = s.insert(base, new Date('2026-01-01T00:10:00Z'));
    expect(row.detected_at).toBe('2026-01-01T00:10:00.000Z');
    expect(row.actions).toEqual([]);
    expect(row.pattern).toBeNull();
    expect(s.findOpen('p', 'p:1')?.id).toBe(row.id);
    expect(s.findOpen('p', 'p:2')).toBeNull();
  });

  it('resolve only succeeds once', () => {
    const s = makeStore();
    const row = s.insert(base);
    expect(s.resolve(row.id, 'recovered')).toBe(true);
    expect(s.resolve(row.id, 'released')).toBe(false);
    expect(s.findOpen('p', 'p:1')).toBeNull();
    expect(s.get(row.id)?.resolution).toBe('recovered');
  });

  it('appends actions in order', () => {
    const s = makeStore();
    const row = s.insert(base);
    s.appendAction(row.id, { action: 'alert', result: 'sent' }, new Date('2026-01-01T00:00:00Z'));
    s.appendAction(row.id, { action: 'keys', result: 'failed' });
    const got = s.get(row.id)!;
    expect(got.actions.map((a) => a.action)).toEqual(['alert', 'keys']);
    expect(got.actions[0]!.at).toBe('2026-01-01T00:00:00.000Z');
    expect(s.appendAction('nope', { action: 'x', result: 'y' })).toBe(false);
  });

  it('lists newest first with open filter', () => {
    const s = makeStore();
    const a = s.insert(base, new Date('2026-01-01T00:00:00Z'));
    const b = s.insert({ ...base, paneId: 'p:2' }, new Date('2026-01-01T00:01:00Z'));
    s.resolve(a.id, 'answered');
    expect(s.list().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(s.list({ open: true }).map((r) => r.id)).toEqual([b.id]);
    expect(s.list({ open: false }).map((r) => r.id)).toEqual([a.id]);
  });
});

describe('resolveWatchdogConfig', () => {
  it('applies defaults', () => {
    expect(resolveWatchdogConfig()).toEqual({
      enabled: true,
      observe_only: true,
      sample_interval_ms: 30000,
      stall_after_ms: 300000,
      alert_contact: undefined,
    });
  });
  it('keeps overrides', () => {
    const c = resolveWatchdogConfig({ enabled: false, stall_after_ms: 5, alert_contact: 'x' });
    expect(c.enabled).toBe(false);
    expect(c.stall_after_ms).toBe(5);
    expect(c.alert_contact).toBe('x');
    expect(c.sample_interval_ms).toBe(30000);
  });
});
