import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { SessionTracker } from './session-tracker.js';
import type { AppConfig } from '../config/schema.js';

// E83 — the message-less placeholder row share_context creates for a primary channel's conversation.

const config = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {}, contacts: {}, topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 900000, session_close_min_messages: 0 },
  pipeline: { dedup_window_ms: 30000, drop_unrouted: false, topic_rules: [], priority_weights: {}, urgency_keywords: [], vip_contacts: [], routes: [] },
  agents: { 'agent:peggy': { pending_context: { channels: ['telegram:peggy'] } } },
} as unknown as AppConfig;

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  const idle = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const add = (id: string, channel: string, topic: string, messageCount: number) => {
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(`c-${id}`, 'chris', channel, topic, now, now);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,status)
      VALUES (?,?,?,?,?,?,?,'active')`).run(id, `c-${id}`, channel, 'chris', idle, idle, messageCount);
  };
  return { db, add };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SessionTracker and primary-channel placeholders (E83)', () => {
  it('keeps the placeholder for a listed channel\'s general conversation, and closes the same row elsewhere', () => {
    vi.spyOn(SessionTracker.prototype as unknown as { runOnSessionCloseHook: () => void }, 'runOnSessionCloseHook').mockImplementation(() => {});
    const f = fixture();
    const closed: string[] = [];
    f.add('dm', 'telegram:peggy', 'general', 0);
    f.add('other', 'telegram:other', 'general', 0);
    f.add('thread', 'telegram:peggy', 'thread:0123456789abcdef', 0);
    new SessionTracker({ db: f.db, config, onSessionClosed: (s) => closed.push(s.id) }).tick();
    expect(f.db.prepare(`SELECT ended_at, status FROM sessions WHERE id = 'dm'`).get()).toEqual({ ended_at: null, status: 'active' });
    expect(closed.sort()).toEqual(['other', 'thread']);
    f.db.close();
  });

  it('no longer exempts a listed channel\'s row once it has messages but no Claude session (the legacy path)', () => {
    vi.spyOn(SessionTracker.prototype as unknown as { runOnSessionCloseHook: () => void }, 'runOnSessionCloseHook').mockImplementation(() => {});
    const f = fixture();
    const closed: string[] = [];
    f.add('dm', 'telegram:peggy', 'general', 3);
    new SessionTracker({ db: f.db, config, onSessionClosed: (s) => closed.push(s.id) }).tick();
    expect(closed).toEqual(['dm']);
    f.db.close();
  });
});
