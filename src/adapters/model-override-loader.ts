/**
 * Headless model override loader.
 *
 * Queries the headless_model_overrides table on spawn to resolve which model
 * to use for a Claude invocation, respecting priority ordering.
 *
 * Priority (first match wins):
 *   1. (schedule_id + agent_id) — most specific override
 *   2. agent_id only
 *   3. schedule_id only
 *   4. global (both null)
 */
import type Database from 'better-sqlite3';

interface ModelOverride {
  id: number;
  schedule_id: string | null;
  agent_id: string | null;
  model: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the model for a headless Claude spawn, querying the override table.
 *
 * @param db - SQLite database connection
 * @param scheduleId - Optional schedule ID (for time-based or recurring spawns)
 * @param agentId - Optional agent ID (for agent-specific overrides)
 * @returns The override model name, or null if no override found
 */
export function resolveModelOverride(
  db: Database.Database,
  scheduleId?: string | null,
  agentId?: string | null,
): string | null {
  // Priority 1: both schedule_id and agent_id match
  if (scheduleId && agentId) {
    const row = db
      .prepare(
        `SELECT model FROM headless_model_overrides
         WHERE schedule_id = ? AND agent_id = ?
         ORDER BY priority DESC, updated_at DESC LIMIT 1`,
      )
      .get(scheduleId, agentId) as { model: string } | undefined;
    if (row) return row.model;
  }

  // Priority 2: agent_id only (any schedule)
  if (agentId) {
    const row = db
      .prepare(
        `SELECT model FROM headless_model_overrides
         WHERE agent_id = ? AND schedule_id IS NULL
         ORDER BY priority DESC, updated_at DESC LIMIT 1`,
      )
      .get(agentId) as { model: string } | undefined;
    if (row) return row.model;
  }

  // Priority 3: schedule_id only (any agent)
  if (scheduleId) {
    const row = db
      .prepare(
        `SELECT model FROM headless_model_overrides
         WHERE schedule_id = ? AND agent_id IS NULL
         ORDER BY priority DESC, updated_at DESC LIMIT 1`,
      )
      .get(scheduleId) as { model: string } | undefined;
    if (row) return row.model;
  }

  // Priority 4: global override (both null)
  const row = db
    .prepare(
      `SELECT model FROM headless_model_overrides
       WHERE schedule_id IS NULL AND agent_id IS NULL
       ORDER BY priority DESC, updated_at DESC LIMIT 1`,
    )
    .get() as { model: string } | undefined;
  return row?.model ?? null;
}

/**
 * List all active model overrides.
 *
 * @param db - SQLite database connection
 * @returns Array of all overrides, ordered by specificity
 */
export function listModelOverrides(db: Database.Database): ModelOverride[] {
  return db
    .prepare(
      `SELECT id, schedule_id, agent_id, model, priority, created_at, updated_at
       FROM headless_model_overrides
       ORDER BY
         CASE
           WHEN schedule_id IS NOT NULL AND agent_id IS NOT NULL THEN 1
           WHEN agent_id IS NOT NULL THEN 2
           WHEN schedule_id IS NOT NULL THEN 3
           ELSE 4
         END,
         priority DESC,
         updated_at DESC`,
    )
    .all() as ModelOverride[];
}

/**
 * Set a model override. Replaces any existing override for the same (schedule_id, agent_id) combo.
 *
 * @param db - SQLite database connection
 * @param model - The model name (e.g. "claude-3-5-opus-20241022")
 * @param scheduleId - Optional schedule ID
 * @param agentId - Optional agent ID
 * @param priority - Optional priority (default 0); higher wins on tie
 * @returns The updated/inserted override row ID
 */
export function setModelOverride(
  db: Database.Database,
  model: string,
  scheduleId?: string | null,
  agentId?: string | null,
  priority?: number,
): number {
  const now = new Date().toISOString();
  const p = priority ?? 0;
  const sId = scheduleId ?? null;
  const aId = agentId ?? null;

  // Check if a row exists for this (schedule_id, agent_id) combo
  const existing = db
    .prepare(
      `SELECT id FROM headless_model_overrides
       WHERE schedule_id IS ? AND agent_id IS ?`,
    )
    .get(sId, aId) as { id: number } | undefined;

  if (existing) {
    // Update existing
    db.prepare(
      `UPDATE headless_model_overrides
       SET model = ?, priority = ?, updated_at = ?
       WHERE id = ?`,
    ).run(model, p, now, existing.id);
    return existing.id;
  } else {
    // Insert new
    db.prepare(
      `INSERT INTO headless_model_overrides (schedule_id, agent_id, model, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sId, aId, model, p, now, now);

    // Fetch the ID of the row we just inserted
    const row = db
      .prepare(
        `SELECT id FROM headless_model_overrides
         WHERE schedule_id IS ? AND agent_id IS ? AND model = ?`,
      )
      .get(sId, aId, model) as { id: number } | undefined;

    return row?.id ?? 0;
  }
}

/**
 * Clear a specific model override or group of overrides by scope.
 *
 * If both scheduleId and agentId are provided, deletes the specific (schedule_id, agent_id) pair.
 * If only scheduleId is provided, deletes all overrides for that schedule (any agent).
 * If only agentId is provided, deletes all overrides for that agent (any schedule).
 *
 * @param db - SQLite database connection
 * @param scheduleId - Optional schedule ID
 * @param agentId - Optional agent ID
 * @returns Number of rows deleted
 */
export function deleteModelOverride(
  db: Database.Database,
  scheduleId?: string | null,
  agentId?: string | null,
): number {
  let where = '';
  const params: Array<string | null> = [];

  if (scheduleId && agentId) {
    where = 'WHERE schedule_id IS ? AND agent_id IS ?';
    params.push(scheduleId, agentId);
  } else if (scheduleId) {
    where = 'WHERE schedule_id IS ?';
    params.push(scheduleId);
  } else if (agentId) {
    where = 'WHERE agent_id IS ?';
    params.push(agentId);
  } else {
    // Neither specified — delete nothing to prevent accidental wipe
    return 0;
  }

  const stmt = db.prepare(`DELETE FROM headless_model_overrides ${where}`);
  const result = stmt.run(...params);
  return result.changes;
}

/**
 * Clear all model overrides (caution: irreversible).
 *
 * @param db - SQLite database connection
 * @returns Number of rows deleted
 */
export function clearAllModelOverrides(db: Database.Database): number {
  const result = db.prepare(`DELETE FROM headless_model_overrides`).run();
  return result.changes;
}
