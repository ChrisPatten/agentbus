import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerChannelTools } from './channels.js';

const BUS_URL = 'http://bus:4000';

function makeServer() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerChannelTools(server, BUS_URL);
  return server;
}

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('list_channels tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns adapter list from bus', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        adapters: [
          { id: 'telegram', name: 'telegram', channels: ['telegram'], capabilities: { send: true } },
        ],
      }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({ name: 'list_channels', arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as unknown[];
    expect(content).toHaveLength(1);
    expect((content[0] as { id: string }).id).toBe('telegram');

    await client.close();
  });

  it('returns error when bus is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({ name: 'list_channels', arguments: {} });
    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Failed to list channels');

    await client.close();
  });

  it('returns error when bus returns non-ok status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({ name: 'list_channels', arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
  });
});
