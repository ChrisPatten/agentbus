import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/schema.js';

const stubConfig: AppConfig = {
  bus: { http_port: 4321, db_path: ':memory:', log_level: 'info' },
  adapters: {
    'cc-headless': {
      peggy: {
        agent_id: 'peggy',
        poll_interval_ms: 1000,
        system_prompt: 'You are Peggy.',
        claude_bin: 'claude',
        error_reply: 'err',
        error_passthrough: false,
        memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
        journaling: { enabled: true, threshold_ms: 1_800_000, prompt: 'journal' },
      },
      pokeclaude: {
        agent_id: 'pokeclaude',
        poll_interval_ms: 1000,
        system_prompt: 'You are pokeclaude.',
        claude_bin: 'claude',
        error_reply: 'err',
        error_passthrough: false,
        memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
        journaling: { enabled: true, threshold_ms: 1_800_000, prompt: 'journal' },
      },
    },
  },
  contacts: {},
  topics: ['general'],
  agents: {},
  memory: { session_close_min_messages: 0 },
  pipeline: { routes: [] },
} as unknown as AppConfig;

const legacySingleConfig: AppConfig = {
  ...stubConfig,
  adapters: {
    'cc-headless': {
      agent_id: 'peggy',
      poll_interval_ms: 1000,
      system_prompt: 'You are Peggy.',
      claude_bin: 'claude',
      error_reply: 'err',
      error_passthrough: false,
      memory: { dir: 'memory', index_file: 'MEMORY.md', daily_subdir: 'daily', journal_lookback_days: 3 },
      journaling: { enabled: true, threshold_ms: 1_800_000, prompt: 'journal' },
    },
  },
} as unknown as AppConfig;

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(() => currentConfig),
}));

// cc.ts is a runnable entrypoint script (legacy claude-code adapter) that
// connects a real MCP stdio server and starts its own live polling loop as a
// top-level side effect on import. cc-headless.ts only needs its pure
// `formatMessagesForSampling` helper, so stub the module to avoid pulling in
// those side effects (which would otherwise fire real fetches against the
// mocked global.fetch below, contaminating assertions about this module).
vi.mock('./cc.js', () => ({
  formatMessagesForSampling: vi.fn(() => ''),
}));

let currentConfig: AppConfig = stubConfig;

const db = {} as unknown as Database.Database;

function emptyPollResponse(): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, messages: [] }),
  } as unknown as Response;
}

describe('extractToolCalls (E29)', () => {
  it('returns [] for a non-assistant event', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    expect(extractToolCalls({ type: 'result' })).toEqual([]);
  });

  it('returns [] for an assistant event with no content array', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    expect(extractToolCalls({ type: 'assistant' })).toEqual([]);
    expect(extractToolCalls({ type: 'assistant', message: {} })).toEqual([]);
  });

  it('flags a delivery tool call as isDelivery: true', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    const calls = extractToolCalls({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__agentbus__reply', input: { text: 'hi' } }] },
    });
    expect(calls).toEqual([{ name: 'mcp__agentbus__reply', input: { text: 'hi' }, isDelivery: true }]);
  });

  it('flags a non-delivery tool call as isDelivery: false', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    const calls = extractToolCalls({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'run tests' } }] },
    });
    expect(calls).toEqual([{ name: 'Bash', input: { description: 'run tests' }, isDelivery: false }]);
  });

  it('normalizes a missing/non-object input to {}', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    const calls = extractToolCalls({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }] },
    });
    expect(calls).toEqual([{ name: 'Read', input: {}, isDelivery: false }]);
  });

  it('extracts multiple blocks in order, mixing delivery and non-delivery calls', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    const calls = extractToolCalls({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { description: 'first' } },
          { type: 'text' },
          { type: 'tool_use', name: 'mcp__agentbus__send_message', input: { text: 'done' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
    });
    expect(calls.map((c) => c.name)).toEqual(['Bash', 'mcp__agentbus__send_message', 'Read']);
    expect(calls.map((c) => c.isDelivery)).toEqual([false, true, false]);
  });

  it('skips content blocks with no name or a non-tool_use type', async () => {
    const { extractToolCalls } = await import('./cc-headless.js');
    const calls = extractToolCalls({
      type: 'assistant',
      message: { content: [{ type: 'text' }, { type: 'tool_use' }] },
    });
    expect(calls).toEqual([]);
  });
});

describe('normalizeContactId (/stop reaches a turn regardless of key format)', () => {
  it('strips the "contact:" prefix used by processBatch', async () => {
    const { normalizeContactId } = await import('./cc-headless.js');
    expect(normalizeContactId('contact:chris')).toBe('chris');
  });

  it('leaves the bare form used by journaling turns unchanged', async () => {
    const { normalizeContactId } = await import('./cc-headless.js');
    expect(normalizeContactId('chris')).toBe('chris');
  });
});

