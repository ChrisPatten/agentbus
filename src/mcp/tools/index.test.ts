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
    expect(sentBody.metadata).toEqual({ conversation_id: 'conv-abc123' });

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
    expect(sentBody.metadata).toEqual({});

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
    expect(sentBody.metadata).toEqual({});

    await client.close();
  });
});
