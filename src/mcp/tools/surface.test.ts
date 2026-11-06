import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerAllTools, registerHeadlessTools, type HealthState } from './index.js';
import { registerSurfaceTools } from './surface.js';

const BUS_URL = 'http://bus:4000';
const healthState: HealthState = { status: 'healthy', busReachable: true, lastPollAt: null, consecutiveFailures: 0 };
const NAMES = ['list_surfaces', 'surface_publish_event', 'surface_remove_event', 'surface_set_slot', 'surface_clear_slot', 'surface_write_widget', 'surface_remove_widget', 'surface_set_face', 'surface_upload_asset', 'clear_answer_needed'];

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
  it('E100: publish_event passes weight, consequence, changed and action kind; remove_event passes reason', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const fields = {
      weight: 'urgent', consequence: 'Misses your 7:15 transfer', changed: { field: 'start', old: '6:42', new: '6:58' },
      actions: [{ id: 'route', label: 'New route', kind: 'hold', run: { body: 'r' } }],
    };
    await call('surface_publish_event', { surface: 'compact', id: 'train', title: 'Train delayed', ...fields });
    expect(sent(0).body).toMatchObject({ title: 'Train delayed', ...fields });
    await call('surface_remove_event', { surface: 'compact', id: 'train', reason: 'cleared' });
    expect(sent(1)).toEqual({ url: `${BUS_URL}/api/v1/surface-publish/compact/events/train?agent_id=peggy-pool-1&reason=cleared`, method: 'DELETE', body: undefined });
    const bad = await call('surface_remove_event', { surface: 'compact', id: 'train', reason: 'deleted' });
    expect(bad.isError).toBe(true);
    const c = await connect((s) => registerSurfaceTools(s, BUS_URL, 'peggy'));
    const tools = (await c.listTools()).tools;
    await c.close();
    const ev = tools.find((t) => t.name === 'surface_publish_event')!;
    expect(Object.keys((ev.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['weight', 'consequence', 'changed']));
    expect(ev.description).toMatch(/Urgent only: consequence \(at most 60 characters/);
    expect(ev.description).toMatch(/kind "tap" on a button that sends is refused/);
    expect(Object.keys((tools.find((t) => t.name === 'surface_remove_event')!.inputSchema as { properties: object }).properties)).toEqual(['surface', 'id', 'reason']);
  });

  it('publish_event passes the ring fields through and documents them', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, id: 'dentist' }));
    const fields = {
      at: '2026-11-05T15:00:00Z', end: '2026-11-05T16:00:00Z', layer: 'overlap', color: 'orange', travel: { minutes: 20, mode: 'drive' },
      detail: { description: 'Crown', location: '1 Main St', image: 'a'.repeat(64) }, opens: 'conversation', conversation_id: 'abc',
    };
    await call('surface_publish_event', { surface: 'compact', id: 'dentist', title: 'Dentist', ...fields });
    expect(sent().body).toMatchObject({ title: 'Dentist', ...fields });
    const c = await connect((s) => registerSurfaceTools(s, BUS_URL, 'peggy'));
    const ev = (await c.listTools()).tools.find((t) => t.name === 'surface_publish_event')!;
    await c.close();
    expect(ev.description).toMatch(/ring/i);
    expect(ev.description).toMatch(/description 600, location 120/);
    expect(Object.keys((ev.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['layer', 'color', 'travel', 'detail', 'opens', 'conversation_id']));
  });

  it('set_slot sends lines, widgets and a primary action; set_face PUTs the layout', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await call('surface_set_slot', { surface: 'compact', slot: 'context', lines: ['a', 'b'], until: '2026-11-03T20:00:00Z' });
    expect(sent(0)).toMatchObject({ url: `${BUS_URL}/api/v1/surface-publish/compact/slots/context`, method: 'PUT', body: { lines: ['a', 'b'] } });
    await call('surface_set_slot', { surface: 'compact', slot: 'context', widgets: ['w1'], until: '2026-11-03T20:00:00Z' });
    expect(sent(1).body).toMatchObject({ widgets: ['w1'] });
    await call('surface_set_slot', { surface: 'compact', slot: 'primary', text: 'Leave now', until: '2026-11-03T20:00:00Z', action: { id: 'go', label: 'Go', run: { body: 'tapped' } } });
    expect(sent(2).body).toMatchObject({ action: { id: 'go', label: 'Go', run: { body: 'tapped' } } });
    await call('surface_set_face', { surface: 'compact', id: 'day', layout: { slots: { event_ring: true, context: 'lines' } } });
    expect(sent(3)).toMatchObject({ url: `${BUS_URL}/api/v1/surface-publish/compact/faces/day`, method: 'PUT', body: { layout: { slots: { event_ring: true, context: 'lines' } }, agent_id: 'peggy-pool-1' } });
  });

  it('upload_asset POSTs the raw bytes with the content type, from base64 or from a file', async () => {
    fetchMock.mockResolvedValue(json(201, { ok: true, hash: 'h', reference: 'h' }));
    const r = await call('surface_upload_asset', { data_base64: Buffer.from('png bytes').toString('base64'), content_type: 'image/png' });
    expect(JSON.parse(text(r))).toEqual({ hash: 'h', reference: 'h' });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: Uint8Array }];
    expect(url).toBe(`${BUS_URL}/api/v1/surface-publish/assets?agent_id=peggy-pool-1`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('image/png');
    expect(Buffer.from(init.body).toString()).toBe('png bytes');

    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'asset-')), 'qr.svg');
    writeFileSync(file, '<svg></svg>');
    await call('surface_upload_asset', { path: file });
    const second = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(second[1].headers['Content-Type']).toBe('image/svg+xml');
  });

  it('upload_asset needs a source and a known type, and returns the bus error', async () => {
    expect((await call('surface_upload_asset', {})).isError).toBe(true);
    expect((await call('surface_upload_asset', { path: '/nonexistent/file.xyz', content_type: undefined })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(400, { ok: false, error: 'the file is not a PNG (bad signature)' }));
    const r = await call('surface_upload_asset', { data_base64: 'aGk=', content_type: 'image/png' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Error: the file is not a PNG (bad signature)');
  });
});
