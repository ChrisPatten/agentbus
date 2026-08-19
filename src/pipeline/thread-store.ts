/**
 * Generic per-thread reply state (E27), shared by every channel's threading.
 *
 * A row is keyed by `(channel, topic)` — the same pair the pipeline carries
 * through to conversation_id, so an adapter's send() path can look a thread up
 * by the envelope alone. `threadKey` is the channel-specific raw id that got
 * hashed into the `thread:<hash>` topic (see topicForThreadKey in ./types.js);
 * `metadata` is an opaque JSON blob whose shape is defined per-adapter at the
 * call site (e.g. email's EmailThreadMetadata) — the store itself never
 * inspects it.
 */
import type Database from 'better-sqlite3';

export interface ThreadRecord<M> {
  threadKey: string;
  metadata: M;
  updatedAt: string;
}

interface ThreadRow {
  thread_key: string;
  metadata: string;
  updated_at: string;
}

/** Look up a thread's state by (channel, topic). Null if none exists. */
export function getThread<M>(
  db: Database.Database,
  channel: string,
  topic: string,
): ThreadRecord<M> | null {
  const row = db
    .prepare(`SELECT thread_key, metadata, updated_at FROM threads WHERE channel = ? AND topic = ?`)
    .get(channel, topic) as ThreadRow | undefined;
  if (!row) return null;
  return {
    threadKey: row.thread_key,
    metadata: JSON.parse(row.metadata) as M,
    updatedAt: row.updated_at,
  };
}

/** Create or fully replace a thread's state for (channel, topic). */
export function upsertThread<M>(
  db: Database.Database,
  args: { channel: string; topic: string; threadKey: string; metadata: M },
): void {
  db.prepare(
    `INSERT INTO threads (channel, topic, thread_key, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel, topic) DO UPDATE SET
       thread_key = excluded.thread_key,
       metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  ).run(args.channel, args.topic, args.threadKey, JSON.stringify(args.metadata), new Date().toISOString());
}

/**
 * Shallow-merge `patch` into an existing thread's metadata. A no-op — does not
 * create a row — if no thread exists yet for (channel, topic).
 */
export function patchThreadMetadata<M>(
  db: Database.Database,
  channel: string,
  topic: string,
  patch: Partial<M>,
): void {
  const existing = getThread<M>(db, channel, topic);
  if (!existing) return;
  upsertThread(db, {
    channel,
    topic,
    threadKey: existing.threadKey,
    metadata: { ...existing.metadata, ...patch },
  });
}
