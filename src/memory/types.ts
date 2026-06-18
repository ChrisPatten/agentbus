/**
 * Shared types for the E8 memory system (summarizer, session tracker, memories).
 */

/** A single memory extracted by the summarizer from a session transcript. */
export interface MemoryExtraction {
  contact_id: string;
  category: string;
  content: string;
  confidence: number;
  expires_at?: string | null;
}

/** The JSON shape returned by the Claude API summarization call. */
export interface SummaryResult {
  summary: string;
  key_topics: string[];
  decisions: string[];
  open_questions: string[];
  participants: string[];
  memories: MemoryExtraction[];
}

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

/** Row shape for the memories table. */
export interface MemoryRow {
  id: string;
  session_id: string | null;
  contact_id: string;
  category: string;
  content: string;
  confidence: number;
  source: string;
  created_at: string;
  expires_at: string | null;
  superseded_by: string | null;
}
