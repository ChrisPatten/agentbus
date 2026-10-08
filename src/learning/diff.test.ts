import { describe, it, expect } from 'vitest';
import { applyUnifiedDiff, compactDiff, DiffApplyError } from './diff.js';

const before = ['# Baxter', '', '## Rules', '- Be brief.', '- Use 12-hour time.', '- Sign off as Baxter.', ''].join('\n');
const after = ['# Baxter', '', '## Rules', '- Be brief.', '- Always use 24-hour time (14:00, not 2pm).', '- Sign off as Baxter.', ''].join('\n');

describe('compactDiff', () => {
  it('shows a unified hunk with context', () => {
    expect(compactDiff(before, after, { label: 'CLAUDE.md' })).toBe([
      '--- a/CLAUDE.md', '+++ b/CLAUDE.md',
      '@@ -3,4 +3,4 @@', ' ## Rules', ' - Be brief.', '-- Use 12-hour time.', '+- Always use 24-hour time (14:00, not 2pm).', ' - Sign off as Baxter.',
    ].join('\n'));
  });

  it('handles new files, no changes and truncation', () => {
    expect(compactDiff(null, 'a\nb\n', { label: 'skills/x.md' })).toBe('--- /dev/null\n+++ b/skills/x.md\n@@ -0,0 +1,2 @@\n+a\n+b');
    expect(compactDiff('same\n', 'same\n')).toBe('(no changes)');
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const cut = compactDiff('', big, { maxChars: 200 });
    expect(cut.length).toBeLessThan(260);
    expect(cut).toMatch(/more changed lines not shown\)$/);
  });

  it('round-trips through applyUnifiedDiff', () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const changed = text.replace('l3\n', 'L3\n').replace('l20\n', 'l20\nnew\n').replace('l28\n', '');
    expect(applyUnifiedDiff(text, compactDiff(text, changed, { label: 'f', maxChars: 100_000 }))).toBe(changed);
  });
});

describe('applyUnifiedDiff', () => {
  const diff = ['--- a/CLAUDE.md', '+++ b/CLAUDE.md', '@@ -4,3 +4,3 @@', ' - Be brief.', '-- Use 12-hour time.', '+- Always use 24-hour time (14:00, not 2pm).', ' - Sign off as Baxter.'].join('\n');

  it('applies a hunk, also when lines moved a little', () => {
    expect(applyUnifiedDiff(before, diff)).toBe(after);
    expect(applyUnifiedDiff(`intro\nmore\n${before}`, diff)).toBe(`intro\nmore\n${after}`);
  });

  it('creates a file from an empty one and handles removed lines starting with dashes', () => {
    expect(applyUnifiedDiff('', '@@ -0,0 +1,2 @@\n+a\n+b')).toBe('a\nb\n');
    expect(applyUnifiedDiff('x\n-- y\nz\n', '@@ -1,3 +1,2 @@\n x\n--- y\n z')).toBe('x\nz\n');
  });

  it('rejects a diff that does not match', () => {
    expect(() => applyUnifiedDiff('other\ntext\n', diff)).toThrow(DiffApplyError);
    expect(() => applyUnifiedDiff(before, 'no hunks here')).toThrow(/no hunks/);
    expect(() => applyUnifiedDiff(before, '@@ -1,3 +1,3 @@\n # Baxter')).toThrow(/ends inside a hunk/);
  });
});
