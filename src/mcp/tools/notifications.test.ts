import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from './index.js';
import { registerNotificationTools } from './notifications.js';

const BUS_URL = 'http://bus:4000';
const healthState: HealthState = { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 };
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

describe('notification tools (E89)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock as unknown as typeof fetch; vi.stubEnv('AGENTBUS_SOURCE_LABEL', ''); vi.stubEnv('AGENTBUS_TURN_CONVERSATION_ID', ''); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const c = await connect((s) => registerNotificationTools(s, BUS_URL, 'peggy-pool-1'));
    const r = await c.callTool({ name, arguments: args });
    await c.close();
    return r;
  };

  it('are registered with both tool sets', async () => {
    for (const reg of [(s: McpServer) => registerAllTools(s, BUS_URL, healthState, 'peggy'), (s: McpServer) => registerHeadlessTools(s, BUS_URL, 'peggy')]) {
      const c = await connect(reg);
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['notify', 'update_notification', 'list_notifications']));
      await c.close();
    }
  });

  it('notify posts to the internal route with a default source and returns id, key, state', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, id: 'n1', key: 'dentist', state: 'active', created: true }));
    const r = await call('notify', { title: 'Leave in 20 min', key: 'dentist', level: 'urgent', actions: [{ label: 'Leaving now' }] });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ id: 'n1', key: 'dentist', state: 'active' });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(`${BUS_URL}/api/v1/internal/notifications`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ title: 'Leave in 20 min', key: 'dentist', level: 'urgent', source: expect.any(String) });
  });

  it('notify uses an explicit source and AGENTBUS_SOURCE_LABEL when set', async () => {
    fetchMock.mockResolvedValue(json(201, { ok: true, id: 'n1', key: null, state: 'active' }));
    await call('notify', { title: 't', source: 'Mail Watcher' });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).source).toBe('Mail Watcher');
    vi.stubEnv('AGENTBUS_SOURCE_LABEL', 'Peggy: Intercom');
    await call('notify', { title: 't' });
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body).source).toBe('Peggy: Intercom');
  });

  it('surfaces a bus rejection as a tool error', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: 'invalid_body', detail: 'title: required' }));
    const r = await call('notify', { title: 't' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('title: required');
    fetchMock.mockResolvedValueOnce(json(404, {}));
    expect(text(await call('notify', { title: 't' }))).toContain('not enabled');
  });

  it('update_notification patches by id or by key and needs one of them', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, id: 'n1', key: 'k', state: 'resolved' }));
    expect(JSON.parse(text(await call('update_notification', { id: 'n1', state: 'resolved' })))).toEqual({ id: 'n1', key: 'k', state: 'resolved' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BUS_URL}/api/v1/internal/notifications/n1`);
    await call('update_notification', { key: 'a b', title: 'new' });
    const [url, init] = fetchMock.mock.calls[1] as [string, { method: string; body: string }];
    expect(url).toBe(`${BUS_URL}/api/v1/internal/notifications?key=a%20b`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: 'new' });
    expect((await call('update_notification', { state: 'resolved' })).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('list_notifications defaults to open and passes state and limit', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true, notifications: [{ id: 'n1' }] }));
    expect(JSON.parse(text(await call('list_notifications', {})))).toEqual({ notifications: [{ id: 'n1' }] });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BUS_URL}/api/v1/internal/notifications?state=open`);
    await call('list_notifications', { state: 'all', limit: 5 });
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BUS_URL}/api/v1/internal/notifications?state=all&limit=5`);
  });
});
