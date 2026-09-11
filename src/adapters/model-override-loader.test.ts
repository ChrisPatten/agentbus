/**
 * Tests for model override resolution logic.
 *
 * Verifies priority ordering, query results, and CRUD operations.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveModelOverride,
  listModelOverrides,
  setModelOverride,
  deleteModelOverride,
  clearAllModelOverrides,
} from './model-override-loader.js';

describe('model-override-loader', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE headless_model_overrides (
        id            INTEGER PRIMARY KEY,
        schedule_id   TEXT,
        agent_id      TEXT,
        model         TEXT NOT NULL,
        priority      INTEGER DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_model_overrides_schedule_agent
        ON headless_model_overrides (schedule_id, agent_id)
        WHERE schedule_id IS NOT NULL OR agent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_model_overrides_agent
        ON headless_model_overrides (agent_id);
      CREATE INDEX IF NOT EXISTS idx_model_overrides_schedule
        ON headless_model_overrides (schedule_id);
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('setModelOverride', () => {
    it('should set a global override', () => {
      const id = setModelOverride(db, 'claude-opus');
      expect(id).toBeGreaterThan(0);

      const row = db
        .prepare(`SELECT model FROM headless_model_overrides WHERE id = ?`)
        .get(id) as { model: string } | undefined;
      expect(row?.model).toBe('claude-opus');
    });

    it('should set an agent-specific override', () => {
      const id = setModelOverride(db, 'claude-opus', null, 'agent-foo');
      expect(id).toBeGreaterThan(0);

      const row = db
        .prepare(`SELECT model, agent_id FROM headless_model_overrides WHERE id = ?`)
        .get(id) as { model: string; agent_id: string } | undefined;
      expect(row?.model).toBe('claude-opus');
      expect(row?.agent_id).toBe('agent-foo');
    });

    it('should set a schedule-specific override', () => {
      const id = setModelOverride(db, 'claude-opus', 'schedule-123');
      expect(id).toBeGreaterThan(0);

      const row = db
        .prepare(`SELECT model, schedule_id FROM headless_model_overrides WHERE id = ?`)
        .get(id) as { model: string; schedule_id: string } | undefined;
      expect(row?.model).toBe('claude-opus');
      expect(row?.schedule_id).toBe('schedule-123');
    });

    it('should set a schedule + agent-specific override', () => {
      const id = setModelOverride(db, 'claude-opus', 'schedule-123', 'agent-foo');
      expect(id).toBeGreaterThan(0);

      const row = db
        .prepare(
          `SELECT model, schedule_id, agent_id FROM headless_model_overrides WHERE id = ?`
        )
        .get(id) as { model: string; schedule_id: string; agent_id: string } | undefined;
      expect(row?.model).toBe('claude-opus');
      expect(row?.schedule_id).toBe('schedule-123');
      expect(row?.agent_id).toBe('agent-foo');
    });

    it('should update an existing override', () => {
      const id1 = setModelOverride(db, 'claude-opus', null, 'agent-foo');
      const id2 = setModelOverride(db, 'claude-sonnet', null, 'agent-foo');

      // Should be the same ID (upsert)
      expect(id1).toBe(id2);

      const row = db
        .prepare(`SELECT model FROM headless_model_overrides WHERE id = ?`)
        .get(id1) as { model: string } | undefined;
      expect(row?.model).toBe('claude-sonnet');
    });

    it('should set priority', () => {
      const id = setModelOverride(db, 'claude-opus', null, 'agent-foo', 10);

      const row = db
        .prepare(`SELECT priority FROM headless_model_overrides WHERE id = ?`)
        .get(id) as { priority: number } | undefined;
      expect(row?.priority).toBe(10);
    });
  });

  describe('resolveModelOverride', () => {
    it('should resolve to global override when no scope specified', () => {
      setModelOverride(db, 'claude-opus-global');
      const result = resolveModelOverride(db);
      expect(result).toBe('claude-opus-global');
    });

    it('should resolve to agent override over global', () => {
      setModelOverride(db, 'claude-opus-global');
      setModelOverride(db, 'claude-sonnet-agent', null, 'agent-foo');

      const result = resolveModelOverride(db, undefined, 'agent-foo');
      expect(result).toBe('claude-sonnet-agent');
    });

    it('should resolve to schedule override over global', () => {
      setModelOverride(db, 'claude-opus-global');
      setModelOverride(db, 'claude-haiku-schedule', 'schedule-123');

      const result = resolveModelOverride(db, 'schedule-123');
      expect(result).toBe('claude-haiku-schedule');
    });

    it('should resolve to schedule+agent override as most specific', () => {
      setModelOverride(db, 'claude-opus-global');
      setModelOverride(db, 'claude-sonnet-agent', null, 'agent-foo');
      setModelOverride(db, 'claude-haiku-schedule', 'schedule-123');
      setModelOverride(db, 'claude-haiku-both', 'schedule-123', 'agent-foo');

      const result = resolveModelOverride(db, 'schedule-123', 'agent-foo');
      expect(result).toBe('claude-haiku-both');
    });

    it('should return null when no override found', () => {
      const result = resolveModelOverride(db, 'schedule-999', 'agent-999');
      expect(result).toBeNull();
    });

    it('should respect priority field on ties', () => {
      // Two global overrides with different priorities
      setModelOverride(db, 'claude-opus', null, null, 0);
      setModelOverride(db, 'claude-sonnet', null, null, 5);

      const result = resolveModelOverride(db);
      // Should return the one with higher priority
      expect(result).toBe('claude-sonnet');
    });

    it('should respect update timestamp on equal priority', () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO headless_model_overrides (schedule_id, agent_id, model, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(null, null, 'claude-opus', 0, now, now);

      // Wait a tiny bit and insert another
      const later = new Date(new Date().getTime() + 1).toISOString();
      db.prepare(
        `INSERT INTO headless_model_overrides (schedule_id, agent_id, model, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(null, 'agent-bar', 'claude-sonnet', 0, later, later);

      const result = resolveModelOverride(db, undefined, 'agent-bar');
      expect(result).toBe('claude-sonnet');
    });
  });

  describe('listModelOverrides', () => {
    it('should list all overrides ordered by specificity', () => {
      setModelOverride(db, 'global', null, null);
      setModelOverride(db, 'agent-only', null, 'agent-a');
      setModelOverride(db, 'schedule-only', 'schedule-1');
      setModelOverride(db, 'both', 'schedule-1', 'agent-a');

      const list = listModelOverrides(db);

      expect(list.length).toBe(4);
      // Most specific first
      expect(list[0]?.model).toBe('both');
      expect(list[1]?.model).toBe('agent-only');
      expect(list[2]?.model).toBe('schedule-only');
      expect(list[3]?.model).toBe('global');
    });

    it('should return empty list when no overrides', () => {
      const list = listModelOverrides(db);
      expect(list).toEqual([]);
    });
  });

  describe('deleteModelOverride', () => {
    it('should delete a specific override', () => {
      const id = setModelOverride(db, 'claude-opus', null, 'agent-foo');
      const deleted = deleteModelOverride(db, null, 'agent-foo');

      expect(deleted).toBe(1);

      const row = db
        .prepare(`SELECT id FROM headless_model_overrides WHERE id = ?`)
        .get(id) as { id: number } | undefined;
      expect(row).toBeUndefined();
    });

    it('should delete multiple overrides matching scope', () => {
      setModelOverride(db, 'model-1', 'schedule-123', 'agent-a');
      setModelOverride(db, 'model-2', 'schedule-123', 'agent-b');

      const deleted = deleteModelOverride(db, 'schedule-123');

      expect(deleted).toBe(2);
    });

    it('should return 0 when no match', () => {
      const deleted = deleteModelOverride(db, 'schedule-999', 'agent-999');
      expect(deleted).toBe(0);
    });
  });

  describe('clearAllModelOverrides', () => {
    it('should delete all overrides', () => {
      setModelOverride(db, 'model-1');
      setModelOverride(db, 'model-2', null, 'agent-a');
      setModelOverride(db, 'model-3', 'schedule-1');

      const deleted = clearAllModelOverrides(db);

      expect(deleted).toBe(3);

      const count = db
        .prepare(`SELECT COUNT(*) as cnt FROM headless_model_overrides`)
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });

    it('should return 0 when table is empty', () => {
      const deleted = clearAllModelOverrides(db);
      expect(deleted).toBe(0);
    });
  });
});
