import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleMemoryContext, formatLocalDate, type MemoryConfig } from './memory-context.js';

const CFG: MemoryConfig = {
  dir: 'memory',
  index_file: 'MEMORY.md',
  daily_subdir: 'daily',
  journal_lookback_days: 3,
};

describe('assembleMemoryContext (E20)', () => {
  let workingDir: string;
  // Fixed reference date so daily file names are deterministic.
  const now = new Date(2026, 5, 18, 9, 0, 0); // 2026-06-18 local

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'agentbus-mem-'));
    mkdirSync(join(workingDir, 'memory', 'daily'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writeMemory(rel: string, content: string) {
    const abs = join(workingDir, 'memory', rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('includes index + all present daily files in order (newest first)', () => {
    writeMemory('MEMORY.md', '# Index');
    writeMemory('daily/2026-06-18.md', 'today');
    writeMemory('daily/2026-06-17.md', 'yesterday');
    writeMemory('daily/2026-06-16.md', 'two days ago');

    const block = assembleMemoryContext(workingDir, CFG, now);

    expect(block).toContain('=== memory/MEMORY.md ===');
    expect(block).toContain('# Index');
    // Order: index, then today, yesterday, two-days-ago
    const idxIndex = block.indexOf('memory/MEMORY.md');
    const idxToday = block.indexOf('2026-06-18.md');
    const idxYesterday = block.indexOf('2026-06-17.md');
    const idxOldest = block.indexOf('2026-06-16.md');
    expect(idxIndex).toBeLessThan(idxToday);
    expect(idxToday).toBeLessThan(idxYesterday);
    expect(idxYesterday).toBeLessThan(idxOldest);
  });

  it('skips a missing day without erroring', () => {
    writeMemory('MEMORY.md', '# Index');
    writeMemory('daily/2026-06-18.md', 'today');
    // 2026-06-17 missing
    writeMemory('daily/2026-06-16.md', 'two days ago');

    const block = assembleMemoryContext(workingDir, CFG, now);
    expect(block).toContain('2026-06-18.md');
    expect(block).not.toContain('2026-06-17.md');
    expect(block).toContain('2026-06-16.md');
  });

  it('returns an empty block when the memory dir is missing', () => {
    const empty = join(tmpdir(), 'agentbus-mem-does-not-exist-xyz');
    const block = assembleMemoryContext(empty, CFG, now);
    expect(block).toBe('');
  });

  it('journal_lookback_days: 0 → index only', () => {
    writeMemory('MEMORY.md', '# Index');
    writeMemory('daily/2026-06-18.md', 'today');

    const block = assembleMemoryContext(workingDir, { ...CFG, journal_lookback_days: 0 }, now);
    expect(block).toContain('memory/MEMORY.md');
    expect(block).not.toContain('2026-06-18.md');
  });

  it('returns only daily files when the index is absent', () => {
    writeMemory('daily/2026-06-18.md', 'today');
    const block = assembleMemoryContext(workingDir, CFG, now);
    expect(block).not.toContain('MEMORY.md');
    expect(block).toContain('2026-06-18.md');
  });
});

describe('formatLocalDate (E20)', () => {
  it('formats local date components zero-padded', () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
