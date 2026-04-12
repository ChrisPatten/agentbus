import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerMessagingTools } from './messaging.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMessagingTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('send_message tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a message when channel is valid', async () => {
    // First call: GET /api/v1/adapters (channel validation)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        adapters: [{ id: 'telegram', channels: ['telegram'] }],
      }),
    });
    // Second call: POST /api/v1/messages
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-123' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'Hello!' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      success: boolean;
      message_id: string;
    };
    expect(data.success).toBe(true);
    expect(data.message_id).toBe('msg-123');

    await client.close();
  });

  it('returns error for unknown channel', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, adapters: [] }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'nonexistent', body: 'hi' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Unknown channel');

    await client.close();
  });

  it('passes priority: high through to bus unmodified', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, adapters: [{ id: 'telegram', channels: ['telegram'] }] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-456' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi', priority: 'high' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { priority: string };
    expect(sentBody.priority).toBe('high');

    await client.close();
  });

  it('passes priority: urgent through to bus unmodified', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, adapters: [{ id: 'telegram', channels: ['telegram'] }] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-789' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'urgent!', priority: 'urgent' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { priority: string };
    expect(sentBody.priority).toBe('urgent');

    await client.close();
  });

  it('rejects unknown priority value', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi', priority: 'low' },
    });

    expect(result.isError).toBe(true);

    await client.close();
  });

  it('serializes metadata into POST body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, adapters: [{ id: 'telegram', channels: ['telegram'] }] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-meta' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'send_message',
      arguments: {
        to: 'contact:alice',
        channel: 'telegram',
        body: 'hi',
        metadata: { thread: 'abc', pinned: true },
      },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { metadata: Record<string, unknown> };
    expect(sentBody.metadata).toEqual({ thread: 'abc', pinned: true });

    await client.close();
  });

  it('includes reply_to in POST body when provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, adapters: [{ id: 'telegram', channels: ['telegram'] }] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-reply' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi', reply_to: 'msg-orig' },
    });

    expect(result.isError).toBeFalsy();
    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { reply_to: string };
    expect(sentBody.reply_to).toBe('msg-orig');

    await client.close();
  });
});
