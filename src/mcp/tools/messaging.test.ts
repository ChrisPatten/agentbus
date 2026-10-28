import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerMessagingTools } from './messaging.js';

const BUS_URL = 'http://bus:4000';

async function makeClient(agentId = 'claude') {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMessagingTools(server, BUS_URL, agentId);
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
    // First call: GET /api/v1/adapters/resolve (channel validation)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
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
      json: async () => ({ ok: true, exists: false }),
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
      json: async () => ({ ok: true, exists: true }),
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
      json: async () => ({ ok: true, exists: true }),
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

  it('defaults topic to "general" when omitted', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-topic-default' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { topic: string };
    expect(sentBody.topic).toBe('general');

    await client.close();
  });

  it('sends a topicless app message to Main', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, exists: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'app-main-msg' }) });
    const client = await makeClient();
    const result = await client.callTool({ name: 'send_message', arguments: {
      to: 'contact:chris', channel: 'app', body: 'Ready',
    } });
    expect(result.isError).toBeFalsy();
    const posted = JSON.parse((fetchMock.mock.calls[1]![1] as {body:string}).body) as {topic:string};
    expect(posted.topic).toBe('general');
    await client.close();
  });

  it('passes an explicit topic (e.g. a Telegram forum thread) through to the bus unmodified', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-topic-thread' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'send_message',
      arguments: {
        to: 'contact:chris',
        channel: 'telegram:peggy:group:-1003977797157',
        body: 'moved here',
        topic: 'thread:040db5054be44ff4',
      },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { topic: string };
    expect(sentBody.topic).toBe('thread:040db5054be44ff4');

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
      json: async () => ({ ok: true, exists: true }),
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
    expect(sentBody.metadata).toEqual({ thread: 'abc', pinned: true, origin: { kind: 'external', label: 'another agent session' } });

    await client.close();
  });

  it('includes reply_to in POST body when provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
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

  it('stamps sender from the registered agentId ("claude") rather than a hardcoded literal', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-sender-claude' }),
    });

    const client = await makeClient('claude');
    await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { sender: string };
    expect(sentBody.sender).toBe('agent:claude');

    await client.close();
  });

  it('stamps sender from a pool pane agentId, not the old hardcoded "agent:claude"', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, exists: true }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'msg-sender-pool' }),
    });

    const client = await makeClient('peggy-pool-3');
    await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel: 'telegram', body: 'hi' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { sender: string };
    expect(sentBody.sender).toBe('agent:peggy-pool-3');
    expect(sentBody.sender).not.toBe('agent:claude');

    await client.close();
  });
});

describe('send_message tool — choices (E74)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, exists: true }) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'msg-1' }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function send(channel: string, choices: unknown) {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:alice', channel, body: 'Which?', choices },
    });
    await client.close();
    return result;
  }

  it('yields metadata.choices of length 3 for a telegram send', async () => {
    const result = await send('telegram', ['A', 'B', 'C']);
    expect(result.isError).toBeFalsy();
    const sent = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body) as {
      metadata: { choices: string[] };
      payload: { body: string };
    };
    expect(sent.metadata.choices).toEqual(['A', 'B', 'C']);
    expect(sent.payload.body).toBe('Which?');
  });

  it('appends a numbered list for a non-telegram channel', async () => {
    await send('email', ['A', 'B']);
    const sent = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body) as {
      metadata: Record<string, unknown>;
      payload: { body: string };
    };
    expect(sent.payload.body).toBe('Which?\n\n1. A\n2. B');
    expect(sent.metadata).not.toHaveProperty('choices');
  });

  it('rejects 9 choices and an empty label without sending', async () => {
    const nine = await send('telegram', Array.from({ length: 9 }, (_, i) => `L${i}`));
    expect(nine.isError).toBe(true);
    expect(((nine.content as Array<{ text: string }>)[0]!).text).toMatch(/at most 8/);
    const empty = await send('telegram', ['A', '']);
    expect(empty.isError).toBe(true);
    expect(((empty.content as Array<{ text: string }>)[0]!).text).toMatch(/must not be empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
