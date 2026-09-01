/**
 * Generic helper for logging raw incoming webhook requests to disk — a
 * debugging/audit aid, entirely separate from the request/response cycle
 * itself. A failure here must never affect the actual webhook response, so
 * every write is best-effort (caught and logged to console, never thrown).
 *
 * One JSONL file per webhook per day: `<dir>/<webhook>/<YYYY-MM-DD>.jsonl`.
 * Reusable by any webhook route, not pebble-specific — see the pebble
 * webhook in src/http/api.ts for the calling convention.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WebhookLoggingConfig } from '../config/schema.js';

export interface WebhookLogEntry {
  /** Webhook name, e.g. "pebble" — becomes the log subdirectory. */
  webhook: string;
  /** Whether the request was accepted (true) or rejected (false). */
  ok: boolean;
  /** HTTP status code returned to the caller. */
  status: number;
  /** Short machine-readable reason, e.g. "unauthorized", "ok". */
  reason: string;
  /** Best-effort raw payload captured at the point of rejection/acceptance. */
  raw?: unknown;
}

/**
 * Append a line for one webhook request. No-op when `config` is undefined
 * or `config.enabled` is false, so call sites can pass an adapter's
 * `logging` config unconditionally.
 */
export function logWebhookRequest(config: WebhookLoggingConfig | undefined, entry: WebhookLogEntry): void {
  if (!config?.enabled) return;
  try {
    const dir = join(config.dir, entry.webhook);
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(dir, `${date}.jsonl`);
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
    appendFileSync(filePath, line);
  } catch (err) {
    console.error(`[webhook-log] Failed to write log for webhook "${entry.webhook}": ${String(err)}`);
  }
}
