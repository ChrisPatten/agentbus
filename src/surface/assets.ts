/**
 * E96 follow-on — the asset store behind `GET /api/v1/surface/assets/:hash` and the publishing upload.
 *
 * Content-addressed: a file is stored as `<dir>/<sha256 of its bytes>.<ext>` (`png`, `jpg`, `svg`), so the
 * same bytes always have the same name and URL, and a device may cache them forever. `<dir>` is
 * `<directory of bus.db_path>/surface-assets`.
 *
 * The bytes are checked against the declared content type before anything is written (PNG and JPEG by
 * their signatures; SVG must be an `<svg` document without script or event handlers), so a file named
 * `.png` that is not a PNG never lands in the store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoundsError } from './types.js';

export const ASSET_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
} as const;
export type AssetContentType = keyof typeof ASSET_TYPES;

export const ASSET_HASH_RE = /^[0-9a-f]{64}$/;

export interface StoredAsset {
  hash: string;
  content_type: AssetContentType;
  size: number;
  /** Path relative to the surface API root, e.g. for `detail.image`: the hash itself is the reference. */
  url: string;
  /** False when the same bytes were already stored. */
  created: boolean;
}

/** The content type for a header value such as `image/png; charset=binary`, or null when not accepted. */
export function assetContentType(header: string | undefined): AssetContentType | null {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return base in ASSET_TYPES ? (base as AssetContentType) : null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Throws a {@link BoundsError} when `bytes` is not a plausible file of `type`. */
export function validateAssetBytes(type: AssetContentType, bytes: Buffer): void {
  if (bytes.length === 0) throw new BoundsError('the asset is empty');
  if (type === 'image/png') {
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIG)) throw new BoundsError('the file is not a PNG (bad signature)');
    return;
  }
  if (type === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new BoundsError('the file is not a JPEG (bad signature)');
    return;
  }
  const src = bytes.toString('utf8');
  if (src.includes('\u0000')) throw new BoundsError('the file is not SVG text');
  const head = src.replace(/^﻿/, '').trimStart();
  if (!/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    throw new BoundsError('the file is not an SVG document (it must start with <svg)');
  }
  if (/<\s*script|<\s*foreignObject|<\s*iframe|<\s*embed|<\s*object|\son[a-z]+\s*=|javascript:|<!ENTITY/i.test(src)) {
    throw new BoundsError('the SVG contains script, an event handler, embedded content or an entity; only static SVG is accepted');
  }
}

/** Stores `bytes` (already size-checked by the caller) under its sha256. Idempotent. */
export function storeAsset(dir: string, type: AssetContentType, bytes: Buffer): StoredAsset {
  validateAssetBytes(type, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.${ASSET_TYPES[type]}`);
  const created = !existsSync(file);
  if (created) {
    // Write beside the final name and rename, so a reader never sees a half-written file.
    const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, bytes, { mode: 0o644 });
    renameSync(tmp, file);
  }
  return { hash, content_type: type, size: bytes.length, url: `/api/v1/surface/assets/${hash}`, created };
}

/** True when an asset with this hash is in the store. */
export function assetExists(dir: string, hash: string): boolean {
  if (!ASSET_HASH_RE.test(hash) || !existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().startsWith(`${hash}.`) || f.toLowerCase() === hash) && statSync(dir).isDirectory();
  } catch { return false; }
}
