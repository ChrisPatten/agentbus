-- Migration 037 — sessions.end_reason and app_events.rotation (E69 S69.3)
--
-- sessions.end_reason: why a session row ended, 'idle' (Main's idle
-- rotation) or 'clear' (/clear). The app shows it on Main's "new context"
-- divider. NULL for rows ended before this migration and for every other
-- close path.
--
-- app_events.rotation: 1 on the session event recorded when a Main row
-- ended through rotation (set by rotateMainSession). Replay adds `rotated`
-- to that event alone. 0 for every other event.
ALTER TABLE sessions ADD COLUMN end_reason TEXT;
ALTER TABLE app_events ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
