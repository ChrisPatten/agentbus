import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSafeDatabase } from './safe-database.js';

describe('SafeDatabase', () => {
  it('allows .get() for read queries', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('alice');

    const safe = createSafeDatabase(db);
    const row = safe.prepare<{ id: number; name: string }>('SELECT * FROM t WHERE name = ?').get('alice');
    expect(row).toEqual({ id: 1, name: 'alice' });
  });

  it('allows .all() for read queries', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('alice');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('bob');

    const safe = createSafeDatabase(db);
    const rows = safe.prepare<{ name: string }>('SELECT name FROM t ORDER BY name').all();
    expect(rows).toEqual([{ name: 'alice' }, { name: 'bob' }]);
  });

  it('does not expose .run() for write operations', () => {
    const db = new Database(':memory:');
    const safe = createSafeDatabase(db);
    const stmt = safe.prepare('SELECT 1');
    expect((stmt as unknown as Record<string, unknown>)['run']).toBeUndefined();
  });

  it('does not expose .exec() on the database', () => {
    const db = new Database(':memory:');
    const safe = createSafeDatabase(db);
    expect((safe as unknown as Record<string, unknown>)['exec']).toBeUndefined();
  });
});
