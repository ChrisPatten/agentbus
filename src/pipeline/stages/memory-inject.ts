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

/** Format a date string (ISO 8601) as "Apr 12, 14:30" */
function fmtDate(iso: string): string {
  // Slice "2026-04-12T14:30:00.000Z" → "Apr 12, 14:30"
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
    return summaryJson;
  }
}

export function createMemoryInject(db: Database.Database, config: AppConfig): PipelineStage {
  return async (ctx) => {
    // Only fire on new sessions with a known contact
    if (!ctx.sessionCreated || !ctx.contact) {
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

    // 3. Format context block
    const lines: string[] = [`<memory contact="${contactId}">`];

    if (memories.length > 0) {
      lines.push('## Known facts');
      for (const m of memories) {
        lines.push(`- [${m.category}] ${m.content} (confidence: ${m.confidence.toFixed(2)})`);
      }
    }

    if (summaries.length > 0) {
      if (memories.length > 0) lines.push('');
      lines.push('## Recent conversations');
      for (const s of summaries) {
        const text = extractSummaryText(s.summary);
        lines.push(`- ${s.channel} (${fmtDate(s.started_at)} - ${fmtDate(s.ended_at)}): ${text}`);
      }
    }

    lines.push('</memory>');

    let context = lines.join('\n');

    // 4. Apply character cap — trim summaries first, then memories
    if (context.length > MAX_INJECT_CHARS) {
      // Rebuild with progressively fewer summaries
      for (let summaryCount = summaries.length - 1; summaryCount >= 0; summaryCount--) {
        const trimmedSummaries = summaries.slice(0, summaryCount);
        const trimLines: string[] = [`<memory contact="${contactId}">`];

        if (memories.length > 0) {
          trimLines.push('## Known facts');
          for (const m of memories) {
            trimLines.push(`- [${m.category}] ${m.content} (confidence: ${m.confidence.toFixed(2)})`);
          }
        }

        if (trimmedSummaries.length > 0) {
          if (memories.length > 0) trimLines.push('');
          trimLines.push('## Recent conversations');
          for (const s of trimmedSummaries) {
            const text = extractSummaryText(s.summary);
            trimLines.push(`- ${s.channel} (${fmtDate(s.started_at)} - ${fmtDate(s.ended_at)}): ${text}`);
          }
        }

        trimLines.push('</memory>');
        context = trimLines.join('\n');

        if (context.length <= MAX_INJECT_CHARS) break;
      }

      // If still too long after removing all summaries, trim memories by count
      if (context.length > MAX_INJECT_CHARS) {
        for (let memCount = memories.length - 1; memCount >= 0; memCount--) {
          const trimLines: string[] = [`<memory contact="${contactId}">`];
          trimLines.push('## Known facts');
          for (const m of memories.slice(0, memCount)) {
            trimLines.push(`- [${m.category}] ${m.content} (confidence: ${m.confidence.toFixed(2)})`);
          }
          trimLines.push('</memory>');
          context = trimLines.join('\n');

          if (context.length <= MAX_INJECT_CHARS) break;
        }
      }
    }

    ctx.envelope.metadata.memory_context = context;
    return ctx;
  };
}
