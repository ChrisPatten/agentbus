import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerReactionTools } from './reactions.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerReactionTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('react_to_message tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success on 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, success: true, emoji: '👍', message_id: 'msg-1' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'msg-1', emoji: '👍' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      success: boolean;
      emoji: string;
    };
    expect(data.success).toBe(true);
    expect(data.emoji).toBe('👍');

    await client.close();
  });

  it('returns error response for 404 (message not found)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'Message not found' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'no-such-msg', emoji: '❤️' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('not found');

    await client.close();
  });

  it('returns success:false (not isError) for 400 (unsupported channel)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        success: false,
        reason: 'Reactions not supported on channel: claude-code-channels',
      }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'msg-1', emoji: '❓' },
    });

    // 400 from bus = capability error, not isError — structured success:false response
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      success: boolean;
      reason: string;
    };
    expect(data.success).toBe(false);
    expect(data.reason).toContain('not supported');

    await client.close();
  });

  it('returns error for 502 (adapter threw)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ ok: false, error: 'Telegram API timeout' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'msg-1', emoji: '😂' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Adapter error');

    await client.close();
  });

  it('accepts any non-empty emoji string (no enum constraint)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, success: true }), { status: 200 }),
    );

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'msg-1', emoji: '🚀' },
    });
    expect(result.isError).toBeFalsy();

    await client.close();
  });

  it('returns error when bus is unreachable (fetch throws)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = await makeClient();
    const result = await client.callTool({
      name: 'react_to_message',
      arguments: { message_id: 'msg-1', emoji: '👍' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Failed to send reaction');

    await client.close();
  });
});
