import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerSessionTools } from './sessions.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerSessionTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const mockSession = {
  id: 'sess-1',
  conversation_id: 'conv-1',
  channel: 'telegram',
  contact_id: 'contact:alice',
  started_at: '2026-01-01T00:00:00Z',
  last_activity: '2026-01-01T01:00:00Z',
  ended_at: null,
  message_count: 5,
  summary: null,
};

describe('get_session tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches session by ID', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, session: mockSession }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'get_session',
      arguments: { session_id: 'sess-1' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      session_id: string;
      id: string;
    };
    expect(data.session_id).toBe('sess-1');

    await client.close();
  });

  it('returns available:false when session not found (404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'get_session',
      arguments: { session_id: 'no-such-session' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      available: boolean;
    };
    expect(data.available).toBe(false);

    await client.close();
  });

  it('returns most recent session when no session_id provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, sessions: [mockSession] }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'get_session', arguments: {} });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as { id: string };
    expect(data.id).toBe('sess-1');

    await client.close();
  });

  it('returns available:false when no sessions exist', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, sessions: [] }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'get_session', arguments: {} });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      available: boolean;
    };
    expect(data.available).toBe(false);

    await client.close();
  });

  it('returns error on 5xx from bus', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'Database error' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'get_session',
      arguments: { session_id: 'sess-1' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Failed to fetch session');

    await client.close();
  });
});

describe('list_sessions tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns session list', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, sessions: [mockSession, { ...mockSession, id: 'sess-2' }] }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      sessions: unknown[];
      count: number;
    };
    expect(data.sessions).toHaveLength(2);
    expect(data.count).toBe(2);

    await client.close();
  });

  it('passes channel filter in query string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, sessions: [] }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'list_sessions',
      arguments: { channel: 'telegram' },
    });

    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toContain('channel=telegram');

    await client.close();
  });

  it('passes contact_id and since filters in query string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, sessions: [] }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'list_sessions',
      arguments: { contact_id: 'contact:alice', since: '2026-01-01T00:00:00Z' },
    });

    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toContain('contact_id=contact%3Aalice');
    expect(url).toContain('since=');

    await client.close();
  });

  it('rejects limit > 100 at schema validation', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'list_sessions',
      arguments: { limit: 101 },
    });
    expect(result.isError).toBe(true);

    await client.close();
  });

  it('returns error when bus fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'Database error' }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
  });
});
