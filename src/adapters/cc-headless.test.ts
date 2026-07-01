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
