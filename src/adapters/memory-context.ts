/**
 * Bus-side memory injection (E20; E67 S67.3).
 *
 * Since E67, Claude Code runtimes with the `nativeMemory` capability load
 * memory themselves: auto memory pointed at the agent's memory dir loads the
 * index, `CLAUDE.md` imports `recent.md`. This module is the fallback for
 * agents that keep bus injection (`agents.<id>.memory.native: false`): the
 * index file plus the bus-generated `recent.md` (src/memory/recent.ts),
 * which already carries the recent dailies within budget. It no longer
 * reads the dailies itself.
 *
 * `assembleMemoryBlocks` exposes the files as individually keyed blocks so
 * the context-block ledger (src/adapters/context-ledger.ts) can send only the
 * ones that are new or changed for a session; `assembleMemoryContext` joins
 * them for the no-session fallback. Pure (filesystem only).
 */
import { readFileSync } from 'node:fs';
import type { MemoryLayout } from '../memory/layout.js';
import { RECENT_FILE } from '../memory/layout.js';

/** Format a Date as YYYY-MM-DD using local date components (matches journal file names). */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** One memory file, read and labeled, ready to be individually tracked by the context-block ledger. */
export interface MemoryBlock {
  /** Ledger key: `memory:<dir>/<index_file>` or `memory:<dir>/recent.md`. */
  key: string;
  /** The `=== <label> ===` header content. */
  label: string;
  content: string;
}

export type InjectLayout = Pick<MemoryLayout, 'dir' | 'indexFile' | 'indexPath' | 'recentPath'>;

/**
 * Read the index and `recent.md`, one block per file found. Missing files
 * (or no memory dir) are skipped silently. Reads fresh on every call.
 */
export function assembleMemoryBlocks(layout: InjectLayout): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  const dir = layout.dir.replace(/\/+$/, '');
  const readBlock = (absPath: string | null, label: string): void => {
    if (!absPath) return;
    try {
      const content = readFileSync(absPath, 'utf-8').trim();
      blocks.push({ key: `memory:${label}`, label, content });
    } catch {
      // Missing file — skip silently.
    }
  };
  readBlock(layout.indexPath, `${dir}/${layout.indexFile}`);
  readBlock(layout.recentPath, `${dir}/${RECENT_FILE}`);
  return blocks;
}

/** The blocks joined as `=== <label> ===\n<content>`, the format `{{memories}}` carries. */
export function assembleMemoryContext(layout: InjectLayout): string {
  return assembleMemoryBlocks(layout)
    .map((b) => `=== ${b.label} ===\n${b.content}`)
    .join('\n\n');
}
