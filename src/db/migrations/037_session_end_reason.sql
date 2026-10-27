-- Migration 037 — sessions.end_reason (E69 S69.3)
--
-- Why a session row ended: 'idle' (Main's idle rotation) or 'clear' (/clear).
-- The app shows it on Main's "new context" divider. NULL for rows ended
-- before this migration and for every other close path.
ALTER TABLE sessions ADD COLUMN end_reason TEXT;
