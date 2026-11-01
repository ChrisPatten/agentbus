/**
 * E90/E91 — SQLite storage for Intercom: pairing codes, the durable event log
 * (per-surface sequence, retention) and send idempotency.
 */
import { createHash, randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';

// ── Pairing codes ───────────────────────────────────────────────────────────

/** No 0/O/1/I/L: the code is read off a screen and typed or pasted. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export function normalizePairCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashPairCode(code: string): string {
  return createHash('sha256').update(normalizePairCode(code)).digest('hex');
}

/** A fresh code in `XXXXX-XXXXX` form (about 49 bits). */
export function generatePairCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function createPairCode(db: Database.Database, surfaceId: string, ttlMs: number, now = Date.now()): { code: string; expires_at: string } {
  const code = generatePairCode();
  const expiresAt = new Date(now + ttlMs).toISOString();
  db.prepare(`INSERT INTO intercom_pair_codes(surface_id, code_hash, created_at, expires_at) VALUES (?,?,?,?)`)
    .run(surfaceId, hashPairCode(code), new Date(now).toISOString(), expiresAt);
  return { code, expires_at: expiresAt };
}

export type RedeemResult =
  | { ok: true; surface_id: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

/** Redeem a code exactly once. The `used_at` flip is atomic, so two requests cannot both win. */
export function redeemPairCode(db: Database.Database, code: string, now = Date.now()): RedeemResult {
  const hash = hashPairCode(code);
  const row = db.prepare(`SELECT id, surface_id, expires_at, used_at FROM intercom_pair_codes WHERE code_hash = ?`)
    .get(hash) as { id: number; surface_id: string; expires_at: string; used_at: string | null } | undefined;
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  const flipped = db.prepare(`UPDATE intercom_pair_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`)
    .run(new Date(now).toISOString(), row.id);
  if (flipped.changes !== 1) return { ok: false, reason: 'used' };
  return { ok: true, surface_id: row.surface_id };
}

export function sweepPairCodes(db: Database.Database, now = Date.now()): number {
  // Keep spent and expired codes a day so a retried request still gets 410, not 404.
  const cutoff = new Date(now - 86_400_000).toISOString();
  return db.prepare(`DELETE FROM intercom_pair_codes WHERE expires_at < ? OR used_at < ?`).run(cutoff, cutoff).changes;
}

// ── Durable events ──────────────────────────────────────────────────────────

export interface StoredEvent { seq: number; event: string; data: Record<string, unknown>; created_at: string }

/** Append one durable event; returns its per-surface sequence number. */
export function appendEvent(db: Database.Database, surfaceId: string, event: string, data: Record<string, unknown>): number {
  return db.transaction(() => {
    db.prepare(`INSERT INTO intercom_surface_seq(surface_id, last_seq) VALUES (?, 1)
      ON CONFLICT(surface_id) DO UPDATE SET last_seq = last_seq + 1`).run(surfaceId);
    const { last_seq: seq } = db.prepare(`SELECT last_seq FROM intercom_surface_seq WHERE surface_id = ?`).get(surfaceId) as { last_seq: number };
    db.prepare(`INSERT INTO intercom_events(surface_id, seq, event, data, created_at) VALUES (?,?,?,?,?)`)
      .run(surfaceId, seq, event, JSON.stringify(data), new Date().toISOString());
    return seq;
  })();
}

export function eventBounds(db: Database.Database, surfaceId: string): { first: number; latest: number } {
  const latest = (db.prepare(`SELECT last_seq FROM intercom_surface_seq WHERE surface_id = ?`).get(surfaceId) as { last_seq: number } | undefined)?.last_seq ?? 0;
  const first = (db.prepare(`SELECT MIN(seq) AS first FROM intercom_events WHERE surface_id = ?`).get(surfaceId) as { first: number | null }).first;
  return { first: first ?? latest + 1, latest };
}

/** True when `cursor` is outside what is retained (or ahead of the log, e.g. after a database reset). */
export function cursorNeedsReset(db: Database.Database, surfaceId: string, cursor: number): boolean {
  const { first, latest } = eventBounds(db, surfaceId);
  return cursor > 0 && (cursor < first - 1 || cursor > latest);
}

export function readEvents(db: Database.Database, surfaceId: string, afterSeq: number, limit = 500): StoredEvent[] {
  const rows = db.prepare(`SELECT seq, event, data, created_at FROM intercom_events WHERE surface_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(surfaceId, afterSeq, limit) as { seq: number; event: string; data: string; created_at: string }[];
  return rows.map((r) => ({ seq: r.seq, event: r.event, data: JSON.parse(r.data) as Record<string, unknown>, created_at: r.created_at }));
}

export function sweepEvents(db: Database.Database, retentionDays: number, now = Date.now()): number {
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  return db.prepare(`DELETE FROM intercom_events WHERE created_at < ?`).run(cutoff).changes
    + db.prepare(`DELETE FROM intercom_sends WHERE created_at < ?`).run(cutoff).changes;
}

// ── Send idempotency ────────────────────────────────────────────────────────

export function getSend(db: Database.Database, surfaceId: string, clientMsgId: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT ack_json FROM intercom_sends WHERE surface_id = ? AND client_msg_id = ?`)
    .get(surfaceId, clientMsgId) as { ack_json: string } | undefined;
  return row ? (JSON.parse(row.ack_json) as Record<string, unknown>) : null;
}

export function putSend(db: Database.Database, surfaceId: string, clientMsgId: string, messageId: string, ack: Record<string, unknown>): void {
  db.prepare(`INSERT OR REPLACE INTO intercom_sends(surface_id, client_msg_id, message_id, ack_json, created_at) VALUES (?,?,?,?,?)`)
    .run(surfaceId, clientMsgId, messageId, JSON.stringify(ack), new Date().toISOString());
}
