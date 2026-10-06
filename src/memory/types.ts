/**
 * Shared row types for sessions and transcripts (session tracker, journaling).
 */

/** Row shape from the sessions table (post-migration 009). */
export interface SessionRow {
  id: string;
  conversation_id: string;
  channel: string;
  contact_id: string;
  started_at: string;
  last_activity: string;
  ended_at: string | null;
  message_count: number;
  status: string;
  summary_attempts: number;
  /** claude -p session ID stored by cc-headless for --resume continuity (migration 008) */
  claude_session_id: string | null;
  /** ISO timestamp of the last journaling turn for this session (E20, migration 009). */
  last_journaled_at: string | null;
  /** Owning cc-headless agent id (e.g. "agent:peggy"), or null (E23, migration 011). */
  agent_id: string | null;
  /** E66 journal cursor: created_at of the last transcript row a successful journal run covered (migration 026). */
  journal_cursor_at?: string | null;
}

/** Row shape from the transcripts table. */
export interface TranscriptRow {
  id: string;
  message_id: string;
  conversation_id: string;
  session_id: string;
  created_at: string;
  channel: string;
  contact_id: string;
  direction: string;
  body: string;
  metadata: string;
}
