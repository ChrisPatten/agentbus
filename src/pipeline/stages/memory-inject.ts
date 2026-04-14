/**
 * Stage 85 — Memory Inject (critical: false)
 *
 * E9: Automatic context injection on the first message of a new session.
 *
 * When Stage 80 creates a brand-new session (ctx.sessionCreated === true) and
 * the sender is a known contact, this stage:
 *   1. Fetches all active memories for that contact (ordered by confidence).
 *   2. Fetches recent session summaries within config.memory.context_window_hours.
 *   3. Formats them into a structured <memory> block.
 *   4. Attaches the result to envelope.metadata.memory_context.
 *
 * If both queries return nothing, the metadata key is not set and the message
 * flows through unchanged. Adapters check for metadata.memory_context and
 * prepend it to their notification text.
 *
 * Registered as critical: false — injection failure never blocks delivery.
 */
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage } from '../types.js';

/** Hard cap on the formatted context string to keep payloads reasonable. */
const MAX_INJECT_CHARS = 4000;

interface MemoryQueryRow {
  category: string;
  content: string;
  confidence: number;
}

interface SummaryQueryRow {
  summary: string;
  started_at: string;
  ended_at: string;
  channel: string;
}

/** Escape XML special characters to prevent injection into the <memory> block. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format a date string (ISO 8601) as "Apr 12, 14:30" (UTC). */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
}

/**
 * Extract the plain-text summary from a JSON SummaryResult blob.
 * Falls back to the raw string if the JSON parse fails.
 */
function extractSummaryText(summaryJson: string): string {
  try {
    const parsed = JSON.parse(summaryJson) as { summary?: string };
    return parsed.summary ?? summaryJson;
  } catch {
    console.warn(`[memory-inject] Failed to parse summary JSON: ${summaryJson.slice(0, 100)}`);
    return summaryJson;
  }
}

/**
 * Build the <memory> XML block from memories and summaries.
 * All user-controlled strings are XML-escaped before inclusion.
 */
function buildContextBlock(
  contactId: string,
  memories: MemoryQueryRow[],
  summaries: SummaryQueryRow[],
): string {
  const lines: string[] = [`<memory contact="${escapeXml(contactId)}">`];

  if (memories.length > 0) {
    lines.push('## Known facts');
    for (const m of memories) {
      lines.push(
        `- [${escapeXml(m.category)}] ${escapeXml(m.content)} (confidence: ${m.confidence.toFixed(2)})`,
      );
    }
  }

  if (summaries.length > 0) {
    if (memories.length > 0) lines.push('');
    lines.push('## Recent conversations');
    for (const s of summaries) {
      const text = extractSummaryText(s.summary);
      lines.push(
        `- ${escapeXml(s.channel)} (${fmtDate(s.started_at)} - ${fmtDate(s.ended_at)}): ${escapeXml(text)}`,
      );
    }
  }

  lines.push('</memory>');
  return lines.join('\n');
}

export function createMemoryInject(db: Database.Database, config: AppConfig): PipelineStage {
  return async (ctx) => {
    // Only fire on new sessions with a known contact (non-empty ID)
    if (!ctx.sessionCreated || !ctx.contact || !ctx.contact.id) {
      return ctx;
    }

    const contactId = ctx.contact.id;
    const now = new Date().toISOString();

    // 1. Fetch active memories (all time — memories manage their own lifecycle)
    const memories = db
      .prepare(
        `SELECT category, content, confidence FROM memories
         WHERE contact_id = ? AND superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY confidence DESC, created_at DESC
         LIMIT 20`,
      )
      .all(contactId, now) as MemoryQueryRow[];

    // 2. Fetch recent session summaries within context_window_hours
    const windowMs = config.memory.context_window_hours * 3_600_000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const summaries = db
      .prepare(
        `SELECT summary, started_at, ended_at, channel FROM session_summaries
         WHERE contact_id = ? AND created_at > ?
         ORDER BY ended_at DESC
         LIMIT 5`,
      )
      .all(contactId, cutoff) as SummaryQueryRow[];

    // Nothing to inject
    if (memories.length === 0 && summaries.length === 0) {
      return ctx;
    }

    // 3. Format context block (all user content XML-escaped)
    let context = buildContextBlock(contactId, memories, summaries);

    // 4. Apply character cap — trim summaries first, then memories
    if (context.length > MAX_INJECT_CHARS) {
      let trimmed = false;

      // Remove summaries one by one until it fits
      for (let summaryCount = summaries.length - 1; summaryCount >= 0; summaryCount--) {
        context = buildContextBlock(contactId, memories, summaries.slice(0, summaryCount));
        if (context.length <= MAX_INJECT_CHARS) {
          trimmed = true;
          break;
        }
      }

      // If still too long after removing all summaries, trim memories by count
      if (context.length > MAX_INJECT_CHARS) {
        for (let memCount = memories.length - 1; memCount >= 0; memCount--) {
          context = buildContextBlock(contactId, memories.slice(0, memCount), []);
          if (context.length <= MAX_INJECT_CHARS) {
            trimmed = true;
            break;
          }
        }
      }

      if (trimmed) {
        console.warn(
          `[memory-inject] context trimmed to ${context.length} chars (limit: ${MAX_INJECT_CHARS}) for contact ${contactId}`,
        );
      }
    }

    ctx.envelope.metadata.memory_context = context;
    return ctx;
  };
}
