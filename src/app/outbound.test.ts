import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createAppSession } from './store.js';
import { validateAppDestination } from './outbound.js';

describe('validateAppDestination', () => {
  function fixture() {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  it('accepts Main without creating a session', () => {
    const db = fixture();
    expect(validateAppDestination(db, 'chris', 'agent:work', 'general')).toEqual({ ok: true });
    expect((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('accepts only an active app topic for the same contact and routed agent', () => {
    const db = fixture();
    const { sessionId, topic } = createAppSession(db, 'chris', 'agent:work', 'Travel');
    expect(validateAppDestination(db, 'chris', 'agent:work', topic)).toEqual({ ok: true });
    expect(validateAppDestination(db, 'alex', 'agent:work', topic).ok).toBe(false);
    expect(validateAppDestination(db, 'chris', 'agent:other', topic).ok).toBe(false);
    db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
    expect(validateAppDestination(db, 'chris', 'agent:work', topic).ok).toBe(false);
    db.close();
  });

  it('rejects unknown, deleted, and arbitrary topics with a useful error', () => {
    const db = fixture();
    const { topic } = createAppSession(db, 'chris', 'agent:work', 'Travel');
    db.prepare("DELETE FROM threads WHERE channel = 'app' AND topic = ?").run(topic);
    for (const target of [topic, 'thread:0000000000000000', 'sched:job', 'travel']) {
      const result = validateAppDestination(db, 'chris', 'agent:work', target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('app topic');
    }
    db.close();
  });
});
