import { describe, it, expect } from 'vitest';
import {
  loadPhrases,
  phraseForToolCall,
  sanitizeStatusText,
  TurnStatusTracker,
  STATUS_TOOL_NAME,
  type PhrasesFile,
} from './tool-status.js';

const table = loadPhrases();

function words(s: string): number {
  return s.split(' ').length;
}

describe('bundled phrases file', () => {
  it('has only 2-5 word phrases of at most 40 characters', () => {
    const all: string[] = [
      table.default ?? '',
      ...Object.values(table.tools ?? {}),
      ...(table.bash ?? []).map((b) => b.text),
      ...(table.prefixes ?? []).flatMap((p) => [p.default ?? '', ...Object.values(p.tools ?? {})]),
    ].filter(Boolean);
    expect(all.length).toBeGreaterThan(20);
    for (const phrase of all) {
      expect(words(phrase), phrase).toBeGreaterThanOrEqual(2);
      expect(words(phrase), phrase).toBeLessThanOrEqual(5);
      expect(phrase.length, phrase).toBeLessThanOrEqual(40);
    }
  });
});

describe('phraseForToolCall', () => {
  it('maps generic tools', () => {
    expect(phraseForToolCall('Read', {}, table)).toBe('Reading a file');
    expect(phraseForToolCall('Grep', {}, table)).toBe('Searching the files');
    expect(phraseForToolCall('Glob', {}, table)).toBe('Searching the files');
    expect(phraseForToolCall('WebSearch', {}, table)).toBe('Searching the web');
  });

  it('maps MCP tools by prefix, with a per-tool refinement for agentbus', () => {
    expect(phraseForToolCall('mcp__copilot__get_transactions_live', {}, table)).toBe('Checking the finances');
    expect(phraseForToolCall('mcp__bmp__bmp_get_lists', {}, table)).toBe('Checking the lists');
    expect(phraseForToolCall('mcp__claude-in-chrome__navigate', {}, table)).toBe('Working in the browser');
    expect(phraseForToolCall('mcp__agentbus__search_transcripts', {}, table)).toBe('Searching past conversations');
    expect(phraseForToolCall('mcp__agentbus__brand_new_tool', {}, table)).toBe('Working with the message bus');
  });

  it('falls back to "Working on it" for unknown tools and an empty table', () => {
    expect(phraseForToolCall('mcp__mystery__thing', {}, table)).toBe('Working on it');
    expect(phraseForToolCall('Whatever', {}, {})).toBe('Working on it');
    expect(phraseForToolCall('Whatever', {}, { default: '  ' })).toBe('Working on it');
  });

  it('refines Bash by the command word', () => {
    const bash = (command: string) => phraseForToolCall('Bash', { command }, table);
    expect(bash('calctl show today --output json')).toBe('Checking the calendar');
    expect(bash('rtk proxy calctl show today')).toBe('Checking the calendar');
    expect(bash('/opt/homebrew/bin/remindctl list Work --plain')).toBe('Checking reminders');
    expect(bash('cd /x && scripts/capos balances')).toBe('Checking the ledger');
    expect(bash('imsg history 4 --limit 5')).toBe('Checking your messages');
    expect(bash('scripts/bear.sh find x')).toBe('Checking your notes');
    expect(bash('ls -la')).toBe('Running a command');
    expect(bash('echo calctl')).toBe('Running a command');
    expect(bash('calctlx foo')).toBe('Running a command');
    expect(phraseForToolCall('Bash', {}, table)).toBe('Running a command');
    expect(phraseForToolCall('Bash', { command: 42 }, table)).toBe('Running a command');
  });

  it('never leaks any input content into the phrase', () => {
    const secret = 'S3CRET-/Users/chris/private.txt https://example.com/x?token=abc "message body"';
    const inputs: Record<string, unknown>[] = [
      { command: `echo ${secret}`, description: secret },
      { file_path: secret, url: secret, query: secret, pattern: secret, text: secret, body: secret },
    ];
    const names = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Skill', 'ToolSearch',
      'mcp__agentbus__send_email', 'mcp__bmp__bmp_add_item', 'mcp__copilot__create_transaction',
      'mcp__claude-in-chrome__javascript_tool', 'mcp__unknown__tool', 'Unknown'];
    for (const name of names) {
      for (const input of inputs) {
        const out = phraseForToolCall(name, input, table);
        expect(out).not.toMatch(/S3CRET|private|example|token|message body|\//);
      }
    }
  });
});

