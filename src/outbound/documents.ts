/**
 * S81.7 — path allow-list and size gate for `send_document` (E81).
 *
 * The agent names a file by path; the bus uploads it to Telegram, so the path
 * is the whole trust boundary. A path is accepted only if its REAL location
 * (symlinks resolved first, `..` collapsed) lies inside one of the allowed
 * directories, which are themselves resolved to real paths. Everything else
 * is rejected before any byte is read or uploaded.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getCcPoolInstances, type AppConfig } from '../config/schema.js';

/** Telegram's upload limit for a bot document. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
/** Telegram's upload limit for a photo. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export type DocumentPathCheck =
  | { ok: true; realPath: string; size: number }
  | { ok: false; error: string };

/**
 * The allow-listed send directories for a Telegram instance: its configured
 * `send_paths`, or when none are configured the default: each agent's `data/`
 * directory and its Claude Code scratchpad root (`/tmp/claude-<uid>/<slug>`).
 */
export function resolveSendDirs(config: AppConfig, configured?: string[]): string[] {
  if (configured && configured.length > 0) return configured.map(expandHome);
  const dirs: string[] = [];
  const workingDirs = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    const wd = (agent as { working_dir?: string }).working_dir;
    if (wd) workingDirs.add(wd);
  }
  try {
    for (const pool of getCcPoolInstances(config)) if (pool.working_dir) workingDirs.add(pool.working_dir);
  } catch {
    // an invalid cc-pool block is reported elsewhere; the default list just omits it
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  for (const wd of workingDirs) {
    const abs = resolve(expandHome(wd));
    dirs.push(join(abs, 'data'));
    dirs.push(join('/tmp', `claude-${uid}`, abs.replace(/[/.]/g, '-')));
  }
  return dirs;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(process.env['HOME'] ?? '', p.slice(2)) : p;
}

/** True if `child` is `parent` or inside it (both already real paths). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Validates `path` against `allowedDirs` and `maxBytes`. Resolves symlinks
 * with realpath BEFORE the containment check, so a link inside an allowed
 * directory that points outside it is rejected.
 */
export function checkDocumentPath(
  path: string,
  allowedDirs: string[],
  maxBytes: number = MAX_DOCUMENT_BYTES,
): DocumentPathCheck {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    return { ok: false, error: 'path must be a non-empty string without NUL bytes' };
  }
  if (!isAbsolute(path)) return { ok: false, error: 'path must be absolute' };

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, error: `file not found: ${path}` };
  }

  const realDirs: string[] = [];
  for (const dir of allowedDirs) {
    try {
      realDirs.push(realpathSync(dir));
    } catch {
      // an allowed directory that does not exist allows nothing
    }
  }
  if (!realDirs.some((dir) => isInside(dir, real))) {
    return { ok: false, error: `path is outside the allowed send directories: ${path}` };
  }

  const st = statSync(real);
  if (!st.isFile()) return { ok: false, error: `not a regular file: ${path}` };
  if (st.size === 0) return { ok: false, error: `file is empty: ${path}` };
  if (st.size > maxBytes) {
    return { ok: false, error: `file is ${st.size} bytes, over the ${maxBytes} byte (${Math.round(maxBytes / 1024 / 1024)} MB) upload limit` };
  }
  return { ok: true, realPath: real, size: st.size };
}
