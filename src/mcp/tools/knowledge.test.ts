import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerKnowledgeTools } from './knowledge.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerKnowledgeTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as unknown;
}

describe('write_knowledge tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the new id, content_hash, and superseded_id on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'know-1', content_hash: 'abc123', superseded_id: null }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'write_knowledge',
      arguments: { agent_id: 'peggy', kind: 'note', title: 'Title', payload: '{"v":1}' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { id: string; content_hash: string; superseded_id: null };
    expect(data.id).toBe('know-1');
    expect(data.content_hash).toBe('abc123');
    expect(data.superseded_id).toBeNull();
    await client.close();
  });

  it('sends the input straight through as the POST body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'know-2', content_hash: 'x', superseded_id: 'know-1' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'write_knowledge',
      arguments: {
        agent_id: 'peggy',
        kind: 'note',
        title: 'Title',
        payload: '{"v":2}',
        tags: ['a', 'b'],
        supersedes: 'know-1',
      },
    });

    const call = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe(`${BUS_URL}/api/v1/knowledge`);
    const sentBody = JSON.parse(call[1].body) as { supersedes: string; tags: string[] };
    expect(sentBody.supersedes).toBe('know-1');
    expect(sentBody.tags).toEqual(['a', 'b']);
    await client.close();
  });

  it('returns tool error when bus returns non-ok', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'payload must be valid JSON' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'write_knowledge',
      arguments: { agent_id: 'peggy', kind: 'note', title: 'Title', payload: 'not json' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('get_knowledge tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the knowledge row on success', async () => {
    const row = { id: 'know-1', title: 'Title', kind: 'note' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, knowledge: row }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'get_knowledge', arguments: { id: 'know-1' } });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { knowledge: { id: string } };
    expect(data.knowledge.id).toBe('know-1');
    await client.close();
  });

  it('returns a tool error on 404', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'Knowledge row not found: nope' }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'get_knowledge', arguments: { id: 'nope' } });

    expect(result.isError).toBe(true);
    await client.close();
  });

  it('returns a tool error on other non-ok responses', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'boom' }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'get_knowledge', arguments: { id: 'know-1' } });

    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('forget_knowledge tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts mode and superseded_by, returns ok:true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'forget_knowledge',
      arguments: { id: 'know-1', mode: 'supersede', superseded_by: 'know-2' },
    });

    expect(result.isError).toBeFalsy();
    const call = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe(`${BUS_URL}/api/v1/knowledge/know-1/forget`);
    expect(JSON.parse(call[1].body)).toEqual({ mode: 'supersede', superseded_by: 'know-2' });
    await client.close();
  });

  it('returns a tool error when the bus rejects the request', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'mode "supersede" requires opts.supersededBy' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'forget_knowledge',
      arguments: { id: 'know-1', mode: 'supersede' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('search_knowledge tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns results from bus', async () => {
    const row = { id: 'know-1', title: 'Title' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, results: [row], count: 1 }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { agent_id: 'peggy', q: 'title' },
    });

    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as { results: unknown[]; count: number };
    expect(data.results).toHaveLength(1);
    expect(data.count).toBe(1);
    await client.close();
  });

  it('passes agent_id, kind, tags (comma-joined) and facets (JSON) as query params', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, results: [], count: 0 }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'search_knowledge',
      arguments: {
        agent_id: 'peggy',
        kind: 'note',
        tags: ['a', 'b'],
        facets: { project: 'agentbus' },
        limit: 5,
      },
    });

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('agent_id=peggy');
    expect(calledUrl).toContain('kind=note');
    expect(calledUrl).toContain('tags=a%2Cb');
    expect(calledUrl).toContain(encodeURIComponent(JSON.stringify({ project: 'agentbus' })));
    expect(calledUrl).toContain('limit=5');
    await client.close();
  });

  it('returns a tool error when bus returns non-ok', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'bad',
      json: async () => ({ ok: false, error: 'Query parameter "agent_id" is required' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { agent_id: 'peggy' },
    });

    expect(result.isError).toBe(true);
    await client.close();
  });

  it('rejects limit > 50 at schema validation', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'search_knowledge',
      arguments: { agent_id: 'peggy', limit: 51 },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
