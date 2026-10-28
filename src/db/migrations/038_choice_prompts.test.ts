import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('migration 038 — choice_prompts table', () => {
  it('creates the table with the expected columns and status index', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const columns = db.prepare(`PRAGMA table_info(choice_prompts)`).all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name).sort()).toEqual(
      [
        'id', 'channel', 'topic', 'contact_id', 'labels', 'platform_message_id', 'bus_message_id',
        'status', 'chosen_index', 'answered_by', 'answered_at', 'created_at', 'expires_at', 'commands', 'buttons',
      ].sort(),
    );
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_choice_prompts_status'`).get();
    expect(idx).toBeTruthy();
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
