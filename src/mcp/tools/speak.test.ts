import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from './index.js';
import { registerSpeakTool, SPEAK_DESCRIPTION } from './speak.js';

const BUS = 'http://bus:4000';
const health: HealthState = { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 };
async function connect(register: (s: McpServer) => void) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  register(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'c', version: '0.0.1' });
  await client.connect(ct);
  return client;
}
const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const text = (r: unknown) => (((r as { content: unknown }).content as Array<{ text: string }>)[0]!).text;

describe('speak tool (E102)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterEach(() => vi.restoreAllMocks());
  const call = async (args: Record<string, unknown>) => {
    const c = await connect((s) => registerSpeakTool(s, BUS, 'peggy-pool-1'));
    const r = await c.callTool({ name: 'speak', arguments: args });
    await c.close();
    return r;
  };

  it('is registered with both tool sets and takes no device id', async () => {
    for (const reg of [(s: McpServer) => registerAllTools(s, BUS, health, 'peggy'), (s: McpServer) => registerHeadlessTools(s, BUS, 'peggy')]) {
      const c = await connect(reg);
      const tool = (await c.listTools()).tools.find((t) => t.name === 'speak')!;
      expect(tool.description).toBe(SPEAK_DESCRIPTION);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(['text', 'message_id', 'surface']);
      await c.close();
    }
  });

  it('answers a push-to-talk message, then records a quiet 🔊 message in the followed conversation', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { ok: true, status: 'spoken', text: 'Hello', echo: '🔊 Hello', surface_id: 'compact', devices: 1, interaction_message: true, follow: { channel: 'telegram:peggy', contact: 'chris' } }))
      .mockResolvedValueOnce(res(200, { ok: true, message: { id: 'm1', metadata: { conversation_id: 'c1' } } }))
      .mockResolvedValueOnce(res(200, { ok: true, id: 'rec1' }));
    const r = await call({ message_id: 'm1', text: '[warmly] Hello' });
    expect(JSON.parse(text(r))).toMatchObject({ status: 'spoken', spoken: 'Hello', recorded_message_id: 'rec1' });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({ text: '[warmly] Hello', message_id: 'm1', agent_id: 'peggy-pool-1' });
    const rec = JSON.parse((fetchMock.mock.calls[2] as [string, { body: string }])[1].body);
    expect(rec).toMatchObject({ channel: 'telegram:peggy', reply_to: 'm1', sender: 'agent:peggy-pool-1', recipient: 'contact:chris', payload: { body: '🔊 Hello' }, metadata: { intercom_spoken: true, silent: true, conversation_id: 'c1' } });
  });

  it('speaks proactively with no message id: records into the surface conversation, unguarded (no reply_to or conversation_id)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { ok: true, status: 'queued', text: 'Done', echo: '🔊 Done', surface_id: 'compact', devices: 1, follow: { channel: 'telegram:peggy', topic: 'desk', contact: 'chris' } }))
      .mockResolvedValueOnce(res(200, { ok: true, id: 'rec2' }));
    const r = await call({ text: 'Done', surface: 'compact' });
    expect(JSON.parse(text(r))).toMatchObject({ status: 'queued', surface: 'compact', devices: 1, recorded_message_id: 'rec2' });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({ text: 'Done', surface: 'compact', agent_id: 'peggy-pool-1' });
    const rec = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(rec).toMatchObject({ topic: 'desk', reply_to: null, metadata: { intercom_spoken: true } });
    expect(rec.metadata).not.toHaveProperty('conversation_id');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a skip without recording anything', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { ok: true, status: 'skipped', reason: 'asleep' }));
    const r = await call({ message_id: 'm1', text: 'Hello' });
    expect(JSON.parse(text(r))).toEqual({ status: 'skipped', reason: 'asleep' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns a bus refusal into a tool error', async () => {
    fetchMock.mockResolvedValueOnce(res(400, { ok: false, error: 'not a push-to-talk message. Use reply().' }));
    const r = await call({ message_id: 'm1', text: 'Hello' }) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Use reply()');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
