/**
 * Model override store and resolution (E53 S53.1).
 *
 * Backs the `model_overrides` table (migration 021): one row per agent, plus
 * at most one global row (agent_id IS NULL). Replaces the old
 * headless_model_overrides table, which also carried a schedule scope and a
 * priority column — both dropped. A job's model now lives on the schedule
 * itself (`scheduled_items.model`), carried to the adapters as
 * `metadata.schedule_model` on the fired envelope; see `resolveModel` below.
 *
 * Shared by `cc-headless` and `cc-pool`.
 */
import type Database from 'better-sqlite3';

export interface ModelOverride {
  id: number;
  agent_id: string | null;
  model: string;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve a model override for an agent, querying the `model_overrides`
 * table. Checks the agent-scoped row first, then falls back to the global
 * row (agent_id IS NULL).
 *
 * @param db - SQLite database connection
 * @param agentId - The agent's full recipient id (e.g. "agent:claude"), or
 *   null to only consider the global override
 * @returns The override model name, or null if no override is set
 */
export function resolveModelOverride(db: Database.Database, agentId: string | null): string | null {
  if (agentId) {
    const row = db
      .prepare(`SELECT model FROM model_overrides WHERE agent_id = ?`)
      .get(agentId) as { model: string } | undefined;
    if (row) return row.model;
  }

  const row = db
    .prepare(`SELECT model FROM model_overrides WHERE agent_id IS NULL`)
    .get() as { model: string } | undefined;
  return row?.model ?? null;
}

export type ModelSource = 'schedule' | 'agent-override' | 'global-override' | 'config' | 'cli-default';

export interface ResolvedModel {
  model: string | undefined;
  source: ModelSource;
}

/**
 * Resolve the model to launch/spawn with, in priority order:
 *
 *   1. `opts.scheduleModel`, if it's a non-empty string — the fired
 *      schedule's own `model`.
 *   2. An override scoped to `opts.agentId`.
 *   3. The global override.
 *   4. `opts.configModel` — the pool's or headless instance's configured
 *      `model`.
 *   5. Nothing (`undefined`) — the CLI's own default (`--model` omitted).
 *
 * Runs on the message hot path (every pane launch / headless spawn), so a
 * DB error here must never fail the caller: it's caught, logged, and
 * resolution falls through to `configModel` / `cli-default` as if no
 * override table existed.
 */
export function resolveModel(opts: {
  scheduleModel?: string | null;
  db?: Database.Database;
  agentId?: string | null;
  configModel?: string;
}): ResolvedModel {
  if (opts.scheduleModel && opts.scheduleModel.trim().length > 0) {
    return { model: opts.scheduleModel, source: 'schedule' };
  }

  if (opts.db) {
    try {
      const agentId = opts.agentId ?? null;
      if (agentId) {
        const row = opts.db
          .prepare(`SELECT model FROM model_overrides WHERE agent_id = ?`)
          .get(agentId) as { model: string } | undefined;
        if (row) return { model: row.model, source: 'agent-override' };
      }

      const globalRow = opts.db
        .prepare(`SELECT model FROM model_overrides WHERE agent_id IS NULL`)
        .get() as { model: string } | undefined;
      if (globalRow) return { model: globalRow.model, source: 'global-override' };
    } catch (err) {
      console.error('[model-override-loader] resolveModel: override lookup failed, falling through:', err);
    }
  }

  if (opts.configModel) {
    return { model: opts.configModel, source: 'config' };
  }

  return { model: undefined, source: 'cli-default' };
}

/**
 * List all active model overrides (agent-scoped rows first, then global),
 * newest-updated first within each group.
 */
export function listModelOverrides(db: Database.Database): ModelOverride[] {
  return db
    .prepare(
      `SELECT id, agent_id, model, created_at, updated_at
       FROM model_overrides
       ORDER BY agent_id IS NULL, updated_at DESC`,
    )
    .all() as ModelOverride[];
}

/**
 * Set (or update) a model override, scoped to an agent or global.
 *
 * @param db - SQLite database connection
 * @param model - The model name (e.g. "sonnet")
 * @param agentId - Agent id to scope to, or null/omitted for a global override
 * @returns The row id of the inserted/updated override
 */
export function setModelOverride(db: Database.Database, model: string, agentId?: string | null): number {
  const now = new Date().toISOString();
  const aId = agentId ?? null;

  db.prepare(
    `INSERT INTO model_overrides (agent_id, model, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(COALESCE(agent_id, '')) DO UPDATE SET
       model = excluded.model,
       updated_at = excluded.updated_at`,
  ).run(aId, model, now, now);

  const row = db.prepare(`SELECT id FROM model_overrides WHERE agent_id IS ?`).get(aId) as
    | { id: number }
    | undefined;
  return row?.id ?? 0;
}

/**
 * Delete a model override by scope.
 *
 * @param db - SQLite database connection
 * @param agentId - Agent id to delete, or null to delete the global override
 * @returns Number of rows deleted (0 or 1)
 */
export function deleteModelOverride(db: Database.Database, agentId: string | null): number {
  const result = db.prepare(`DELETE FROM model_overrides WHERE agent_id IS ?`).run(agentId);
  return result.changes;
}

/**
 * Clear all model overrides (agent-scoped and global). Irreversible.
 *
 * @param db - SQLite database connection
 * @returns Number of rows deleted
 */
export function clearAllModelOverrides(db: Database.Database): number {
  const result = db.prepare(`DELETE FROM model_overrides`).run();
  return result.changes;
}
