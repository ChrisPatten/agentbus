-- Migration 033 — self-edit proposals (E68 / S68.3)
--
-- An agent proposes a change to one of its protected files (CLAUDE.md, the
-- system prompt file, skills/, .claude/, …) with the propose_change MCP tool
-- or a script journaler's `proposals[]`. Each owner gets an approval request
-- (approval_requests, adapter_id 'self-edit') with the rationale and a
-- compact diff. The first answer wins: on approve the bus writes the file if
-- its hash still equals base_hash (else the proposal is stale), on deny it
-- records a denied-approval feedback event. Proposals expire after 7 days;
-- at most 3 per agent per day.
CREATE TABLE IF NOT EXISTS self_edit_proposals (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,      -- prefixed logical id
  path          TEXT NOT NULL,      -- as shown to owners (relative to the working dir when inside it)
  abs_path      TEXT NOT NULL,
  base_hash     TEXT NOT NULL,      -- sha256 of the file when proposed, or 'absent'
  new_content   TEXT NOT NULL,
  new_hash      TEXT NOT NULL,
  diff          TEXT NOT NULL,      -- compact unified diff shown to owners
  rationale     TEXT NOT NULL,
  evidence      TEXT,               -- JSON array of strings
  source        TEXT NOT NULL,      -- 'mcp' | 'script' | 'api'
  run_id        TEXT,               -- journal run that proposed it, when known
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'denied', 'stale', 'expired', 'failed')),
  status_reason TEXT,
  approval_ids  TEXT,               -- JSON array of approval_requests.id, one per owner
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_self_edit_proposals_agent ON self_edit_proposals (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_self_edit_proposals_pending ON self_edit_proposals (status, expires_at);
