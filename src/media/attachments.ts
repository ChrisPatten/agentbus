/**
 * Shared attachment helpers used by platform adapters (Telegram, Email).
 *
 * These are adapter-agnostic: MIME→extension mapping, per-agent media-config
 * resolution from pipeline routes, and persisting attachment bytes to disk +
 * the `attachments` table. Adapters that download over the network (Telegram)
 * keep their own streaming download but share `extensionFor`/`resolveMediaConfig`;
 * adapters that already hold the bytes (Email) use `persistAttachmentBuffer`.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';

/** MIME → file-extension map for the image types adapters commonly deliver. */
const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/** Derive a safe extension from MIME type or original filename; falls back to `.bin`. */
export function extensionFor(mime?: string, filename?: string): string {
  if (mime && MIME_EXTENSION[mime.toLowerCase()]) return MIME_EXTENSION[mime.toLowerCase()]!;
  if (filename) {
    const ext = extname(filename).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return '.bin';
}

/** Resolved media config for an agent that is the target of an inbound channel. */
export interface ResolvedMediaConfig {
  agentId: string;
  download_path: string;
  ttl_seconds: number;
}

/** Resolve the media config for the target agent of an inbound channel. */
export function resolveMediaConfig(config: AppConfig, channel: string): ResolvedMediaConfig | null {
  for (const rule of config.pipeline.routes) {
    const channelMatch = rule.match.channel === undefined || rule.match.channel === channel;
    if (!channelMatch) continue;
    const recipientId = rule.target.recipientId;
    const agentCfg = config.agents[recipientId];
    if (agentCfg?.media) {
      return {
        agentId: recipientId,
        download_path: agentCfg.media.download_path,
        ttl_seconds: agentCfg.media.ttl_seconds,
      };
    }
    // First route matched but agent has no media config — treat as "not configured".
    return null;
  }
  return null;
}

/**
 * Write attachment bytes to `<download_path>/<uuid><ext>` and insert the
 * `attachments` row. Returns the generated id and the absolute local path.
 *
 * Throws on write failure (after attempting to clean up a partial file); the
 * caller decides whether to proceed without the attachment. Unlike Telegram's
 * `downloadFile`, there is no network fetch — the bytes are already in memory
 * (e.g. mailparser's `attachment.content`).
 */
export function persistAttachmentBuffer(
  db: Database.Database,
  media: ResolvedMediaConfig,
  content: Buffer,
  opts: { mime_type?: string; original_filename?: string } = {},
): { id: string; local_path: string } {
  const ext = extensionFor(opts.mime_type, opts.original_filename);
  const localPath = join(media.download_path, `${randomUUID()}${ext}`);
  try {
    writeFileSync(localPath, content);
  } catch (err) {
    try { unlinkSync(localPath); } catch {}
    throw err;
  }

  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    media.agentId,
    localPath,
    opts.original_filename ?? null,
    opts.mime_type ?? null,
    now,
    now + media.ttl_seconds * 1000,
  );

  return { id, local_path: localPath };
}
