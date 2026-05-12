/**
 * Stage 85 — Memory Inject (critical: false)
 *
 * E9: Automatic context injection on the first message of a new session.
 *
 * When Stage 80 creates a brand-new session (ctx.sessionCreated === true) and
 * the sender is a known contact, this stage fetches recent session summaries
 * for the contact on the same channel and formats them into a <memory> block
 * attached to envelope.metadata.memory_context.
 *
 * If the query returns nothing, the metadata key is not set and the message
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
  summaries: SummaryQueryRow[],
): string {
  const lines: string[] = [`<memory contact="${escapeXml(contactId)}">`];

  if (summaries.length > 0) {
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
  const excluded = new Set(config.memory.memory_inject_exclude);

  return async (ctx) => {
    // Only fire on new sessions with a known contact (non-empty ID)
    if (!ctx.sessionCreated || !ctx.contact || !ctx.contact.id) {
      return ctx;
    }

    if (excluded.has(ctx.envelope.channel)) {
      return ctx;
    }

    const contactId = ctx.contact.id;
    const now = new Date().toISOString();

    const channel = ctx.envelope.channel;

    // Fetch recent session summaries within context_window_hours, same channel.
    const windowMs = config.memory.context_window_hours * 3_600_000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const summaries = db
      .prepare(
        `SELECT summary, started_at, ended_at, channel FROM session_summaries
         WHERE contact_id = ? AND created_at > ? AND channel = ?
         ORDER BY ended_at DESC
         LIMIT 5`,
      )
      .all(contactId, cutoff, channel) as SummaryQueryRow[];

    if (summaries.length === 0) {
      return ctx;
    }

    // Format context block (all user content XML-escaped)
    let context = buildContextBlock(contactId, summaries);

    // Apply character cap — trim summaries one by one until it fits
    if (context.length > MAX_INJECT_CHARS) {
      let trimmed = false;
      for (let count = summaries.length - 1; count >= 0; count--) {
        context = buildContextBlock(contactId, summaries.slice(0, count));
        if (context.length <= MAX_INJECT_CHARS) {
          trimmed = true;
          break;
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
