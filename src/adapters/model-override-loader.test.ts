/**
 * Tests for the model_overrides store and resolveModel().
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveModelOverride,
  resolveModel,
  listModelOverrides,
  setModelOverride,
  deleteModelOverride,
  clearAllModelOverrides,
} from './model-override-loader.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_overrides (
      id          INTEGER PRIMARY KEY,
      agent_id    TEXT,
      model       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_model_overrides_agent ON model_overrides (COALESCE(agent_id, ''));
  `);
  return db;
}

describe('model-override-loader', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('setModelOverride', () => {
    it('sets a global override', () => {
      const id = setModelOverride(db, 'opus');
      expect(id).toBeGreaterThan(0);
      const row = db.prepare(`SELECT model, agent_id FROM model_overrides WHERE id = ?`).get(id) as {
        model: string;
        agent_id: string | null;
      };
      expect(row.model).toBe('opus');
      expect(row.agent_id).toBeNull();
    });

    it('sets an agent-scoped override', () => {
      const id = setModelOverride(db, 'sonnet', 'agent:peggy');
      const row = db.prepare(`SELECT model, agent_id FROM model_overrides WHERE id = ?`).get(id) as {
        model: string;
        agent_id: string | null;
      };
      expect(row.model).toBe('sonnet');
      expect(row.agent_id).toBe('agent:peggy');
    });

    it('upserts on the same agent scope (same row id, new model)', () => {
      const id1 = setModelOverride(db, 'opus', 'agent:peggy');
      const id2 = setModelOverride(db, 'sonnet', 'agent:peggy');
      expect(id1).toBe(id2);
      const row = db.prepare(`SELECT model FROM model_overrides WHERE id = ?`).get(id1) as { model: string };
      expect(row.model).toBe('sonnet');
    });

    it('upserts on the global scope independently of agent scopes', () => {
      setModelOverride(db, 'opus');
      setModelOverride(db, 'haiku');
      setModelOverride(db, 'sonnet', 'agent:peggy');

      const rows = db.prepare(`SELECT agent_id, model FROM model_overrides ORDER BY agent_id`).all();
      expect(rows).toEqual([
        { agent_id: null, model: 'haiku' },
        { agent_id: 'agent:peggy', model: 'sonnet' },
      ]);
    });
  });

  describe('resolveModelOverride', () => {
    it('returns null when nothing is set', () => {
      expect(resolveModelOverride(db, 'agent:peggy')).toBeNull();
      expect(resolveModelOverride(db, null)).toBeNull();
    });

    it('resolves the global override when no agent override exists', () => {
      setModelOverride(db, 'opus');
      expect(resolveModelOverride(db, 'agent:peggy')).toBe('opus');
      expect(resolveModelOverride(db, null)).toBe('opus');
    });

    it('resolves the agent override over the global one', () => {
      setModelOverride(db, 'opus');
      setModelOverride(db, 'sonnet', 'agent:peggy');
      expect(resolveModelOverride(db, 'agent:peggy')).toBe('sonnet');
      expect(resolveModelOverride(db, 'agent:other')).toBe('opus');
    });
  });

  describe('resolveModel', () => {
    it('prefers a non-empty scheduleModel over everything else', () => {
      setModelOverride(db, 'opus', 'agent:peggy');
      const result = resolveModel({ scheduleModel: 'haiku', db, agentId: 'agent:peggy', configModel: 'sonnet' });
      expect(result).toEqual({ model: 'haiku', source: 'schedule' });
    });

    it('ignores an empty or whitespace-only scheduleModel', () => {
      setModelOverride(db, 'opus', 'agent:peggy');
      const result = resolveModel({ scheduleModel: '   ', db, agentId: 'agent:peggy' });
      expect(result).toEqual({ model: 'opus', source: 'agent-override' });
    });

    it('falls back to the agent override when there is no schedule model', () => {
      setModelOverride(db, 'sonnet', 'agent:peggy');
      const result = resolveModel({ db, agentId: 'agent:peggy', configModel: 'haiku' });
      expect(result).toEqual({ model: 'sonnet', source: 'agent-override' });
    });

    it('falls back to the global override when there is no agent override', () => {
      setModelOverride(db, 'opus');
      const result = resolveModel({ db, agentId: 'agent:peggy', configModel: 'haiku' });
      expect(result).toEqual({ model: 'opus', source: 'global-override' });
    });

    it('falls back to configModel when there is no override at all', () => {
      const result = resolveModel({ db, agentId: 'agent:peggy', configModel: 'haiku' });
      expect(result).toEqual({ model: 'haiku', source: 'config' });
    });

    it('falls back to cli-default when nothing resolves', () => {
      const result = resolveModel({ db, agentId: 'agent:peggy' });
      expect(result).toEqual({ model: undefined, source: 'cli-default' });
    });

    it('works without a db at all, using configModel', () => {
      const result = resolveModel({ configModel: 'haiku' });
      expect(result).toEqual({ model: 'haiku', source: 'config' });
    });

    it('never throws when the override table is missing, falling through to configModel', () => {
      const brokenDb = new Database(':memory:'); // no model_overrides table
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = resolveModel({ db: brokenDb, agentId: 'agent:peggy', configModel: 'haiku' });
      expect(result).toEqual({ model: 'haiku', source: 'config' });
      expect(consoleErr).toHaveBeenCalled();
      consoleErr.mockRestore();
      brokenDb.close();
    });

    it('never throws when the override table is missing and there is no configModel either', () => {
      const brokenDb = new Database(':memory:');
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = resolveModel({ db: brokenDb, agentId: 'agent:peggy' });
      expect(result).toEqual({ model: undefined, source: 'cli-default' });
      consoleErr.mockRestore();
      brokenDb.close();
    });
  });

  describe('listModelOverrides', () => {
    it('lists agent-scoped rows before the global row', () => {
      setModelOverride(db, 'global-model');
      setModelOverride(db, 'agent-model', 'agent:peggy');

      const list = listModelOverrides(db);
      expect(list.length).toBe(2);
      expect(list[0]?.model).toBe('agent-model');
      expect(list[1]?.model).toBe('global-model');
    });

    it('returns an empty list when there are no overrides', () => {
      expect(listModelOverrides(db)).toEqual([]);
    });
  });

  describe('deleteModelOverride', () => {
    it('deletes the agent-scoped override', () => {
      setModelOverride(db, 'opus', 'agent:peggy');
      expect(deleteModelOverride(db, 'agent:peggy')).toBe(1);
      expect(resolveModelOverride(db, 'agent:peggy')).toBeNull();
    });

    it('deletes only the global override', () => {
      setModelOverride(db, 'opus');
      setModelOverride(db, 'sonnet', 'agent:peggy');
      expect(deleteModelOverride(db, null)).toBe(1);
      expect(resolveModelOverride(db, null)).toBeNull();
      expect(resolveModelOverride(db, 'agent:peggy')).toBe('sonnet');
    });

    it('returns 0 when there is no match', () => {
      expect(deleteModelOverride(db, 'agent:nobody')).toBe(0);
    });
  });

  describe('clearAllModelOverrides', () => {
    it('deletes every override', () => {
      setModelOverride(db, 'opus');
      setModelOverride(db, 'sonnet', 'agent:peggy');
      expect(clearAllModelOverrides(db)).toBe(2);
      expect(listModelOverrides(db)).toEqual([]);
    });

    it('returns 0 when the table is already empty', () => {
      expect(clearAllModelOverrides(db)).toBe(0);
    });
  });
});
