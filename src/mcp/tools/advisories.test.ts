import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAdvisoryTools } from './advisories.js';

const BUS_URL = 'http://bus:4000';

async function makeClient(agentId = 'peggy-pool-2') {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerAdvisoryTools(server, BUS_URL, agentId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const respond = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!).text;

describe('advisory_ack tool (E65)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the calling agent id and returns the new state', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, {
      ok: true, already_acknowledged: false, advisory: { id: 'adv-1', state: 'acknowledged', condition_key: 'k' },
    }));
    const client = await makeClient();
    const result = await client.callTool({ name: 'advisory_ack', arguments: { id: 'adv-1' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ success: true, id: 'adv-1', state: 'acknowledged', already_acknowledged: false });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BUS_URL}/api/v1/advisories/adv-1/ack`);
    expect(JSON.parse((init as { body: string }).body)).toEqual({ agent_id: 'peggy-pool-2' });
    await client.close();
  });

  it.each([
    [404, /not found/],
    [403, /another agent/],
    [409, /already resolved/],
    [500, /Acknowledge failed/],
  ])('maps HTTP %i to a tool error', async (status, message) => {
    fetchMock.mockResolvedValueOnce(respond(status, { ok: false, error: 'x' }));
    const client = await makeClient();
    const result = await client.callTool({ name: 'advisory_ack', arguments: { id: 'adv-1' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    await client.close();
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = await makeClient();
    const result = await client.callTool({ name: 'advisory_ack', arguments: { id: 'adv-1' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/ECONNREFUSED/);
    await client.close();
  });
});
