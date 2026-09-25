import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerScheduleTools } from './scheduling.js';

const BUS_URL = 'http://bus:4000';

function makeServer() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerScheduleTools(server, BUS_URL);
  return server;
}

async function makeClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('schedule_message tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes model through to the create-schedule request body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'sched-1', fire_at: '2026-09-26T08:00:00.000Z', topic: 'sched:email-watch' }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({
      name: 'schedule_message',
      arguments: {
        type: 'cron',
        prompt: 'Check email',
        channel: 'telegram',
        sender: 'system:scheduler',
        cron_expr: '*/15 * * * *',
        label: 'Email Watch',
        model: 'haiku',
      },
    });
    expect(result.isError).toBeFalsy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { model?: string; topic?: string };
    expect(body.model).toBe('haiku');

    const content = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      topic: string;
    };
    expect(content.topic).toBe('sched:email-watch');

    await client.close();
  });

  it('omits topic from the request body when not provided, leaving the default to the server', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ ok: true, id: 'sched-2', fire_at: '2026-09-26T08:00:00.000Z', topic: 'general' }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    await client.callTool({
      name: 'schedule_message',
      arguments: {
        type: 'once',
        prompt: 'Reminder',
        channel: 'telegram',
        sender: 'contact:chris',
        fire_at: '2026-09-26T08:00:00.000Z',
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.topic).toBeUndefined();
    expect(body.model).toBeUndefined();

    await client.close();
  });
});

describe('list_schedules tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces model and topic on each returned schedule', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        count: 1,
        schedules: [
          {
            id: 'sched-1',
            type: 'cron',
            cron_expr: '*/15 * * * *',
            timezone: 'UTC',
            fire_at: '2026-09-26T08:00:00.000Z',
            channel: 'telegram',
            sender: 'system:scheduler',
            payload_body: 'Check email',
            topic: 'sched:email-watch',
            priority: 'normal',
            label: 'Email Watch',
            model: 'haiku',
            created_by: 'agent',
            fire_count: 3,
            max_fires: null,
            stale_after_ms: null,
            status: 'active',
            last_fired_at: null,
          },
        ],
      }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({ name: 'list_schedules', arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as {
      schedules: Array<{ model: string | null; topic: string }>;
    };
    expect(content.schedules[0]!.model).toBe('haiku');
    expect(content.schedules[0]!.topic).toBe('sched:email-watch');

    await client.close();
  });
});

describe('update_schedule tool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCHes only the provided fields', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        schedule: { id: 'sched-1', model: 'haiku', topic: 'sched:email-watch' },
      }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({
      name: 'update_schedule',
      arguments: { id: 'sched-1', model: 'haiku' },
    });
    expect(result.isError).toBeFalsy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BUS_URL}/api/v1/schedules/sched-1`);
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: 'haiku' });

    await client.close();
  });

  it('sends model: null to clear a job model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, schedule: { id: 'sched-1', model: null } }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    await client.callTool({ name: 'update_schedule', arguments: { id: 'sched-1', model: null } });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: null });

    await client.close();
  });

  it('returns an error when the bus rejects the update', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'Schedule not found' }),
    });

    const server = makeServer();
    const client = await makeClient(server);

    const result = await client.callTool({
      name: 'update_schedule',
      arguments: { id: 'ghost', label: 'X' },
    });
    expect(result.isError).toBe(true);

    await client.close();
  });
});
