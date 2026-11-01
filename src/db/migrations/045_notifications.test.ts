import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 045 — notifications', () => {
  it('creates the table, enforces key uniqueness among open rows, and re-applies cleanly', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const ins = (id: string, state: string) => db.prepare(`INSERT INTO notifications(id,key,title,source,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, 'k', 't', 's', state, 'x', 'x');
    ins('a', 'active');
    expect(() => ins('b', 'acknowledged')).toThrow();
    db.prepare(`UPDATE notifications SET state='resolved' WHERE id='a'`).run();
    expect(() => ins('b', 'active')).not.toThrow();
    db.exec(`DELETE FROM schema_migrations WHERE version >= 45`);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
