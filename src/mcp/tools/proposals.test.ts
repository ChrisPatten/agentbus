import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerProposalTools } from './proposals.js';

const BUS_URL = 'http://bus:4000';

async function makeClient(agentId = 'baxter') {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerProposalTools(server, BUS_URL, agentId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const respond = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!).text;

describe('propose_change tool (E68 S68.3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the proposal with the calling agent id', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { ok: true, id: 'p1', status: 'pending', notified: 1, expires_at: '2026-10-13T12:00:00.000Z' }));
    const client = await makeClient();
    const result = await client.callTool({
      name: 'propose_change',
      arguments: { path: 'CLAUDE.md', diff: '@@ -1 +1 @@\n-a\n+b', rationale: 'Repeated correction.', evidence: ['2026-10-01'] },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ success: true, proposal_id: 'p1', notified_owners: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BUS_URL}/api/v1/proposals`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      agent_id: 'baxter', path: 'CLAUDE.md', diff: '@@ -1 +1 @@\n-a\n+b', rationale: 'Repeated correction.', evidence: ['2026-10-01'],
    });
  });

  it('needs exactly one of new_content or diff, and explains rejections', async () => {
    const client = await makeClient();
    const both = await client.callTool({ name: 'propose_change', arguments: { path: 'CLAUDE.md', rationale: 'r' } });
    expect(both.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(respond(429, { ok: false, error: 'rate_limited', message: 'at most 3 proposals per agent per day' }));
    const limited = await client.callTool({ name: 'propose_change', arguments: { path: 'CLAUDE.md', new_content: 'x', rationale: 'r' } });
    expect(limited.isError).toBe(true);
    expect(text(limited)).toContain('rate_limited');
    expect(text(limited)).toContain('at most 3');
  });
});
