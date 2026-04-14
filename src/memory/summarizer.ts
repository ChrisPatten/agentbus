/**
 * E8 — Summarizer Pipeline (S8.3)
 *
 * Calls the Claude API with a session's full transcript and extracts structured
 * memories. On success, writes to session_summaries and memories tables and
 * marks the session as 'summarized'. On failure, marks as 'summarize_failed'
 * and increments summary_attempts.
 *
 * Graceful degradation: if ANTHROPIC_API_KEY is not set, summarize() is a
 * no-op — sessions are still tracked and closed, but not summarized.
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';
import type { SummaryResult, TranscriptRow, MemoryExtraction, SessionRow } from './types.js';

/** Max input context tokens to use (conservative estimate for Sonnet). */
const MAX_INPUT_TOKENS = 180_000;
/** Fraction of the max to use before truncating the transcript. */
const BUDGET_FRACTION = 0.8;
/** Characters per token heuristic. */
const CHARS_PER_TOKEN = 4;

const SYSTEM_PROMPT = `You are a conversation summarizer for a personal messaging assistant. Analyze the following conversation transcript and produce a JSON object with this exact structure:

{
  "summary": "A concise 2-4 sentence summary of the conversation",
  "key_topics": ["topic1", "topic2"],
  "decisions": ["Any decisions that were made during the conversation"],
  "open_questions": ["Unresolved questions or pending action items"],
  "participants": ["contact_id_1", "contact_id_2"],
  "memories": [
    {
      "contact_id": "the person this fact is about",
      "category": "preference|fact|plan|relationship|work|health|general",
      "content": "A specific, atomic fact worth remembering in future conversations",
      "confidence": 0.9
    }
  ]
}

Rules for memories:
- Extract only facts that would be useful in future conversations with this contact
- Each memory should be a single, specific fact (not a summary of the conversation)
- Confidence scoring: 1.0 = explicitly stated by the person, 0.7-0.9 = strongly implied, 0.5-0.7 = reasonably inferred, below 0.5 = speculative (omit these)
- Categories: preference (likes/dislikes/preferences), fact (biographical information), plan (future intentions or scheduled events), relationship (connections between people), work (professional/career information), health (medical/wellness), general (other useful facts)
- Do NOT create memories for transient or ephemeral information (greetings, weather today, one-time requests)
- If the conversation has no memorable facts, return an empty memories array

Return ONLY the JSON object, no additional text, no markdown code fences.`;

/** Parse JSON from Claude's response, handling optional markdown code fences. */
function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  // Strip markdown code fences if present
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return JSON.parse(withoutFences);
}

/** Validate that the parsed JSON matches the SummaryResult shape. */
function validateSummaryResult(raw: unknown): SummaryResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('Response is not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj['summary'] !== 'string') throw new Error('Missing or invalid summary field');
  const result: SummaryResult = {
    summary: obj['summary'] as string,
    key_topics: Array.isArray(obj['key_topics']) ? (obj['key_topics'] as string[]) : [],
    decisions: Array.isArray(obj['decisions']) ? (obj['decisions'] as string[]) : [],
    open_questions: Array.isArray(obj['open_questions']) ? (obj['open_questions'] as string[]) : [],
    participants: Array.isArray(obj['participants']) ? (obj['participants'] as string[]) : [],
    memories: [],
  };
  if (Array.isArray(obj['memories'])) {
    for (const m of obj['memories'] as unknown[]) {
      if (typeof m !== 'object' || m === null) continue;
      const mem = m as Record<string, unknown>;
      if (typeof mem['contact_id'] !== 'string') continue;
      if (typeof mem['content'] !== 'string') continue;
      const extraction: MemoryExtraction = {
        contact_id: mem['contact_id'] as string,
        category: typeof mem['category'] === 'string' ? (mem['category'] as string) : 'general',
        content: mem['content'] as string,
        confidence:
          typeof mem['confidence'] === 'number'
            ? Math.min(1, Math.max(0, mem['confidence'] as number))
            : 0.8,
        expires_at:
          typeof mem['expires_at'] === 'string' ? (mem['expires_at'] as string) : null,
      };
      result.memories.push(extraction);
    }
  }
  return result;
}

export class Summarizer {
  private client: Anthropic | null = null;
  private db: Database.Database;
  private config: AppConfig;
  private disabled = false;

  constructor(deps: { db: Database.Database; config: AppConfig }) {
    this.db = deps.db;
    this.config = deps.config;

    if (!process.env['ANTHROPIC_API_KEY']) {
      console.warn('[summarizer] ANTHROPIC_API_KEY not set — summarization disabled');
      this.disabled = true;
    } else {
      this.client = new Anthropic();
    }
  }

