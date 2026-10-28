import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import type { AppConfig } from '../config/schema.js';
import { ensureOutboundAppSession } from './outbound.js';
import { mainActivityClock, rotateIdleMainSessions, rotateMainSession } from './main.js';
import { createAppSession } from './store.js';

const HOUR = 3_600_000;
const config = (app?: Record<string, unknown>) => ({ adapters: app ? { app } : {} }) as unknown as AppConfig;

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const main = ensureOutboundAppSession(db, 'alice', 'agent:work', 'general');
  let n = 0;
  const put = (direction: 'inbound' | 'outbound', ageMs: number, metadata: Record<string, unknown> = {}, session = main) =>
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,'app','alice',?,'x',?)`).run(`row-${++n}`, `msg-${n}`, session.conversationId, session.sessionId,
      new Date(Date.now() - ageMs).toISOString(), direction, JSON.stringify(metadata));
  const withClaude = () => db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run('claude-1', main.sessionId);
  const endedAt = () => (db.prepare('SELECT ended_at, end_reason FROM sessions WHERE id = ?').get(main.sessionId) as {ended_at:string|null;end_reason:string|null});
  return { db, main, put, withClaude, endedAt };
}

describe('Main activity clock (E69)', () => {
  it('counts operator messages and own-turn sends, never foreign or unstamped sends', () => {
    const f = fixture();
    try {
      expect(mainActivityClock(f.db, f.main.conversationId)).toBeNull();
      f.put('inbound', 5 * HOUR);
      const operator = mainActivityClock(f.db, f.main.conversationId)!;
      f.put('outbound', 1 * HOUR, { origin: { kind: 'external', label: 'Ambient scan' } });
      f.put('outbound', 1 * HOUR, { origin: { kind: 'turn', agent_id: 'agent:work', conversation_id: 'elsewhere' } });
      f.put('outbound', 1 * HOUR);
      f.put('inbound', 1 * HOUR, { system_only: true });
      expect(mainActivityClock(f.db, f.main.conversationId)).toBe(operator);
      f.put('outbound', 2 * HOUR, { origin: { kind: 'turn', agent_id: 'agent:work', conversation_id: f.main.conversationId } });
      expect(Date.now() - Date.parse(mainActivityClock(f.db, f.main.conversationId)!)).toBeLessThan(2 * HOUR + 1000);
    } finally { f.db.close(); }
  });
});

describe('Main idle rotation (E69)', () => {
  it('rotates only after the configured period, and only a row with a claude_session_id', () => {
    const f = fixture();
    try {
      f.put('inbound', 3 * HOUR);
      const app = { main_idle_rotation_ms: 4 * HOUR };
      expect(rotateIdleMainSessions(f.db, config(app))).toEqual([]); // no Claude session yet
      f.withClaude();
      expect(rotateIdleMainSessions(f.db, config(app))).toEqual([]); // 3h < 4h
      // A proactive send does not count as activity.
      f.put('outbound', 0, { origin: { kind: 'external', label: 'Ambient scan' } });
      expect(rotateIdleMainSessions(f.db, config(app), undefined, Date.now() + 2 * HOUR)).toEqual([f.main.sessionId]);
      expect(f.endedAt()).toEqual({ ended_at: expect.any(String), end_reason: 'idle' });
    } finally { f.db.close(); }
  });

  it('a hidden shared note neither moves the clock nor postpones rotation (E82)', () => {
    const f = fixture();
    try {
      f.put('inbound', 3 * HOUR);
      f.withClaude();
      const clock = mainActivityClock(f.db, f.main.conversationId);
      f.put('outbound', 0, { origin: { kind: 'external', label: 'Claude Code: baxter' }, context_only: true });
      expect(mainActivityClock(f.db, f.main.conversationId)).toBe(clock);
      const app = { main_idle_rotation_ms: 4 * HOUR };
      expect(rotateIdleMainSessions(f.db, config(app))).toEqual([]); // 3h < 4h
      expect(rotateIdleMainSessions(f.db, config(app), undefined, Date.now() + 2 * HOUR)).toEqual([f.main.sessionId]);
    } finally { f.db.close(); }
  });

  it('defaults to 12 hours when adapters.app is absent, and 0 disables it', () => {
    const f = fixture();
    try {
      f.withClaude();
      f.put('inbound', 11 * HOUR);
      expect(rotateIdleMainSessions(f.db, config())).toEqual([]);
      expect(rotateIdleMainSessions(f.db, config({ main_idle_rotation_ms: 0 }), undefined, Date.now() + 100 * HOUR)).toEqual([]);
      expect(rotateIdleMainSessions(f.db, config(), undefined, Date.now() + 2 * HOUR)).toEqual([f.main.sessionId]);
    } finally { f.db.close(); }
  });

  it('never rotates topic sessions and fires the journal close trigger', () => {
    const f = fixture();
    try {
      const topic = createAppSession(f.db, 'alice', 'agent:work', 'Trip');
      f.db.prepare('UPDATE sessions SET claude_session_id = ?').run('claude-x');
      f.put('inbound', 20 * HOUR);
      f.put('inbound', 20 * HOUR, {}, { conversationId: (f.db.prepare('SELECT conversation_id FROM sessions WHERE id = ?')
        .get(topic.sessionId) as {conversation_id:string}).conversation_id, sessionId: topic.sessionId });
      const journal = { trigger: vi.fn(() => ({ status: 'queued' as const, done: Promise.resolve({ status: 'journaled' as const }) })) };
      expect(rotateIdleMainSessions(f.db, config(), journal)).toEqual([f.main.sessionId]);
      expect(journal.trigger).toHaveBeenCalledExactlyOnceWith({ reason: 'close', sessionId: f.main.sessionId });
      expect(f.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(topic.sessionId)).toEqual({ ended_at: null });
    } finally { f.db.close(); }
  });

  it('rotateMainSession for /clear fires the clear trigger', () => {
    const f = fixture();
    try {
      const journal = { trigger: vi.fn(() => ({ status: 'queued' as const, done: Promise.resolve({ status: 'journaled' as const }) })) };
      expect(rotateMainSession(f.db, f.main.sessionId, 'clear', journal)?.journal?.status).toBe('queued');
      expect(journal.trigger).toHaveBeenCalledWith({ reason: 'clear', sessionId: f.main.sessionId });
      expect(f.endedAt().end_reason).toBe('clear');
    } finally { f.db.close(); }
  });
});
