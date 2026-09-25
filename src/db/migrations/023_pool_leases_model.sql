-- Migration 023 — per-lease model (E53 S53.4)
--
-- The model the pane's CURRENT Claude session was launched with. NULL means
-- either the pane is free, or it was launched with no --model flag (CLI
-- default via ~/.claude/settings.json). Set by PoolManager.resolveRoute()
-- alongside confirmReady() on every bound/grow/evict launch and on an
-- in-place relaunch triggered by a model mismatch on reuse (S53.5); cleared
-- on release() and reset to NULL on every fresh claim, same as
-- claude_session_id.

ALTER TABLE pool_leases ADD COLUMN model TEXT;
