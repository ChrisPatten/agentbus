/**
 * E20 — headless memory file assembly.
 *
 * The agent's own files are the source of truth for memory. The bus front-loads
 * them into each turn's context: the MEMORY.md index plus the most recent daily
 * journal files. Pure (filesystem only) and side-effect-free so it can be unit
 * tested without loading config or spawning claude.
 *
 * `assembleMemoryBlocks` exposes the same files as individually keyed blocks
 * so the context-block ledger (src/adapters/context-ledger.ts) can send only
 * the ones that are new or changed for a given session, instead of the
 * `assembleMemoryContext` string below, which stays for callers (and the
 * no-session fallback in cc-headless.ts) that still want the whole thing
 * joined.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryConfig {
  /** Memory directory, relative to working_dir. */
  dir: string;
  /** Index file always loaded (relative to `dir`). */
  index_file: string;
  /** Subdirectory holding daily journal files `YYYY-MM-DD.md` (relative to `dir`). */
  daily_subdir: string;
  /** Days of daily journal to load: today + previous N-1. 0 → index only. */
  journal_lookback_days: number;
}

/** Format a Date as YYYY-MM-DD using local date components (matches journal file names). */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** One memory file, read and labeled, ready to be individually tracked by the context-block ledger (src/adapters/context-ledger.ts). */
export interface MemoryBlock {
  /** Ledger key: `memory:${cfg.dir}/${cfg.index_file}` for the index, `memory:${cfg.dir}/${cfg.daily_subdir}/${filename}` for a daily file. */
  key: string;
  /** The `=== <label> ===` header content — the same string `assembleMemoryContext` used to bake into its joined output. */
  label: string;
  content: string;
}

/**
 * Read the agent's memory files — the MEMORY.md index followed by the most
 * recent daily journal files, newest first — and return one `MemoryBlock`
 * per file found. Missing files (or a missing memory dir) are skipped
 * silently — an agent without a journal yet still works. Reads fresh on
 * every call so an in-session journaling update is reflected on the next
 * turn.
 */
export function assembleMemoryBlocks(workingDir: string, cfg: MemoryConfig, now: Date): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];

  const readBlock = (absPath: string, label: string, key: string): void => {
    try {
      const content = readFileSync(absPath, 'utf-8').trim();
      blocks.push({ key, label, content });
    } catch {
      // Missing file — skip silently.
    }
  };

  const indexLabel = `${cfg.dir}/${cfg.index_file}`;
  readBlock(join(workingDir, cfg.dir, cfg.index_file), indexLabel, `memory:${indexLabel}`);

  for (let i = 0; i < cfg.journal_lookback_days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const name = `${formatLocalDate(d)}.md`;
    const label = `${cfg.dir}/${cfg.daily_subdir}/${name}`;
    readBlock(join(workingDir, cfg.dir, cfg.daily_subdir, name), label, `memory:${label}`);
  }

  return blocks;
}

/**
 * Assemble the agent's memory files into a single joined context block, in
 * the `=== <label> ===\n<content>` format the system prompt's {{memories}}
 * placeholder historically carried. Built from `assembleMemoryBlocks` so the
 * file-reading logic lives in one place; byte-identical to the pre-ledger
 * behavior.
 */
export function assembleMemoryContext(workingDir: string, cfg: MemoryConfig, now: Date): string {
  return assembleMemoryBlocks(workingDir, cfg, now)
    .map((b) => `=== ${b.label} ===\n${b.content}`)
    .join('\n\n');
}
