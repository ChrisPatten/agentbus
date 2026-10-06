import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerJournalTools } from './journal.js';

const BUS_URL = 'http://bus:4000';

async function makeClient(agentId = 'peggy-pool-2') {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerJournalTools(server, BUS_URL, agentId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const respond = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!).text;

describe('journal_complete tool (E66 S66.8)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts the run id with the calling agent id', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { ok: true, run_id: 'run-1' }));
    const client = await makeClient();
    const result = await client.callTool({ name: 'journal_complete', arguments: { run_id: 'run-1', files_changed: ['memory/MEMORY.md'], notes: 'n' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ success: true, run_id: 'run-1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BUS_URL}/api/v1/journal/complete`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ run_id: 'run-1', agent_id: 'peggy-pool-2', files_changed: ['memory/MEMORY.md'], notes: 'n' });
  });

  it('explains stale, unknown and foreign runs', async () => {
    const client = await makeClient();
    fetchMock.mockResolvedValueOnce(respond(409, { ok: false, error: 'stale_run' }));
    expect(text(await client.callTool({ name: 'journal_complete', arguments: { run_id: 'r' } }))).toContain('already ended');
    fetchMock.mockResolvedValueOnce(respond(404, { ok: false, error: 'unknown_run' }));
    expect(text(await client.callTool({ name: 'journal_complete', arguments: { run_id: 'r' } }))).toContain('Unknown journal run');
    fetchMock.mockResolvedValueOnce(respond(403, { ok: false, error: 'wrong_agent' }));
    expect(text(await client.callTool({ name: 'journal_complete', arguments: { run_id: 'r' } }))).toContain('another agent');
  });
});
