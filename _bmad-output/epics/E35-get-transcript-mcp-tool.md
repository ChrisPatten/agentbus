# E35 — `get_transcript` MCP Tool: Full Session Transcript by ID

| Field | Value |
|---|---|
| Epic ID | E35 |
| Dependencies | None. Builds on the existing `transcripts` table (E8/E30/E31) and mirrors the existing `GET /api/v1/sessions/:id` pattern (`src/http/api.ts:800`). |
| Story Count | 3 |
| Estimated Complexity | S |

---

## Epic Summary

1. An agent today has two ways to look at past conversation history:
   `search_transcripts` (FTS5 keyword search, returns scattered matching
   snippets with no surrounding context) and `get_session`/`list_sessions`
   (session metadata + an optional AI-generated summary, no message
   content). **Neither returns the full, ordered message-by-message history
   of a specific session.** If a memory file references "see the
   conversation where X was discussed" or a `list_sessions` result surfaces
   a relevant prior session, there is no tool-level way to actually read
   that session's transcript — only a raw DB query.
2. The `transcripts` table already has everything needed: every row carries
   `session_id`, `created_at`, `channel`, `contact_id`, `direction`
   (`'inbound'` / outbound, per E31), and `body`
   (`src/pipeline/stages/transcript-log.ts:122`). Since E31 shipped
   (2026-08-31), this table is a complete two-sided record — outbound
   replies are logged alongside inbound messages, not just one side of the
   conversation.
3. **Fix is small and mirrors an existing pattern exactly**: add a new
   `GET /api/v1/sessions/:id/transcript` endpoint (same file, same style as
   the adjacent `GET /api/v1/sessions/:id` at `src/http/api.ts:800` and the
   FTS5 endpoint at `:683`) that selects all `transcripts` rows for that
   `session_id`, ordered by `created_at ASC`, and a thin `get_transcript`
   MCP tool (`src/mcp/tools/sessions.ts`, alongside `get_session`/
   `list_sessions`) that calls it. No schema change, no migration — purely
   additive read access to data that already exists.

---

## Entry Criteria

- None. Purely additive: new endpoint, new MCP tool, no changes to any
  existing endpoint/tool/schema.

---

## Exit Criteria

1. `get_transcript(session_id)` returns every `transcripts` row for that
   session, in chronological order, each with at minimum: `message_id`,
   `direction`, `channel`, `contact_id`, `body`, `created_at`.
2. A session with zero transcript rows (edge case — shouldn't normally
   happen, but e.g. a session created without any logged messages) returns
   an empty list, not an error.
3. An unknown `session_id` returns a clear "not found" result (matching
   `get_session`'s existing 404 → `{ available: false, reason: ... }`
   pattern), not a raw empty array indistinguishable from "no messages."
4. Large sessions are protected by a `limit`/pagination parameter so a
   very long-running session's full history can't blow out a single
   response — mirrors `list_sessions`'/`search_transcripts`' existing
   `limit` (default/max) convention.

---

## Stories

### S35.1 — `GET /api/v1/sessions/:id/transcript` endpoint

**User story:** As an agent, I want to fetch the ordered message history for
a specific session by ID, so I can pull real conversation context instead of
only a summary or scattered search snippets.

**Acceptance criteria:**
1. New route in `src/http/api.ts`, placed alongside `GET
   /api/v1/sessions/:id` (after line ~841, before the attachments endpoint).
2. First checks the session exists (`SELECT id FROM sessions WHERE id = ?`)
   — 404 with `{ ok: false, error: 'Session not found' }` if not, matching
   the existing `GET /api/v1/sessions/:id` 404 shape exactly.
3. Query: `SELECT message_id, session_id, channel, contact_id, direction,
   body, created_at FROM transcripts WHERE session_id = ? ORDER BY
   created_at ASC LIMIT ?` — chronological order (oldest first), the natural
   reading order for a transcript, in contrast to `search_transcripts`'
   `DESC` (most-recent-relevant-match-first).
4. Supports `?limit=` (default 200, max 1000 — sessions can run to hundreds
   of turns; higher ceiling than `list_sessions`'/`search_transcripts`' 100
   since a single session's transcript, not a fan-out across sessions, is
   the unit here) and `?since=`/`?before=` (`created_at` cursors) for
   pagination through a very long session without one giant payload.
5. Returns `{ ok: true, transcript: [...], count: N }`.

**Complexity:** S

### S35.2 — `get_transcript` MCP tool

**User story:** As an agent, I want a `get_transcript` tool I can call
directly, no manual HTTP/DB work.

**Acceptance criteria:**
1. New tool registered in `src/mcp/tools/sessions.ts` (alongside
   `get_session`/`list_sessions`, same file, same `registerSessionTools`
   function) named `get_transcript`.
2. Input schema: `session_id` (required, string), `limit` (optional,
   int, positive, max 1000, default 200), `since`/`before` (optional ISO
   timestamps, ~mirrors `search_transcripts`' `since` param style).
3. Calls `GET /api/v1/sessions/:id/transcript` with the query params,
   returns `toolSuccess({ available: false, reason: ... })` on a 404
   (matching `get_session`'s existing not-found handling), otherwise
   `toolSuccess({ transcript, count })`.
4. Tool description explicitly mentions the intended use case: pulling full
   context for a session surfaced by `list_sessions` or referenced in a
   memory file, as a complement to `search_transcripts` (keyword-driven,
   cross-session) and `get_session` (metadata + summary only, no message
   content).

**Complexity:** S

### S35.3 — Tests, docs

**User story:** As a maintainer, I want this covered by tests and
documented so it's discoverable and doesn't regress silently.

**Acceptance criteria:**
1. Endpoint tests: a session with N inbound+outbound rows round-trips in
   correct chronological order; an unknown session_id 404s; `limit`
   truncates correctly; `since`/`before` cursors filter correctly; a
   session with zero rows returns an empty array, not an error.
2. MCP tool test: mirrors the endpoint tests through the tool layer,
   confirms the not-found → `available: false` shape.
3. `docs/MCP_TOOLS.md` gets a `get_transcript` section (same style as the
   existing `get_session`/`list_sessions`/`search_transcripts` entries),
   noting how it complements the other two memory-lookup tools.
4. `CHANGELOG.md` entry under `[Unreleased]`.

**Complexity:** S

---

## Notes

- **Why this only makes sense well after E31.** Before E31 (2026-08-31),
  `transcripts` only ever held inbound rows — a "full transcript" would have
  silently been half a conversation (the agent's own replies missing). E31
  closed that gap same-day, so a full-transcript tool now returns something
  actually complete rather than a misleadingly one-sided record. Listed as
  "no dependency" above because nothing about E35's own implementation
  requires E31 to exist first — but its *value* would have been
  meaningfully smaller before E31 shipped.
- **Relationship to `search_transcripts`**: deliberately not a replacement.
  `search_transcripts` answers "where was X mentioned, across sessions,"
  ranked by relevance; `get_transcript` answers "show me everything that
  happened in this one specific session, in order." Different shapes for
  different questions — both stay.
- **Relationship to `get_session`**: `get_session` already returns metadata
  + an optional AI-generated summary; deliberately not folding transcript
  content into that response (would bloat every `get_session` call, even
  when only metadata is wanted) — kept as a separate, opt-in tool instead.
- **Origin**: backlog item never promoted since first written; picked as a
  "quick win" during a 2026-08-31 open-backlog review alongside the slash
  command cleanup (a separate, unrelated item handled directly as a
  no-epic prompt rather than a formal epic).
