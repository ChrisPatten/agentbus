/**
 * E20 — headless memory file assembly.
 *
 * The agent's own files are the source of truth for memory. The bus front-loads
 * them into each turn's context: the MEMORY.md index plus the most recent daily
 * journal files. Pure (filesystem only) and side-effect-free so it can be unit
 * tested without loading config or spawning claude.
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

/**
 * Assemble the agent's memory files into a context block: the MEMORY.md index
 * followed by the most recent daily journal files, newest first. Missing files
 * (or a missing memory dir) are skipped silently — an agent without a journal
 * yet still works. Assembled fresh on every turn so an in-session journaling
 * update is reflected on the next turn.
 */
export function assembleMemoryContext(workingDir: string, cfg: MemoryConfig, now: Date): string {
  const blocks: string[] = [];

  const readBlock = (absPath: string, label: string): void => {
    try {
      const content = readFileSync(absPath, 'utf-8');
      blocks.push(`=== ${label} ===\n${content.trim()}`);
    } catch {
      // Missing file — skip silently.
    }
  };

  readBlock(join(workingDir, cfg.dir, cfg.index_file), `${cfg.dir}/${cfg.index_file}`);

  for (let i = 0; i < cfg.journal_lookback_days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const name = `${formatLocalDate(d)}.md`;
    readBlock(
      join(workingDir, cfg.dir, cfg.daily_subdir, name),
      `${cfg.dir}/${cfg.daily_subdir}/${name}`,
    );
  }

  return blocks.join('\n\n');
}
