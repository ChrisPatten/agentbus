import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerTelegramTools } from './telegram.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerTelegramTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('create_telegram_topic tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the created topic on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, topic: 'thread:abc123', message_thread_id: 42, name: 'Wanda prep' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'create_telegram_topic',
      arguments: { channel: 'telegram:group:-100123', name: 'Wanda prep' },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      topic: string;
      message_thread_id: number;
      name: string;
    };
    expect(data.topic).toBe('thread:abc123');
    expect(data.message_thread_id).toBe(42);
    expect(data.name).toBe('Wanda prep');

    const call = fetchMock.mock.calls[0]! as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://bus:4000/api/v1/adapters/telegram%3Agroup%3A-100123/topics');
    expect(JSON.parse(call[1].body)).toEqual({ name: 'Wanda prep' });

    await client.close();
  });

  it('forwards an optional context param', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, topic: 'thread:abc123', message_thread_id: 42, name: 'Wanda prep' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'create_telegram_topic',
      arguments: { channel: 'telegram:group:-100123', name: 'Wanda prep', context: 'Track Wanda birthday planning here' },
    });

    const call = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({ name: 'Wanda prep', context: 'Track Wanda birthday planning here' });

    await client.close();
  });

  it('surfaces a clear error for a DM channel', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 200,
      json: async () => ({
        ok: false,
        error: 'create_telegram_topic is group-only; "telegram" is not a Telegram group channel',
      }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'create_telegram_topic',
      arguments: { channel: 'telegram', name: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('group-only');

    await client.close();
  });

  it('surfaces the admin-rights error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'This bot lacks "Manage Topics" admin rights in this group.' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'create_telegram_topic',
      arguments: { channel: 'telegram:group:-100123', name: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Manage Topics');

    await client.close();
  });

  it('returns error when bus is unreachable (fetch throws)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = await makeClient();
    const result = await client.callTool({
      name: 'create_telegram_topic',
      arguments: { channel: 'telegram:group:-100123', name: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('Failed to create topic');

    await client.close();
  });
});
