import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { HealthState } from './index.js';
import { registerAllTools } from './index.js';

const BUS_URL = 'http://bus:4000';

const healthState: HealthState = {
  status: 'healthy',
  busReachable: true,
  lastPollAt: null,
  consecutiveFailures: 0,
};

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerAllTools(server, BUS_URL, healthState, 'claude');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

/** A minimal well-formed MessageEnvelope for the `reply` tool's GET fetch. */
function makeOriginalEnvelope(metadata: Record<string, unknown> = {}) {
  return {
    id: 'orig-msg-1',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:alice',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'hi there' },
    metadata,
  };
}

describe('reply tool — conversation_id forwarding (E48 S48.6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards metadata.conversation_id from the original message when present', async () => {
    // First call: GET /api/v1/messages/:id (fetch original)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: makeOriginalEnvelope({ conversation_id: 'conv-abc123' }) }),
    });
    // Second call: POST /api/v1/messages (send reply)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'reply-msg-1' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'reply',
      arguments: { message_id: 'orig-msg-1', body: 'here is my reply' },
    });

    expect(result.isError).toBeFalsy();
    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { metadata: Record<string, unknown> };
    expect(sentBody.metadata).toEqual({ conversation_id: 'conv-abc123', origin: { kind: 'external', label: 'another agent session' } });

    await client.close();
  });

  it('sends metadata: {} when the original has no conversation_id (unchanged fallback behavior)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: makeOriginalEnvelope() }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'reply-msg-2' }),
    });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'reply',
      arguments: { message_id: 'orig-msg-1', body: 'here is my reply' },
    });

    expect(result.isError).toBeFalsy();
    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { metadata: Record<string, unknown> };
    expect(sentBody.metadata).toEqual({ origin: { kind: 'external', label: 'another agent session' } });

    await client.close();
  });

  it('sends metadata: {} when the original conversation_id is not a string', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: makeOriginalEnvelope({ conversation_id: 12345 }) }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, id: 'reply-msg-3' }),
    });

    const client = await makeClient();
    await client.callTool({
      name: 'reply',
      arguments: { message_id: 'orig-msg-1', body: 'here is my reply' },
    });

    const postCall = fetchMock.mock.calls[1]! as [string, { body: string }];
    const sentBody = JSON.parse(postCall[1].body) as { metadata: Record<string, unknown> };
    expect(sentBody.metadata).toEqual({ origin: { kind: 'external', label: 'another agent session' } });

    await client.close();
  });
});

describe('reply tool — choices (E74)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function queueReply(channel: string) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: { ...makeOriginalEnvelope({ conversation_id: 'conv-1' }), channel } }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'reply-1' }) });
  }

  it('carries 3 choices as metadata.choices on telegram, alongside conversation_id', async () => {
    queueReply('telegram:peggy');
    const client = await makeClient();
    const result = await client.callTool({
      name: 'reply',
      arguments: { message_id: 'orig-msg-1', body: 'Which?', choices: ['A', 'B', 'C'] },
    });
    expect(result.isError).toBeFalsy();
    const sent = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body) as {
      metadata: Record<string, unknown>;
    };
    expect(sent.metadata).toMatchObject({ conversation_id: 'conv-1', choices: ['A', 'B', 'C'] });
    await client.close();
  });

  it('appends a numbered list on a non-telegram channel', async () => {
    queueReply('email');
    const client = await makeClient();
    await client.callTool({ name: 'reply', arguments: { message_id: 'orig-msg-1', body: 'Which?', choices: ['A', 'B'] } });
    const sent = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body) as {
      payload: { body: string };
      metadata: Record<string, unknown>;
    };
    expect(sent.payload.body).toBe('Which?\n\n1. A\n2. B');
    expect(sent.metadata).toMatchObject({ conversation_id: 'conv-1' });
    expect(sent.metadata).not.toHaveProperty('choices');
    await client.close();
  });

  it('rejects 9 choices before any fetch', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'reply',
      arguments: { message_id: 'orig-msg-1', body: 'Which?', choices: Array.from({ length: 9 }, (_, i) => `L${i}`) },
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
  });
});
