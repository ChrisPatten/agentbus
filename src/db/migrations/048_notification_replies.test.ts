import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 048 — notification replies', () => {
  it('adds the reply columns, null for existing rows', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO notifications(id,title,source,created_at,updated_at) VALUES ('a','t','s','x','x')`).run();
    const row = db.prepare(`SELECT reply, replied_at, reply_via, resolution FROM notifications WHERE id='a'`).get();
    expect(row).toEqual({ reply: null, replied_at: null, reply_via: null, resolution: null });
    db.close();
  });
});
