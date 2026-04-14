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

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as unknown;
}

describe('recall_memory tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns memories from bus', async () => {
    const mockMemory = {
      id: 'mem-1',
      contact_id: 'contact:chris',
      category: 'preference',
      content: 'Likes tea',
      confidence: 0.95,
      source: 'summarizer',
      created_at: '2026-04-12T10:00:00Z',
      expires_at: null,
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, memories: [mockMemory], count: 1 }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'recall_memory',
      arguments: { query: 'tea' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { memories: unknown[]; count: number };
    expect(data.memories).toHaveLength(1);
    expect(data.count).toBe(1);
    await client.close();
  });

  it('returns available: false when memory system not initialized', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, available: false, reason: 'Memory system not yet initialized', memories: [] }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'recall_memory',
      arguments: { query: 'tea' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { available: boolean; memories: unknown[] };
    expect(data.available).toBe(false);
    expect(data.memories).toHaveLength(0);
    await client.close();
  });

  it('passes contact_id and category query params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, memories: [], count: 0 }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'recall_memory',
      arguments: { query: 'test', contact_id: 'contact:alice', category: 'preference', limit: 5 },
    });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('contact_id=contact%3Aalice');
    expect(calledUrl).toContain('category=preference');
    expect(calledUrl).toContain('limit=5');
    await client.close();
  });

  it('returns tool error when bus returns non-ok', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'recall_memory',
      arguments: { query: 'test' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('log_memory tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with new memory ID', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'new-mem-id', superseded: null }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'log_memory',
      arguments: { contact_id: 'contact:alice', content: 'Prefers tea' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { ok: boolean; id: string; superseded: null };
    expect(data.ok).toBe(true);
    expect(data.id).toBe('new-mem-id');
    expect(data.superseded).toBeNull();
    await client.close();
  });

  it('returns superseded ID when an old memory was replaced', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'new-id', superseded: 'old-id' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'log_memory',
      arguments: {
        contact_id: 'contact:alice',
        content: 'Updated preference',
        category: 'preference',
        confidence: 0.95,
      },
    });

    const data = parseResult(result) as { superseded: string };
    expect(data.superseded).toBe('old-id');
    await client.close();
  });

  it('returns available: false when memory system is not initialized', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: 'Memory system not yet initialized' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'log_memory',
      arguments: { contact_id: 'contact:alice', content: 'Test fact' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { available: boolean };
    expect(data.available).toBe(false);
    await client.close();
  });

  it('returns tool error when bus returns non-ok (non-503)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Validation error' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'log_memory',
      arguments: { contact_id: 'contact:alice', content: 'Test' },
    });

    expect(result.isError).toBe(true);
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
    const data = parseResult(result) as { results: unknown[] };
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
    const data = parseResult(result) as { available: boolean };
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
