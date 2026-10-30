import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runMigrations } from '../schema.js';
import { readEvents, recordChoiceEvent } from '../../app/store.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Migrates fully, then rewinds app_events to its 024 + 037 shape so 043 runs again. */
function pre043(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const m024 = readFileSync(join(here, '024_app_events.sql'), 'utf-8');
  const original = m024.slice(m024.indexOf('CREATE TABLE app_events ('), m024.indexOf('CREATE TABLE app_sends'));
  db.exec(`DROP TRIGGER app_transcript_event; DROP TRIGGER app_session_created; DROP TRIGGER app_session_changed;
    DROP TABLE app_events;`);
  db.exec(original);
  db.exec('ALTER TABLE app_events ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;');
  db.prepare('DELETE FROM schema_migrations WHERE version = 43').run();
  return db;
}

function seed(db: Database.Database): void {
  const now = '2026-10-29T12:00:00.000Z';
  db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`)
    .run('conv-main', 'alice', 'app', 'general', now, now);
  db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
    VALUES ('s1','conv-main','app','alice',?,?,'agent:work')`).run(now, now);
  for (const [id, dir] of [['m1', 'inbound'], ['m2', 'outbound']] as const) {
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,'app','alice',?,?,'{}')`).run(`row-${id}`, id, 'conv-main', 's1', now, dir, id);
  }
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = 's1'`).run('2026-10-29T13:00:00.000Z');
  db.prepare(`UPDATE app_events SET rotation = 1 WHERE kind = 'session' AND seq = (SELECT MAX(seq) FROM app_events)`).run();
}

const schemaSql = (db: Database.Database) => db.prepare(`SELECT type, name, sql FROM sqlite_master
  WHERE (type = 'trigger' AND name LIKE 'app_%') OR (type = 'index' AND tbl_name = 'app_events' AND sql IS NOT NULL)
  ORDER BY type, name`).all();

describe('migration 043 app_events choice kind', () => {
  it('keeps every row, seq and rotation, and replays the same events', () => {
    const db = pre043();
    try {
      seed(db);
      const rowsBefore = db.prepare('SELECT * FROM app_events ORDER BY contact_id, seq').all();
      const replayBefore = readEvents(db, 'alice', 'agent:work', 0, 100);
      const triggersBefore = schemaSql(db);
      expect(rowsBefore).toHaveLength(4);

      runMigrations(db);

      const rowsAfter = (db.prepare('SELECT * FROM app_events ORDER BY contact_id, seq').all() as Record<string, unknown>[]);
      expect(rowsAfter.map(({ choice_prompt_id, ...rest }) => { expect(choice_prompt_id).toBeNull(); return rest; }))
        .toEqual(rowsBefore);
      expect(readEvents(db, 'alice', 'agent:work', 0, 100)).toEqual(replayBefore);
      // Triggers and indexes are recreated with the same definitions.
      expect(schemaSql(db)).toEqual(triggersBefore);
      expect(triggersBefore.filter((r: any) => r.type === 'trigger')).toHaveLength(3);
      expect(triggersBefore.filter((r: any) => r.type === 'index')).toHaveLength(2);
    } finally { db.close(); }
  });

  it('continues the per-contact seq through the triggers and accepts choice events', () => {
    const db = pre043();
    try {
      seed(db);
      runMigrations(db);
      db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES ('row-m3','m3','conv-main','s1','2026-10-29T14:00:00.000Z','app','alice','outbound','m3','{}')`).run();
      const last = db.prepare(`SELECT seq, kind, transcript_id FROM app_events WHERE contact_id = 'alice' ORDER BY seq DESC LIMIT 1`).get();
      expect(last).toEqual({ seq: 5, kind: 'message', transcript_id: 'row-m3' });
      expect(db.prepare('SELECT seq FROM app_event_counters WHERE contact_id = ?').get('alice')).toEqual({ seq: 5 });

      expect(recordChoiceEvent(db, { id: 'p1', bus_message_id: 'm3' })).toBe(true);
      expect(db.prepare(`SELECT seq, kind, session_id, transcript_id, choice_prompt_id FROM app_events
        WHERE contact_id = 'alice' ORDER BY seq DESC LIMIT 1`).get())
        .toEqual({ seq: 6, kind: 'choice', session_id: 's1', transcript_id: 'row-m3', choice_prompt_id: 'p1' });
      expect(() => db.prepare(`INSERT INTO app_events(contact_id,seq,kind,session_id,created_at)
        VALUES ('alice',7,'approval','s1','2026-10-29T14:00:01.000Z')`).run()).toThrow(/CHECK/);
      // The rollback-together guarantee of 024 still holds.
      expect(() => db.transaction(() => {
        db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
          VALUES ('row-x','x','conv-main','s1','2026-10-29T14:00:02.000Z','app','alice','inbound','x','{}')`).run();
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(db.prepare(`SELECT 1 FROM app_events WHERE transcript_id = 'row-x'`).get()).toBeUndefined();
    } finally { db.close(); }
  });

  it('is applied once on a fresh database', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      runMigrations(db);
      const cols = (db.prepare('PRAGMA table_info(app_events)').all() as { name: string }[]).map(c => c.name);
      expect(cols).toEqual(['contact_id', 'seq', 'kind', 'session_id', 'transcript_id', 'created_at', 'rotation', 'choice_prompt_id']);
    } finally { db.close(); }
  });
});
