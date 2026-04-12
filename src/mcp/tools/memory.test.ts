import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerMemoryTools } from './memory.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMemoryTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('recall_memory tool', () => {
  it('returns { available: false } gracefully (E8/E9 not yet implemented)', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'recall_memory',
      arguments: { query: 'test query' },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      available: boolean;
      reason: string;
    };
    expect(data.available).toBe(false);
    expect(data.reason).toContain('not yet initialized');
    await client.close();
  });
});

describe('log_memory tool', () => {
  it('returns { available: false } gracefully (E8/E9 not yet implemented)', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'log_memory',
      arguments: { contact_id: 'contact:alice', content: 'Likes tea' },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      available: boolean;
    };
    expect(data.available).toBe(false);
    await client.close();
  });
});

describe('search_transcripts tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns results from bus', async () => {
    const mockResult = {
      message_id: 'msg-1',
      session_id: 'sess-1',
      channel: 'telegram',
      contact_id: 'contact:alice',
      direction: 'inbound',
      body: 'hello world',
      created_at: '2026-01-01T00:00:00Z',
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, results: [mockResult], count: 1 }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_transcripts',
      arguments: { query: 'hello' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      results: unknown[];
    };
    expect(data.results).toHaveLength(1);

    await client.close();
  });

  it('passes through available:false from bus', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, available: false, reason: 'Transcript search not available' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_transcripts',
      arguments: { query: 'hello' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      available: boolean;
    };
    expect(data.available).toBe(false);

    await client.close();
  });

  it('returns error when bus returns non-ok', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'FTS query error' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_transcripts',
      arguments: { query: 'bad query' },
    });

    expect(result.isError).toBe(true);

    await client.close();
  });

  it('rejects limit > 100 at schema validation', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_transcripts',
      arguments: { query: 'hello', limit: 101 },
    });
    expect(result.isError).toBe(true);

    await client.close();
  });
});
