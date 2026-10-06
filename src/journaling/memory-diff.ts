/**
 * Memory-dir diff (E66 S66.8): an independent check of what a journal run
 * changed, by comparing file sizes and mtimes before and after. Used by the
 * System Message journaler, where the agent reports its own changes.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Path (relative to the memory dir) → "size:mtimeMs". */
export type MemorySnapshot = Map<string, string>;

const MAX_FILES = 5_000;

export function snapshotMemoryDir(dir: string | null): MemorySnapshot | null {
  if (!dir) return null;
  const out: MemorySnapshot = new Map();
  const walk = (current: string) => {
    if (out.size >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= MAX_FILES) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const st = statSync(full);
          out.set(relative(dir, full), `${st.size}:${st.mtimeMs}`);
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  walk(dir);
  return out;
}

/** Files added, changed or removed between two snapshots, sorted. */
export function diffMemory(before: MemorySnapshot | null, after: MemorySnapshot | null): string[] {
  if (!before || !after) return [];
  const changed = new Set<string>();
  for (const [path, sig] of after) if (before.get(path) !== sig) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}
