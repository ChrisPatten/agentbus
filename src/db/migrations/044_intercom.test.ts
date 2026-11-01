import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 044 — intercom', () => {
  it('creates the pairing, event and send tables and re-applies cleanly', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'intercom_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(['intercom_events', 'intercom_pair_codes', 'intercom_sends', 'intercom_surface_seq']);
    db.exec(`DELETE FROM schema_migrations WHERE version >= 44`);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
