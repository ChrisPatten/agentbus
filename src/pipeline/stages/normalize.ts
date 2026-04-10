import { randomUUID } from 'node:crypto';
import type { PipelineStage } from '../types.js';

/**
 * Stage 10 — Normalize
 *
 * First stage in the pipeline. Validates that required fields are present,
 * then fills in defaults for optional fields so all later stages can assume
 * a fully-populated envelope without null checks.
 *
 * Validation:
 *   - channel and sender must be non-empty strings (adapters are responsible
 *     for setting them; absence is a programming error upstream).
 *   - payload.body is checked with an explicit null/type/length guard rather
 *     than `!payload?.body` so that a body of `"0"` or `false` — valid in
 *     other contexts — would not be mistakenly rejected. An empty string is
 *     treated as missing because there is nothing to process.
 *
 * Throws on any validation failure so the PipelineEngine catches the error
 * and aborts the pipeline (critical: true default).
 *
 * Defaults applied:
 *   id           → randomUUID()
 *   timestamp    → current ISO-8601 time
 *   topic        → 'general'
 *   priority     → 'normal'
 *   reply_to     → null
 *   metadata     → {}
 *   recipient    → 'agent:claude'
 *
 * Also stamps metadata.raw_received_at (unix ms) for latency tracking.
 */
export const normalize: PipelineStage = async (ctx) => {
  const e = ctx.envelope;

  if (!e.channel) throw new Error('Missing required field: channel');
  if (!e.sender) throw new Error('Missing required field: sender');
  // Explicit null/type/length check: !payload?.body would silently pass a
  // non-string or treat '0' as missing; this form is unambiguous.
  if (e.payload == null || typeof e.payload.body !== 'string' || e.payload.body.length === 0) {
    throw new Error('Missing required field: payload.body');
  }

  e.id = e.id || randomUUID();
  e.timestamp = e.timestamp || new Date().toISOString();
  e.topic = e.topic || 'general';
  e.priority = e.priority || 'normal';
  e.reply_to = e.reply_to ?? null;
  e.metadata = e.metadata ?? {};
  e.recipient = e.recipient || 'agent:claude';
  e.metadata['raw_received_at'] = Date.now();

  return ctx;
};
