-- Migration 021 — model_overrides table (E53 S53.1)
--
-- Replaces headless_model_overrides (migration 015). A job's model now lives
-- on the schedule itself (scheduled_items.model, migration 022), so the
-- override store only ever needs two scopes: one row per agent, and one
-- global row. `priority` is dropped — with at most one row per key there is
-- nothing left to break a tie on.
--
-- The COALESCE(agent_id, '') unique index lets a single ON CONFLICT target
-- cover both the agent-scoped and the global (NULL) row, which is the fix
-- for the P0 bug tracked in _bmad-output/maintenance-backlog.md: the old
-- table's unique index was partial (WHERE schedule_id IS NOT NULL OR
-- agent_id IS NOT NULL) and excluded the global row entirely, so no
-- ON CONFLICT target could ever match a global upsert.
--
-- Data migration: copy the newest row per agent_id (including the global
-- NULL key) from schedule-less rows (schedule_id IS NULL) in
-- headless_model_overrides, then drop that table. Rows that were
-- schedule-scoped (schedule_id IS NOT NULL) are dropped without a
-- replacement — nothing in the operator's database used that scope (see the
-- epic's Prior Art section), and this migration has no logging mechanism to
-- report a count.

CREATE TABLE model_overrides (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT,               -- NULL = global
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO model_overrides (agent_id, model, created_at, updated_at)
SELECT h.agent_id, h.model, h.created_at, h.updated_at
FROM headless_model_overrides h
WHERE h.schedule_id IS NULL
  AND h.id = (
    SELECT h2.id
    FROM headless_model_overrides h2
    WHERE h2.schedule_id IS NULL
      AND h2.agent_id IS h.agent_id
    ORDER BY h2.updated_at DESC, h2.id DESC
    LIMIT 1
  );

-- Migration 015's headless_model_overrides carried its own idx_model_overrides_agent
-- index (a plain, non-unique index on agent_id); drop the table — and with it,
-- that index — before creating the new unique index of the same name below.
DROP TABLE headless_model_overrides;

CREATE UNIQUE INDEX idx_model_overrides_agent ON model_overrides (COALESCE(agent_id, ''));
