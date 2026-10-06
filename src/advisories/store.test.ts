import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AdvisoryStore } from './store.js';
import type { AdvisoryInput } from './types.js';

function input(overrides: Partial<AdvisoryInput> = {}): AdvisoryInput {
  return {
    agentId: 'baxter',
    conditionKey: 'journaling:chain-exhausted',
    severity: 'warning',
    title: 'Journaling chain exhausted',
    body: 'Every journaler failed for the last run.',
    remediation: 'Check the journaler logs with /journal runs.',
    source: 'journaling',
    ...overrides,
  };
}

describe('AdvisoryStore (E65 S65.2)', () => {
  let db: Database.Database;
  let store: AdvisoryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    store = new AdvisoryStore(db);
  });

  it('creates an open advisory with a prefixed agent id', () => {
    const { advisory, outcome } = store.raise(input());
    expect(outcome).toBe('created');
    expect(advisory).toMatchObject({
      agent_id: 'agent:baxter', condition_key: 'journaling:chain-exhausted', severity: 'warning',
      state: 'open', raise_count: 1, source: 'journaling', delivery_attempts: 0,
    });
  });

  it('requires a remediation hint', () => {
    expect(() => store.raise(input({ remediation: '  ' }))).toThrow(/remediation/);
  });

  it('dedups: one active advisory per condition', () => {
    const first = store.raise(input());
    const second = store.raise(input({ agentId: 'agent:baxter' }));
    expect(second.outcome).toBe('unchanged');
    expect(second.advisory.id).toBe(first.advisory.id);
    expect(second.advisory.raise_count).toBe(2);
    expect(store.listActive('baxter')).toHaveLength(1);
    // A different condition or agent is a separate advisory.
    store.raise(input({ conditionKey: 'hooks:stale' }));
    store.raise(input({ agentId: 'peggy' }));
    expect(store.listActive()).toHaveLength(3);
  });

  it('updates text in place without touching delivery state', () => {
    const { advisory } = store.raise(input());
    store.markDelivered([advisory.id], 'injection');
    const updated = store.raise(input({ body: 'Three runs in a row failed.' }));
    expect(updated.outcome).toBe('updated');
    expect(updated.advisory).toMatchObject({ id: advisory.id, state: 'delivered', body: 'Three runs in a row failed.' });
  });

  it('escalates severity in place and reopens for redelivery', () => {
    const { advisory } = store.raise(input());
    store.markDelivered([advisory.id], 'injection');
    store.ack(advisory.id, 'baxter');
    const escalated = store.raise(input({ severity: 'critical', title: 'Nothing journaled for 24 h' }));
    expect(escalated.outcome).toBe('escalated');
    expect(escalated.advisory).toMatchObject({
      id: advisory.id, severity: 'critical', state: 'open', title: 'Nothing journaled for 24 h',
      delivered_at: null, acknowledged_at: null, delivery_attempts: 0,
    });
  });

  it('never de-escalates', () => {
    store.raise(input({ severity: 'critical' }));
    const lower = store.raise(input({ severity: 'info' }));
    expect(lower.outcome).toBe('unchanged');
    expect(lower.advisory.severity).toBe('critical');
  });

  it('auto-resolves and re-raises a recurrence as a new advisory', () => {
    const { advisory } = store.raise(input());
    const resolved = store.resolve('agent:baxter', 'journaling:chain-exhausted');
    expect(resolved).toMatchObject({ id: advisory.id, state: 'resolved' });
    expect(resolved!.resolved_at).not.toBeNull();
    expect(store.listActive('baxter')).toEqual([]);
    // Resolving again is a no-op.
    expect(store.resolve('baxter', 'journaling:chain-exhausted')).toBeNull();

    const again = store.raise(input());
    expect(again.outcome).toBe('created');
    expect(again.advisory.id).not.toBe(advisory.id);
    expect(store.list({ agentId: 'baxter' })).toHaveLength(2);
  });

  it('acks only the owning agent\'s advisories, idempotently', () => {
    const { advisory } = store.raise(input());
    expect(store.ack('nope')).toEqual({ ok: false, reason: 'not_found' });
    expect(store.ack(advisory.id, 'agent:peggy')).toEqual({ ok: false, reason: 'wrong_agent' });
    const acked = store.ack(advisory.id, 'baxter');
    expect(acked).toMatchObject({ ok: true, alreadyAcknowledged: false });
    expect(store.get(advisory.id)).toMatchObject({ state: 'acknowledged', acknowledged_by: 'agent:baxter' });
    expect(store.ack(advisory.id, 'baxter')).toMatchObject({ ok: true, alreadyAcknowledged: true });
    store.resolve('baxter', advisory.condition_key);
    expect(store.ack(advisory.id, 'baxter')).toMatchObject({ ok: false, reason: 'resolved' });
  });

  it('markDelivered only moves open advisories', () => {
    const a = store.raise(input()).advisory;
    expect(store.markDelivered([a.id], 'direct')).toBe(1);
    expect(store.markDelivered([a.id], 'injection')).toBe(0);
    expect(store.get(a.id)).toMatchObject({ state: 'delivered', delivered_via: 'direct' });
  });

  it('records delivery attempts and lists most severe first', () => {
    const a = store.raise(input({ conditionKey: 'a', severity: 'info' })).advisory;
    store.raise(input({ conditionKey: 'b', severity: 'critical' }));
    store.recordAttempt(a.id, 'no adapter for channel "x"');
    expect(store.get(a.id)).toMatchObject({ delivery_attempts: 1, last_error: 'no adapter for channel "x"' });
    expect(store.listActive().map((r) => r.severity)).toEqual(['critical', 'info']);
    expect(store.list({ severities: ['info'] })).toHaveLength(1);
  });
});