describe('selectReportableCalls (E29 — no tool calls surfaced after delivery)', () => {
  it('reports a non-delivery call when nothing has delivered yet', async () => {
    const { selectReportableCalls } = await import('./cc-headless.js');
    const { reportable, delivered } = selectReportableCalls(
      [{ name: 'Bash', input: { description: 'run tests' }, isDelivery: false }],
      false,
    );
    expect(reportable).toEqual([{ name: 'Bash', input: { description: 'run tests' }, isDelivery: false }]);
    expect(delivered).toBe(false);
  });

  it('flips delivered to true on a delivery call and reports nothing for it', async () => {
    const { selectReportableCalls } = await import('./cc-headless.js');
    const { reportable, delivered } = selectReportableCalls(
      [{ name: 'mcp__agentbus__reply', input: {}, isDelivery: true }],
      false,
    );
    expect(reportable).toEqual([]);
    expect(delivered).toBe(true);
  });

  it('suppresses a non-delivery call that comes after a delivery call in the same event', async () => {
    const { selectReportableCalls } = await import('./cc-headless.js');
    const { reportable, delivered } = selectReportableCalls(
      [
        { name: 'mcp__agentbus__send_message', input: {}, isDelivery: true },
        { name: 'Bash', input: { description: 'cleanup after delivering' }, isDelivery: false },
      ],
      false,
    );
    expect(reportable).toEqual([]);
    expect(delivered).toBe(true);
  });

  it('still reports a non-delivery call that comes before the delivery call in the same event', async () => {
    const { selectReportableCalls } = await import('./cc-headless.js');
    const { reportable, delivered } = selectReportableCalls(
      [
        { name: 'Read', input: { file_path: '/a.ts' }, isDelivery: false },
        { name: 'mcp__agentbus__reply', input: {}, isDelivery: true },
      ],
      false,
    );
    expect(reportable).toEqual([{ name: 'Read', input: { file_path: '/a.ts' }, isDelivery: false }]);
    expect(delivered).toBe(true);
  });

  it('suppresses every call once already delivered from an earlier event, reproducing the reported bug', async () => {
    const { selectReportableCalls } = await import('./cc-headless.js');
    // Simulates the sequence across multiple stream-json events: the agent
    // delivers via reply(), then keeps working and makes another Bash call.
    // Before the fix, this second call re-opened a brand-new draft message
    // after the user had already received their answer.
    const afterDelivery = selectReportableCalls(
      [{ name: 'mcp__agentbus__reply', input: {}, isDelivery: true }],
      false,
    );
    expect(afterDelivery.delivered).toBe(true);

    const postDeliveryCall = selectReportableCalls(
      [{ name: 'Bash', input: { description: 'post-delivery cleanup' }, isDelivery: false }],
      afterDelivery.delivered,
    );
    expect(postDeliveryCall.reportable).toEqual([]);
    expect(postDeliveryCall.delivered).toBe(true);
  });
});

describe('cc-headless multi-instance lifecycle (E23)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn().mockResolvedValue(emptyPollResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    const { stopHeadless } = await import('./cc-headless.js');
    stopHeadless();
    vi.restoreAllMocks();
  });

  it('starts one independent poller per named instance, each scoped to its own agent_id', async () => {
    currentConfig = stubConfig;
    const { startHeadless } = await import('./cc-headless.js');

    const handles = startHeadless(db);
    await new Promise((r) => setTimeout(r, 10));

    expect(handles.size).toBe(2);
    expect(handles.has('agent:peggy')).toBe(true);
    expect(handles.has('agent:pokeclaude')).toBe(true);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('agent=peggy'))).toBe(true);
    expect(urls.some((u) => u.includes('agent=pokeclaude'))).toBe(true);
  });

  it('exposes stopTurn on the handle, returning false when no turn is running (/stop)', async () => {
    currentConfig = stubConfig;
    const { startHeadless } = await import('./cc-headless.js');

    const handles = startHeadless(db);
    await new Promise((r) => setTimeout(r, 10));

    const peggy = handles.get('agent:peggy')!;
    expect(peggy.stopTurn('contact:nobody')).toBe(false);
  });

  it('starts exactly one instance for the legacy single-object config form', async () => {
    currentConfig = legacySingleConfig;
    const { startHeadless } = await import('./cc-headless.js');

    const handles = startHeadless(db);
    await new Promise((r) => setTimeout(r, 10));

    expect(handles.size).toBe(1);
    expect(handles.has('agent:peggy')).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/messages/pending'))).toHaveLength(1);
  });

  it('stopHeadless() stops every running instance — no further polls fire', async () => {
    currentConfig = stubConfig;
    const { startHeadless, stopHeadless } = await import('./cc-headless.js');

    startHeadless(db);
    await new Promise((r) => setTimeout(r, 10));
    const callsBeforeStop = fetchMock.mock.calls.length;

    stopHeadless();
    // Wait past the poll_interval_ms both instances were configured with.
    await new Promise((r) => setTimeout(r, 1200));

    expect(fetchMock.mock.calls.length).toBe(callsBeforeStop);
  });
});
