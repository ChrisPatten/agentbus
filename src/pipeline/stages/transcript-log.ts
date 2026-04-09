import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../../config/schema.js';
import type { PipelineStage } from '../types.js';

/**
 * Stage 80 — Transcript Log (critical: false)
 *
 * Last stage in the pipeline. Writes session state and message transcripts
 * to SQLite. All DB calls use better-sqlite3 (synchronous), so there is no
 * async interleaving risk within this stage.
 *
 * Prerequisite: ctx.conversationId must be set by Stage 70 (route-resolve).
 * If it is null (e.g. route-resolve was skipped or ran out of order) the
 * stage emits a warning and returns ctx unchanged rather than crashing — the
 * pipeline continues and the caller loses only the transcript row.
 *
 * Session lifecycle (per conversation_id):
 *   - No active session → INSERT a new session row.
 *   - Active session, gap ≤ session_idle_threshold_ms → extend (UPDATE
 *     last_activity + increment message_count).
 *   - Active session, gap > threshold → end old (set ended_at), INSERT new.
 *
 * After session resolution:
 *   - Upserts conversation_registry (sets last_seen on every message).
 *   - Inserts a transcripts row with the envelope body and full metadata
 *     blob (includes dedup_key, priority_score, raw_received_at, etc.).
 *
 * Registered as critical: false — a DB error here logs to stderr but does
 * not abort delivery. The dedup stage already recorded the key in its
 * in-memory Map so the message will not be re-processed even if the
 * transcript row is missing.
 */
export function createTranscriptLog(db: Database.Database, config: AppConfig): PipelineStage {
  return async (ctx) => {
    const e = ctx.envelope;
    const now = new Date().toISOString();
    const idleThresholdMs = config.memory.session_idle_threshold_ms;

    const contactId = e.sender.startsWith('contact:')
      ? e.sender.slice('contact:'.length)
      : e.sender;

    if (!ctx.conversationId) {
      console.warn('[pipeline:transcript-log] ctx.conversationId is null — skipping transcript');
      return ctx;
    }
    const conversationId = ctx.conversationId;

    // Find active session for this conversation
    const activeSession = db
      .prepare(
        `SELECT id, last_activity FROM sessions
         WHERE conversation_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(conversationId) as { id: string; last_activity: string } | undefined;

    let sessionId: string;

    if (!activeSession) {
      // No active session — create one
      sessionId = randomUUID();
      db.prepare(
        `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, conversationId, e.channel, contactId, now, now);
    } else {
      const lastActivity = new Date(activeSession.last_activity).getTime();
      const gapMs = Date.now() - lastActivity;

      if (gapMs > idleThresholdMs) {
        // Gap exceeded threshold — end old session, start new
        db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now, activeSession.id);
        sessionId = randomUUID();
        db.prepare(
          `INSERT INTO sessions (id, conversation_id, channel, contact_id, started_at, last_activity)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(sessionId, conversationId, e.channel, contactId, now, now);
      } else {
        // Extend existing session
        sessionId = activeSession.id;
        db.prepare(
          `UPDATE sessions SET last_activity = ?, message_count = message_count + 1 WHERE id = ?`,
        ).run(now, sessionId);
      }
    }

    ctx.sessionId = sessionId;

    // Upsert conversation_registry
    db.prepare(
      `INSERT INTO conversation_registry (id, contact_id, channel, topic, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
    ).run(conversationId, contactId, e.channel, e.topic, now, now);

    // Insert transcript row
    db.prepare(
      `INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))`,
    ).run(
      randomUUID(),
      e.id,
      conversationId,
      sessionId,
      now,
      e.channel,
      contactId,
      'inbound',
      e.payload.body,
      JSON.stringify(e.metadata),
    );

    return ctx;
  };
}
