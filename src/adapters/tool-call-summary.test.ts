import { describe, it, expect } from 'vitest';
import { formatToolCallSummary } from './tool-call-summary.js';

describe('formatToolCallSummary', () => {
  it('Bash uses input.description verbatim, wrapped in a code span', () => {
    expect(formatToolCallSummary('Bash', { description: 'Run the test suite' })).toBe(
      '🐚 `Run the test suite`',
    );
  });

  it('Agent uses input.description verbatim, wrapped in a code span', () => {
    expect(formatToolCallSummary('Agent', { description: 'Explore the auth module' })).toBe(
      '🤖 `Explore the auth module`',
    );
  });

  it('Read renders file_path in a code span', () => {
    expect(formatToolCallSummary('Read', { file_path: '/src/index.ts' })).toBe(
      '📖 Reading `/src/index.ts`',
    );
  });

  it('Edit renders file_path in a code span', () => {
    expect(formatToolCallSummary('Edit', { file_path: '/src/index.ts' })).toBe(
      '✏️ Editing `/src/index.ts`',
    );
  });

  it('Write renders file_path in a code span', () => {
    expect(formatToolCallSummary('Write', { file_path: '/src/new.ts' })).toBe(
      '📝 Writing `/src/new.ts`',
    );
  });

  it('Grep renders pattern in a code span', () => {
    expect(formatToolCallSummary('Grep', { pattern: 'TODO' })).toBe('🔍 Searching for `TODO`');
  });

  it('WebFetch renders url in a code span', () => {
    expect(formatToolCallSummary('WebFetch', { url: 'https://example.com' })).toBe(
      '🌐 Fetching `https://example.com`',
    );
  });

  it('WebSearch renders query in a code span', () => {
    expect(formatToolCallSummary('WebSearch', { query: 'agentbus release notes' })).toBe(
      '🔎 Searching: `agentbus release notes`',
    );
  });

  it('unknown tool name falls back to the generic line, name in a code span', () => {
    expect(formatToolCallSummary('SomeFutureTool', { foo: 'bar' })).toBe(
      '⚙️ Running `SomeFutureTool`',
    );
  });

  it('a file_path containing an underscore round-trips as a single code span, not italics', () => {
    expect(formatToolCallSummary('Read', { file_path: '/src/search_transcripts.ts' })).toBe(
      '📖 Reading `/src/search_transcripts.ts`',
    );
  });

  it('a value containing a backtick is substituted, not passed through raw', () => {
    expect(formatToolCallSummary('Grep', { pattern: 'foo`bar' })).toBe(
      '🔍 Searching for `foo´bar`',
    );
  });

  it('truncation runs before backtick substitution, so the budget reflects raw content', () => {
    const longPath = '/a/'.repeat(100); // 300 chars
    const result = formatToolCallSummary('Read', { file_path: longPath });
    expect(result).toBe(`📖 Reading \`${'/a/'.repeat(100).slice(0, 200)}…\``);
  });

  it('Bash missing description degrades to the identical generic fallback', () => {
    expect(formatToolCallSummary('Bash', {})).toBe('⚙️ Running `Bash`');
  });

  it('Bash with a non-string description degrades to the generic fallback', () => {
    expect(formatToolCallSummary('Bash', { description: 42 })).toBe('⚙️ Running `Bash`');
  });

  it('Bash with an empty-string description degrades to the generic fallback', () => {
    expect(formatToolCallSummary('Bash', { description: '   ' })).toBe('⚙️ Running `Bash`');
  });

  it('Read missing file_path degrades to the generic fallback', () => {
    expect(formatToolCallSummary('Read', {})).toBe('⚙️ Running `Read`');
  });

  it('truncates an overly long field so it can never blow the draft length budget alone', () => {
    const longPath = '/a/'.repeat(100); // 300 chars
    const result = formatToolCallSummary('Read', { file_path: longPath });
    expect(result.length).toBeLessThan(longPath.length);
    expect(result.endsWith('…`')).toBe(true);
  });

  it('empty tool name falls back to a generic label without throwing', () => {
    expect(formatToolCallSummary('', {})).toBe('⚙️ Running tool');
  });
});
