import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from './index.js';
import { registerMessagingTools } from './messaging.js';

// E79 S79.3 — the share_context MCP tool.

const BUS_URL = 'http://bus:4000';
const healthState: HealthState = { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 };

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
const text = (result: unknown) => (((result as { content: unknown }).content as Array<{ text: string }>)[0]!).text;

describe('share_context tool (E79)', () => {
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

  const call = async (args: Record<string, unknown>, agentId = 'baxter') => {
    const client = await connect((s) => registerMessagingTools(s, BUS_URL, agentId));
    const result = await client.callTool({ name: 'share_context', arguments: args });
    await client.close();
    return result;
  };
  const posted = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    return { url, method: init.method, body: JSON.parse(init.body) as Record<string, unknown> };
  };

  it('posts to /api/v1/context with the sender and an external origin labelled by source', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ok: true, id: 'ctx-1' }));
    const result = await call({ to: 'contact:chris', body: 'Shipped the plan', source: 'Claude Code: baxter' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ success: true, message_id: 'ctx-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no channel resolution round trip: there is no channel
    expect(posted()).toEqual({ url: `${BUS_URL}/api/v1/context`, method: 'POST', body: {
      to: 'contact:chris', body: 'Shipped the plan', source: 'Claude Code: baxter', channel: 'app', sender: 'agent:baxter',
      origin: { kind: 'external', label: 'Claude Code: baxter' } } });
  });

  it('stamps a turn origin when run inside a turn, so the bus can reject a call from Main', async () => {
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-main');
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: 'share_context cannot be called from a turn in Main' }) });
    const result = await call({ to: 'contact:chris', body: 'x', source: 'Main' });
    expect(posted().body['origin']).toEqual({ kind: 'turn', agent_id: 'baxter', conversation_id: 'conv-main', label: 'Main' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Error: Bus rejected context: share_context cannot be called from a turn in Main');
  });

  it('requires to, body and source', async () => {
    const client = await connect((s) => registerMessagingTools(s, BUS_URL, 'baxter'));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'share_context')!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['to', 'body', 'source']));
    expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(['body', 'channel', 'source', 'to']);
    expect(tool.inputSchema.required).not.toContain('channel'); // E80: defaults to app
    for (const missing of ['to', 'body', 'source']) {
      const args: Record<string, unknown> = { to: 'contact:chris', body: 'x', source: 'y' };
      delete args[missing];
      const result = await client.callTool({ name: 'share_context', arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
  });

  it('describes what it is for and what it is not for', async () => {
    const client = await connect((s) => registerMessagingTools(s, BUS_URL, 'baxter'));
    const description = (await client.listTools()).tools.find((t) => t.name === 'share_context')!.description!;
    expect(description).toMatch(/Claude Code session/);
    expect(description).toMatch(/Nothing is shown to the user/);
    expect(description).toMatch(/Telegram DM/);
    expect(description).toMatch(/Do not use it to notify the operator, ask a question/);
    await client.close();
  });

  it('maps a rejection to a tool error, preferring the journal-gate reason', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: 'Context is too long: limit is 4000. Summarize it' }) });
    const tooLong = await call({ to: 'contact:chris', body: 'x', source: 'y' });
    expect(tooLong.isError).toBe(true);
    expect(text(tooLong)).toBe('Error: Bus rejected context: Context is too long: limit is 4000. Summarize it');

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: 'journal_run_in_progress', reason: 'Outbound messages are blocked' }) });
    const gated = await call({ to: 'contact:chris', body: 'x', source: 'y' });
    expect(text(gated)).toBe('Error: Bus rejected context: Outbound messages are blocked');
  });

  it('maps a network failure to a tool error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const result = await call({ to: 'contact:chris', body: 'x', source: 'y' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Failed to share context');
    expect(text(result)).toContain('ECONNREFUSED');
  });

  it('is registered in both the full and the headless tool sets', async () => {
    for (const register of [
      (s: McpServer) => registerAllTools(s, BUS_URL, healthState, 'baxter'),
      (s: McpServer) => registerHeadlessTools(s, BUS_URL, 'baxter'),
    ]) {
      const client = await connect(register);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('share_context');
      expect(names).toContain('send_message');
      await client.close();
    }
  });
});
