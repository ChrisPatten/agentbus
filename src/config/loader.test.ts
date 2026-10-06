import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, retiredMemoryKeys } from './loader.js';

let dir: string | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('retired summarizer keys (E66)', () => {
  it('finds the retired memory keys in raw config', () => {
    expect(retiredMemoryKeys({ memory: { claude_api_model: 'x', structured_extraction: false, session_idle_threshold_ms: 1 } }))
      .toEqual(['claude_api_model', 'structured_extraction']);
    expect(retiredMemoryKeys({ memory: {} })).toEqual([]);
    expect(retiredMemoryKeys(null)).toEqual([]);
  });

  it('loads a config that still sets them, with a deprecation warning', () => {
    dir = mkdtempSync(join(tmpdir(), 'loader-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, [
      'bus:',
      `  db_path: ${join(dir, 'bus.db')}`,
      'adapters: {}',
      'memory:',
      '  claude_api_model: claude-sonnet-4-6',
      '  summary_max_tokens: 8192',
      '  structured_extraction: true',
      '',
    ].join('\n'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(path, join(dir, '.env'));
    expect(config.bus.db_path).toBe(join(dir, 'bus.db'));
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('memory.claude_api_model, memory.summary_max_tokens, memory.structured_extraction are deprecated and ignored'))).toBe(true);
  });
});