describe('sanitizeStatusText', () => {
  it('cleans and accepts plain text', () => {
    expect(sanitizeStatusText('Checking the calendar')).toBe('Checking the calendar');
    expect(sanitizeStatusText('  Checking   the\ncalendar!  ')).toBe('Checking the calendar');
    expect(sanitizeStatusText('*Reading* `your` _mail_')).toBe('Reading your mail');
    expect(sanitizeStatusText("Reading Kate's mail")).toBe("Reading Kate's mail");
  });

  it('rejects empty, non-string, over-long and too-wordy text', () => {
    expect(sanitizeStatusText('')).toBeNull();
    expect(sanitizeStatusText('   ')).toBeNull();
    expect(sanitizeStatusText('***')).toBeNull();
    expect(sanitizeStatusText(7)).toBeNull();
    expect(sanitizeStatusText(undefined)).toBeNull();
    expect(sanitizeStatusText('a'.repeat(41))).toBeNull();
    expect(sanitizeStatusText('a'.repeat(40))).toBe('a'.repeat(40));
    expect(sanitizeStatusText('one two three four five six')).toBeNull();
    expect(sanitizeStatusText('one two three four five')).toBe('one two three four five');
  });
});

describe('TurnStatusTracker', () => {
  const phrases: PhrasesFile = table;

  it('emits transient phrase lines and skips an immediate repeat', () => {
    const t = new TurnStatusTracker('phrases', phrases);
    expect(t.next({ name: 'Read', input: { file_path: '/a' } })).toEqual({ text: 'Reading a file', transient: true });
    expect(t.next({ name: 'Read', input: { file_path: '/b' } })).toBeUndefined();
    expect(t.next({ name: 'Grep', input: {} })).toEqual({ text: 'Searching the files', transient: true });
  });

  it('never produces a line for the status tool itself unless it carries valid text', () => {
    const t = new TurnStatusTracker('phrases', phrases);
    expect(t.next({ name: STATUS_TOOL_NAME, input: { text: '' } })).toBeUndefined();
    expect(t.next({ name: STATUS_TOOL_NAME, input: {} })).toBeUndefined();
    // invalid text did not make anything sticky
    expect(t.next({ name: 'Read', input: {} })?.text).toBe('Reading a file');
  });

  it('an agent-authored status holds for the rest of the turn until the next status call', () => {
    const t = new TurnStatusTracker('phrases', phrases);
    expect(t.next({ name: STATUS_TOOL_NAME, input: { text: 'Comparing the quotes' } })).toEqual({
      text: 'Comparing the quotes',
      transient: true,
    });
    expect(t.next({ name: 'Read', input: {} })).toBeUndefined();
    expect(t.next({ name: 'Bash', input: { command: 'calctl show today' } })).toBeUndefined();
    expect(t.next({ name: STATUS_TOOL_NAME, input: { text: 'Drafting the reply' } })?.text).toBe('Drafting the reply');
    expect(t.next({ name: 'Read', input: {} })).toBeUndefined();
  });

  it('a new turn starts with a fresh tracker (no carried stickiness)', () => {
    const first = new TurnStatusTracker('phrases', phrases);
    first.next({ name: STATUS_TOOL_NAME, input: { text: 'Comparing the quotes' } });
    const second = new TurnStatusTracker('phrases', phrases);
    expect(second.next({ name: 'Read', input: {} })?.text).toBe('Reading a file');
  });

  it('raw mode restores the E29 lines and keeps the status tool silent', () => {
    const t = new TurnStatusTracker('raw', phrases);
    expect(t.next({ name: 'Read', input: { file_path: '/a/b.ts' } })).toEqual({ text: '📖 Reading `/a/b.ts`', transient: false });
    expect(t.next({ name: STATUS_TOOL_NAME, input: { text: 'Comparing the quotes' } })).toBeUndefined();
    expect(t.next({ name: 'Read', input: { file_path: '/a/b.ts' } })?.text).toBe('📖 Reading `/a/b.ts`');
  });
});