  /** Summarize a completed session. Returns true on success. */
  async summarize(sessionId: string): Promise<boolean> {
    if (this.disabled) return false;

    const session = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;

    if (!session) {
      console.error(`[summarizer] Session not found: ${sessionId}`);
      return false;
    }

    // Fetch transcript rows ordered chronologically.
    // Exclude command responses (slash commands): their output is system artefacts,
    // not conversation content, and should not be extracted as memories.
    const transcripts = this.db
      .prepare(
        `SELECT direction, body, created_at, contact_id FROM transcripts
         WHERE session_id = ?
           AND json_extract(metadata, '$.command_response') IS NOT 1
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as TranscriptRow[];

    if (transcripts.length === 0) {
      // Nothing to summarize — mark as done.
      // Note: no session_summaries row is written for empty sessions.
      this.db
        .prepare(`UPDATE sessions SET status = 'summarized' WHERE id = ?`)
        .run(sessionId);
      return true;
    }

    // Build transcript text and apply token budget guard
    let lines = transcripts.map((t) => {
      const who = t.direction === 'inbound' ? `[${t.contact_id}]` : '[agent]';
      const time = t.created_at.slice(11, 16);
      return `${time} ${who}: ${t.body}`;
    });

    const maxInputChars = MAX_INPUT_TOKENS * BUDGET_FRACTION * CHARS_PER_TOKEN;
    const fullText = lines.join('\n');
    let transcriptText = fullText;

    if (fullText.length > maxInputChars) {
      // Keep most recent messages (truncate from the front)
      const truncatedLines: string[] = [];
      let charCount = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineLen = (lines[i]?.length ?? 0) + 1;
        if (charCount + lineLen > maxInputChars) break;
        truncatedLines.unshift(lines[i]!);
        charCount += lineLen;
      }
      transcriptText = `[Earlier messages truncated]\n${truncatedLines.join('\n')}`;
      console.warn(
        `[summarizer] Transcript for session ${sessionId.slice(0, 8)} truncated ` +
          `(${fullText.length} chars → ${transcriptText.length} chars)`,
      );
    }

    // Call Claude API with retry + exponential backoff
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.client!.messages.create({
          model: this.config.memory.claude_api_model,
          max_tokens: this.config.memory.summary_max_tokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: transcriptText }],
        });

        const rawText =
          response.content[0]?.type === 'text' ? response.content[0].text : '';

        let result: SummaryResult;
        try {
          result = validateSummaryResult(parseJsonResponse(rawText));
        } catch (parseErr) {
          console.error(
            `[summarizer] Failed to parse JSON for session ${sessionId.slice(0, 8)}:`,
            parseErr,
            '\nRaw response:',
            rawText.slice(0, 500),
          );
          throw parseErr;
        }

        const tokenCount =
          (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0);

        // Write results atomically
        this.db.transaction(() => {
          const summaryId = randomUUID();
          const now = new Date().toISOString();

          this.db
            .prepare(
              `INSERT INTO session_summaries
                 (id, session_id, created_at, channel, contact_id, started_at, ended_at, summary, model, token_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              summaryId,
              sessionId,
              now,
              session.channel,
              session.contact_id,
              session.started_at,
              session.ended_at ?? now,
              JSON.stringify(result),
              this.config.memory.claude_api_model,
              tokenCount,
            );

          for (const mem of result.memories) {
            this.insertMemory(mem, sessionId);
          }

          this.db
            .prepare(`UPDATE sessions SET status = 'summarized' WHERE id = ?`)
            .run(sessionId);
        })();

        return true;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          const delayMs = 1000 * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    // All attempts exhausted
    console.error(
      `[summarizer] Failed to summarize session ${sessionId.slice(0, 8)} after 3 attempts:`,
      lastError,
    );
    this.db
      .prepare(
        `UPDATE sessions SET status = 'summarize_failed', summary_attempts = summary_attempts + 1
         WHERE id = ?`,
      )
      .run(sessionId);
    return false;
  }

  /** Retry a previously failed summarization. */
  async retrySummarize(sessionId: string): Promise<boolean> {
    const session = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;

    if (!session) return false;

    // Clean up any partial summary from a previous attempt
    this.db
      .prepare(`DELETE FROM session_summaries WHERE session_id = ?`)
      .run(sessionId);

    // Reset attempt counter and status
    this.db
      .prepare(`UPDATE sessions SET status = 'summarize_pending', summary_attempts = 0 WHERE id = ?`)
      .run(sessionId);

    return this.summarize(sessionId);
  }

  /** Insert a memory with supersession of the previous memory for the same (contact_id, category). */
  private insertMemory(mem: MemoryExtraction, sessionId: string): void {
    const now = new Date().toISOString();
    const newId = randomUUID();

    // Supersede existing active memory for same (contact_id, category)
    const existing = this.db
      .prepare(
        `SELECT id FROM memories
         WHERE contact_id = ? AND category = ? AND superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(mem.contact_id, mem.category, now) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(`UPDATE memories SET superseded_by = ? WHERE id = ?`)
        .run(newId, existing.id);
    }

    this.db
      .prepare(
        `INSERT INTO memories
           (id, session_id, contact_id, category, content, confidence, source, created_at, expires_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, 'summarizer', ?, ?, NULL)`,
      )
      .run(
        newId,
        sessionId,
        mem.contact_id,
        mem.category,
        mem.content,
        mem.confidence,
        now,
        mem.expires_at ?? null,
      );
  }
}
