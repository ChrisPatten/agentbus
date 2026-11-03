import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from './index.js';
import { registerSurfaceTools } from './surface.js';

const BUS_URL = 'http://bus:4000';
const healthState: HealthState = { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 };
const NAMES = ['list_surfaces', 'surface_publish_event', 'surface_remove_event', 'surface_set_slot', 'surface_clear_slot', 'surface_write_widget', 'surface_remove_widget', 'clear_answer_needed'];

async function connect(register: (s: McpServer) => void) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  register(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'c', version: '0.0.1' });
  await client.connect(ct);
  return client;
}
const text = (r: unknown) => (((r as { content: unknown }).content as Array<{ text: string }>)[0]!).text;
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe('surface tools (E96)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock as unknown as typeof fetch; vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const c = await connect((s) => registerSurfaceTools(s, BUS_URL, 'peggy-pool-1'));
    const r = await c.callTool({ name, arguments: args });
    await c.close();
    return r;
  };
  const sent = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, { method: string; body?: string }];
    return { url, method: init.method, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
  };

  it('are registered with both tool sets', async () => {
    for (const reg of [(s: McpServer) => registerAllTools(s, BUS_URL, healthState, 'peggy'), (s: McpServer) => registerHeadlessTools(s, BUS_URL, 'peggy')]) {
      const c = await connect(reg);
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(NAMES));
      await c.close();
    }
  });

  it('describes the bounds and the confirm-draft rule', async () => {
    const c = await connect((s) => registerSurfaceTools(s, BUS_URL, 'peggy'));
    const tools = (await c.listTools()).tools;
    await c.close();
    const ev = tools.find((t) => t.name === 'surface_publish_event')!;
    expect(ev.description).toMatch(/title 80 characters/);
    expect(ev.description).toMatch(/confirm\.draft/);
    expect(ev.description).toMatch(/14 days/);
    expect(Object.keys((ev.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['surface', 'id', 'title', 'body', 'level', 'at', 'end', 'expires_at', 'actions']));
    expect(tools.find((t) => t.name === 'surface_set_slot')!.description).toMatch(/24 hours/);
    expect(tools.find((t) => t.name === 'surface_write_widget')!.description).toMatch(/4096 bytes/);
  });

  it('publish_event PUTs the event with the agent id', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, surface: 'compact', id: 'train', created: true, rev: 3 }));
    const r = await call('surface_publish_event', { surface: 'compact', id: 'train', title: 'Train in 10 min', actions: [{ id: 'here', label: "I'm here", run: { body: 'tapped' } }] });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ surface: 'compact', id: 'train', created: true, rev: 3 });
    expect(sent()).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/compact/events/train`, method: 'PUT', body: {
      title: 'Train in 10 min', actions: [{ id: 'here', label: "I'm here", run: { body: 'tapped' } }], agent_id: 'peggy-pool-1',
    } });
  });

  it('returns the bus error verbatim', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: 'title is 112 characters; the limit is 80' }));
    const r = await call('surface_publish_event', { surface: 'compact', id: 'x', title: 'x'.repeat(112) });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Error: title is 112 characters; the limit is 80');
  });

  it('removes, slots and widgets hit their routes', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await call('surface_remove_event', { surface: 'compact', id: 'train' });
    await call('surface_set_slot', { surface: 'compact', slot: 'status', text: 'Out', until: '2026-11-03T13:00:00Z' });
    await call('surface_clear_slot', { surface: 'compact', slot: 'status' });
    await call('surface_write_widget', { surface: 'compact', id: 'wx', type: 'weather', data: { t: 1 } });
    await call('surface_remove_widget', { surface: 'compact', id: 'wx' });
    await call('list_surfaces', {});
    expect(sent(0)).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/compact/events/train?agent_id=peggy-pool-1`, method: 'DELETE', body: undefined });
    expect(sent(1)).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/compact/slots/status`, method: 'PUT', body: { text: 'Out', until: '2026-11-03T13:00:00Z', agent_id: 'peggy-pool-1' } });
    expect(sent(2).url).toBe(`${BUS_URL}/api/v1/surface-publish/compact/slots/status?agent_id=peggy-pool-1`);
    expect(sent(3)).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/compact/widgets/wx`, method: 'PUT', body: { type: 'weather', data: { t: 1 }, agent_id: 'peggy-pool-1' } });
    expect(sent(4)).toMatchObject({ url: `${BUS_URL}/api/v1/surface-publish/compact/widgets/wx?agent_id=peggy-pool-1`, method: 'DELETE' });
    expect(sent(5)).toMatchObject({ url: `${BUS_URL}/api/v1/surface-publish/surfaces?agent_id=peggy-pool-1`, method: 'GET' });
  });

  it('clear_answer_needed uses the given target, else the turn conversation', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, cleared: true }));
    await call('clear_answer_needed', { channel: 'telegram:peggy', contact: 'contact:chris' });
    expect(sent(0).body).toEqual({ channel: 'telegram:peggy', contact: 'contact:chris', agent_id: 'peggy-pool-1' });
    const none = await call('clear_answer_needed', {});
    expect(none.isError).toBe(true);
    vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', 'conv-9');
    await call('clear_answer_needed', {});
    expect(sent(1)).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/answer-needed/clear`, method: 'POST', body: { conversation_id: 'conv-9', agent_id: 'peggy-pool-1' } });
  });
});
