import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerMessagingTools, registerEmailTool } from './messaging.js';
import { registerAllTools } from './index.js';
import { isForeignOrigin, readOrigin } from '../../core/origin.js';

// E69 S69.1 — outbound origin stamping on send_message, reply and send_email.

const BUS_URL = 'http://bus:4000';

async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const ok = (json: unknown) => ({ ok: true, json: async () => json });

function postedMetadata(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const post = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')!;
  return (JSON.parse((post[1] as { body: string }).body) as { metadata: Record<string, unknown> }).metadata;
}

describe('origin stamping (E69 S69.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', '');
    vi.stubEnv('AGENTBUS_SOURCE_LABEL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function sendMessage(args: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValueOnce(ok({ ok: true, exists: true }));
    fetchMock.mockResolvedValueOnce(ok({ ok: true, id: 'm1' }));
    const client = await connect((s) => registerMessagingTools(s, BUS_URL, 'baxter'));
    const result = await client.callTool({
      name: 'send_message',
      arguments: { to: 'contact:chris', channel: 'app', body: 'hi', ...args },
    });
    await client.close();
    expect(result.isError).toBeFalsy();
    return postedMetadata(fetchMock);
  }

  it('stamps a turn origin when the per-turn conversation env var is set (own-turn send)', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-main');
    const metadata = await sendMessage();
    expect(metadata['origin']).toEqual({ kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-main' });
    expect(isForeignOrigin(readOrigin(metadata), 'conv-main')).toBe(false);
  });

  it('a send from a turn in another conversation is foreign to Main', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-telegram');
    const metadata = await sendMessage();
    expect(isForeignOrigin(readOrigin(metadata), 'conv-main')).toBe(true);
  });

  it('a turn origin carries a label only when one is given', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-telegram');
    expect((await sendMessage({ source: 'Travel check' }))['origin']).toEqual({
      kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-telegram', label: 'Travel check',
    });
  });

  it('stamps an external origin with no env (a routine or interactive session)', async () => {
    const metadata = await sendMessage();
    expect(metadata['origin']).toEqual({ kind: 'external', label: 'another agent session' });
    expect(isForeignOrigin(readOrigin(metadata), 'conv-main')).toBe(true);
  });

  it('replaces a caller-supplied origin and keeps other metadata', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-main');
    const metadata = await sendMessage({
      metadata: { thread: 'x', origin: { kind: 'turn', agent_id: 'evil', conversation_id: 'conv-other' } },
    });
    expect(metadata['thread']).toBe('x');
    expect(metadata['origin']).toMatchObject({ kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-main' });
  });

  it('a spoofed turn origin from an external caller is stripped to external', async () => {
    const metadata = await sendMessage({
      metadata: { origin: { kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-main' } },
    });
    expect(metadata['origin']).toEqual({ kind: 'external', label: 'another agent session' });
  });

  it('label precedence: source param, then AGENTBUS_SOURCE_LABEL, then the default', async () => {
    vi.stubEnv('AGENTBUS_SOURCE_LABEL', 'Baxter routines');
    expect((await sendMessage({ source: 'Ambient scan' }))['origin']).toEqual({ kind: 'external', label: 'Ambient scan' });
    fetchMock.mockClear();
    expect((await sendMessage())['origin']).toEqual({ kind: 'external', label: 'Baxter routines' });
    fetchMock.mockClear();
    vi.stubEnv('AGENTBUS_SOURCE_LABEL', '  ');
    expect((await sendMessage({ source: '  ' }))['origin']).toEqual({ kind: 'external', label: 'another agent session' });
  });

  it('reply stamps the origin alongside the forwarded conversation_id', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-main');
    fetchMock.mockResolvedValueOnce(ok({
      ok: true,
      message: {
        id: 'orig', timestamp: new Date().toISOString(), channel: 'app', topic: 'general',
        sender: 'contact:chris', recipient: 'agent:baxter', reply_to: null, priority: 'normal',
        payload: { type: 'text', body: 'hi' }, metadata: { conversation_id: 'conv-main', origin: { kind: 'external', label: 'x' } },
      },
    }));
    fetchMock.mockResolvedValueOnce(ok({ ok: true, id: 'r1' }));
    const client = await connect((s) => registerAllTools(s, BUS_URL,
      { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 }, 'baxter'));
    const result = await client.callTool({ name: 'reply', arguments: { message_id: 'orig', body: 'yo' } });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(postedMetadata(fetchMock)).toEqual({
      conversation_id: 'conv-main',
      origin: { kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-main' },
    });
  });

  it('send_email stamps the origin', async () => {
    vi.stubEnv('AGENTBUS_SOURCE_LABEL', 'Inbox digest');
    fetchMock.mockResolvedValueOnce(ok({ ok: true, id: 'e1' }));
    const client = await connect((s) => registerEmailTool(s, BUS_URL, 'baxter', {
      channel: 'email', allowlist: ['chris@example.com'], addressToContact: { 'chris@example.com': 'chris' },
    }));
    const result = await client.callTool({ name: 'send_email', arguments: { body: 'hello' } });
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(postedMetadata(fetchMock)['origin']).toEqual({ kind: 'external', label: 'Inbox digest' });
  });
});

describe('readOrigin / isForeignOrigin (E69)', () => {
  it('treats unstamped and malformed metadata as not foreign', () => {
    expect(readOrigin({})).toBeNull();
    expect(readOrigin({ origin: 'external' })).toBeNull();
    expect(readOrigin({ origin: { kind: 'turn' } })).toBeNull();
    expect(isForeignOrigin(null, 'c')).toBe(false);
  });

  it('defaults a missing external label', () => {
    expect(readOrigin({ origin: { kind: 'external' } })).toEqual({ kind: 'external', label: 'another agent session' });
  });
});
