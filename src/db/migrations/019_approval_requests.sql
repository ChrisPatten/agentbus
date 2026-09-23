-- Migration 019 — approval_requests table (E51 / S51.1)
--
-- Formal, backend-agnostic approvals subsystem: any backend adapter
-- (`cc-pool` today; `cc-headless`/`cc`/a future `codex-headless` tomorrow)
-- can raise "I'm blocked, a human needs to decide X" via
-- POST /api/v1/approvals. A per-user-adapter (Telegram first) then puts the
-- decision in front of the right human, and a per-backend-adapter resolution
-- step carries the answer back to whatever is still blocked. See
-- docs/APPROVALS.md and _bmad-output/epics/E51-approval-requests.md.
--
-- `raw_context` deliberately stays an opaque JSON blob rather than
-- normalized columns — the shape of "what a backend needed approved" will
-- differ across backends, and this table shouldn't need a migration every
-- time a new backend's payload looks slightly different.
--
-- Indexes:
--   idx_approval_requests_status — the expiry sweep's `pending`+`expires_at`
--   lookup (S51.6) and GET /api/v1/approvals?status=pending (S51.1).
--
-- Renumbered from the original E49/migration 017 (2026-09-22): a separate,
-- independently-pushed PR (#6, "Agent-managed knowledge store + per-session
-- context-block ledger") had already claimed E49/E50 and migrations 017/018
-- on GitHub, invisible to this epic's own numbering since that PR only ever
-- existed on its own branch, never merged into the `dev` checkout this
-- epic's number was picked from. Moved to E51/019 to resolve the collision
-- once PR #6 landed on `dev` first. No content changed beyond numbers.

CREATE TABLE IF NOT EXISTS approval_requests (
  id                TEXT PRIMARY KEY,                    -- uuid
  adapter_id        TEXT NOT NULL,                        -- 'cc-pool' today; the backend that raised it
  agent_id          TEXT NOT NULL,                        -- e.g. 'peggy-pool-1' (bare) — backend-specific target
  conversation_id   TEXT,                                 -- the conversation this pane/session was leased to, if known
  contact_id        TEXT NOT NULL,                         -- who gets asked — resolved from adapter_id+agent_id at request time
  tool_name         TEXT NOT NULL,                         -- e.g. 'Edit', 'Bash'
  summary           TEXT NOT NULL,                         -- short human-readable description of what's being asked
  raw_context       TEXT,                                  -- JSON blob: tool_input, cwd, etc. — for the notification body, not re-parsed
  status            TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | denied | expired | stale
  requested_at      TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,                                  -- contact_id who answered, or 'timeout'/'system'
  notify_channel    TEXT,                                  -- e.g. 'telegram' or 'telegram:peggy:group:-100...'
  notify_message_id TEXT,                                  -- platform message id, so the button message can be edited on resolution
  expires_at        TEXT NOT NULL                          -- requested_at + timeout; a scheduler-style sweep expires stale rows
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, expires_at);
