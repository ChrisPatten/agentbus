import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

function migrated() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function session(db: Database.Database, id: string, contact: string): void {
  db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
    VALUES (?,?, 'app', ?, '2026-09-30T12:00:00Z', '2026-09-30T12:00:00Z', 'agent:work')`)
    .run(id, `conv:${id}`, contact);
}

function transcript(db: Database.Database, id: string, sessionId: string, contact: string): void {
  db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
    VALUES (?,?,?,?,?,'app',?,'inbound',?,'{}')`)
    .run(`row:${id}`, id, `conv:${sessionId}`, sessionId, '2026-09-30T12:00:01Z', contact, id);
}

describe('migration 024 app event stream', () => {
  it('allocates strictly increasing sequences independently per contact', () => {
    const db = migrated();
    try {
      session(db, 'alice-s', 'alice');
      transcript(db, 'a1', 'alice-s', 'alice');
      session(db, 'bob-s', 'bob');
      transcript(db, 'b1', 'bob-s', 'bob');
      transcript(db, 'a2', 'alice-s', 'alice');
      const rows = db.prepare('SELECT contact_id, seq, kind, transcript_id FROM app_events ORDER BY contact_id, seq')
        .all() as Array<{ contact_id: string; seq: number; kind: string; transcript_id: string | null }>;
      expect(rows.filter((r) => r.contact_id === 'alice').map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(rows.filter((r) => r.contact_id === 'bob').map((r) => r.seq)).toEqual([1, 2]);
      expect(rows.find((r) => r.transcript_id === 'row:a2')).toMatchObject({ contact_id: 'alice', seq: 3, kind: 'message' });
    } finally { db.close(); }
  });

  it('commits transcript and event in one statement and rolls both back together', () => {
    const db = migrated();
    try {
      session(db, 'alice-s', 'alice');
      expect(() => db.transaction(() => {
        transcript(db, 'rollback', 'alice-s', 'alice');
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(db.prepare('SELECT id FROM transcripts WHERE message_id = ?').get('rollback')).toBeUndefined();
      expect(db.prepare('SELECT seq FROM app_events WHERE transcript_id = ?').get('row:rollback')).toBeUndefined();
      transcript(db, 'committed', 'alice-s', 'alice');
      expect(db.prepare('SELECT seq FROM app_events WHERE transcript_id = ?').get('row:committed')).toBeDefined();
    } finally { db.close(); }
  });

  it('persists idempotent send acks by contact and client message ID', () => {
    const db = migrated();
    try {
      db.prepare(`INSERT INTO app_sends(contact_id,client_msg_id,ack_json,created_at) VALUES (?,?,?,?)`)
        .run('alice', 'client-1', '{"status":"queued"}', '2026-09-30T12:00:00Z');
      expect(() => db.prepare(`INSERT INTO app_sends(contact_id,client_msg_id,ack_json,created_at) VALUES (?,?,?,?)`)
        .run('alice', 'client-1', '{"status":"queued"}', '2026-09-30T12:00:01Z')).toThrow();
      expect(() => db.prepare(`INSERT INTO app_sends(contact_id,client_msg_id,ack_json,created_at) VALUES (?,?,?,?)`)
        .run('bob', 'client-1', '{"status":"queued"}', '2026-09-30T12:00:01Z')).not.toThrow();
    } finally { db.close(); }
  });

  it('can run migrations repeatedly without losing event rows', () => {
    const db = migrated();
    try {
      session(db, 'alice-s', 'alice');
      expect(() => runMigrations(db)).not.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM app_events').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
