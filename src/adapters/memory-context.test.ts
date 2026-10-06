import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleMemoryBlocks, assembleMemoryContext, formatLocalDate } from './memory-context.js';
import { memoryLayout, type MemorySettings } from '../memory/layout.js';

const SETTINGS: MemorySettings = {
  agentId: 'agent:x', source: 'default', dir: 'memory', indexFile: 'MEMORY.md', dailySubdir: 'daily',
  lookbackDays: 3, recentBudgetChars: 20_000, native: false,
};

describe('assembleMemoryContext (E20, E67 S67.3)', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'agentbus-mem-'));
    mkdirSync(join(workingDir, 'memory', 'daily'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writeMemory(rel: string, content: string) {
    writeFileSync(join(workingDir, 'memory', rel), content, 'utf-8');
  }

  it('injects the index, then recent.md, and never reads the dailies directly', () => {
    writeMemory('MEMORY.md', '# Index');
    writeMemory('recent.md', '# Recent journal\n## 2026-06-18 (today)\ntoday');
    writeMemory('daily/2026-06-18.md', 'raw daily');
    const layout = memoryLayout(SETTINGS, workingDir);
    const block = assembleMemoryContext(layout);
    expect(block.indexOf('=== memory/MEMORY.md ===')).toBeLessThan(block.indexOf('=== memory/recent.md ==='));
    expect(block).not.toContain('raw daily');
    expect(assembleMemoryBlocks(layout).map((b) => b.key)).toEqual(['memory:memory/MEMORY.md', 'memory:memory/recent.md']);
  });

  it('skips missing files and a missing memory dir', () => {
    writeMemory('MEMORY.md', '# Index');
    expect(assembleMemoryBlocks(memoryLayout(SETTINGS, workingDir)).map((b) => b.label)).toEqual(['memory/MEMORY.md']);
    expect(assembleMemoryContext(memoryLayout(SETTINGS, join(tmpdir(), 'agentbus-mem-does-not-exist-xyz')))).toBe('');
    expect(assembleMemoryContext(memoryLayout(SETTINGS, null))).toBe('');
  });

  it('follows an absolute memory dir', () => {
    writeMemory('MEMORY.md', '# Abs index');
    const layout = memoryLayout({ ...SETTINGS, dir: join(workingDir, 'memory') }, null);
    expect(assembleMemoryContext(layout)).toContain('# Abs index');
  });
});

describe('formatLocalDate (E20)', () => {
  it('formats local date components zero-padded', () => {
    expect(formatLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});
