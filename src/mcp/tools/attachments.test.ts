import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAttachmentTools } from './attachments.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerAttachmentTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('fetch_attachment tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the attachment on 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        attachment: { id: 'a1', local_path: '/tmp/x.png', mime_type: 'image/png', original_filename: 'x.png' },
      }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'fetch_attachment', arguments: { id: 'a1' } });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      local_path: string;
    };
    expect(data.local_path).toBe('/tmp/x.png');
    await client.close();
  });

  it('returns an error for 404 (missing or expired)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'Attachment not found: a1' }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'fetch_attachment', arguments: { id: 'a1' } });

    expect(result.isError).toBe(true);
    await client.close();
  });
});
