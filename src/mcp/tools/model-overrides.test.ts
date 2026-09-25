/**
 * Tests for the model override MCP tools (E53 S53.1): set/get/list/delete
 * _model_override, plus the deprecated *_headless_model aliases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerModelOverrideTools } from './model-overrides.js';

const BUS_URL = 'http://bus:4000';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerModelOverrideTools(server, BUS_URL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as unknown;
}

describe('model override tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('set_model_override', () => {
    it('POSTs model and agent_id, and reports the resolved scope', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          id: 1,
          override: { id: 1, agent_id: 'agent:peggy', model: 'sonnet', created_at: 't', updated_at: 't' },
        }),
      });

      const client = await makeClient();
      const result = await client.callTool({
        name: 'set_model_override',
        arguments: { model: 'sonnet', agent_id: 'agent:peggy' },
      });

      expect(result.isError).toBeFalsy();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${BUS_URL}/api/v1/model-overrides`);
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ model: 'sonnet', agent_id: 'agent:peggy' });
      const data = parseResult(result) as { ok: boolean; scope: string; model: string };
      expect(data.scope).toBe('agent=agent:peggy');
      expect(data.model).toBe('sonnet');
      await client.close();
    });

    it('sets a global override when agent_id is omitted', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ ok: true, id: 2, override: { id: 2, agent_id: null, model: 'opus', created_at: 't', updated_at: 't' } }),
      });

      const client = await makeClient();
      const result = await client.callTool({ name: 'set_model_override', arguments: { model: 'opus' } });
      const data = parseResult(result) as { scope: string };
      expect(data.scope).toBe('global');
      await client.close();
    });

    it('surfaces a server error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: 'model is required and must be a non-empty string' }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'set_model_override', arguments: { model: 'sonnet' } });
      expect(result.isError).toBe(true);
      await client.close();
    });
  });

  describe('get_model_override', () => {
    it('resolves the agent override over the global one', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          overrides: [
            { id: 1, agent_id: null, model: 'opus', created_at: 't', updated_at: 't' },
            { id: 2, agent_id: 'agent:peggy', model: 'sonnet', created_at: 't', updated_at: 't' },
          ],
          count: 2,
        }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'get_model_override', arguments: { agent_id: 'agent:peggy' } });
      const data = parseResult(result) as { model: string; scope: string };
      expect(data.model).toBe('sonnet');
      expect(data.scope).toBe('agent');
      await client.close();
    });

    it('falls back to the global override when no agent override matches', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          overrides: [{ id: 1, agent_id: null, model: 'opus', created_at: 't', updated_at: 't' }],
          count: 1,
        }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'get_model_override', arguments: { agent_id: 'agent:other' } });
      const data = parseResult(result) as { model: string; scope: string };
      expect(data.model).toBe('opus');
      expect(data.scope).toBe('global');
      await client.close();
    });

    it('returns null when nothing is set', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, overrides: [], count: 0 }) });
      const client = await makeClient();
      const result = await client.callTool({ name: 'get_model_override', arguments: {} });
      const data = parseResult(result) as { model: null };
      expect(data.model).toBeNull();
      await client.close();
    });
  });

  describe('list_model_overrides', () => {
    it('formats scope for both agent and global rows', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          overrides: [
            { id: 2, agent_id: 'agent:peggy', model: 'sonnet', created_at: 't1', updated_at: 't1' },
            { id: 1, agent_id: null, model: 'opus', created_at: 't0', updated_at: 't0' },
          ],
          count: 2,
        }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'list_model_overrides', arguments: {} });
      const data = parseResult(result) as { overrides: Array<{ scope: string }>; count: number };
      expect(data.count).toBe(2);
      expect(data.overrides.map((o) => o.scope)).toEqual(['agent=agent:peggy', 'global']);
      await client.close();
    });
  });

  describe('delete_model_override', () => {
    it('deletes by agent_id', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted_count: 1, message: 'Deleted 1 override(s) for agent_id=agent:peggy' }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'delete_model_override', arguments: { agent_id: 'agent:peggy' } });
      expect(fetchMock.mock.calls[0]![0]).toBe(`${BUS_URL}/api/v1/model-overrides?agent_id=agent%3Apeggy`);
      const data = parseResult(result) as { deleted_count: number };
      expect(data.deleted_count).toBe(1);
      await client.close();
    });

    it('deletes the global override with scope=global', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted_count: 1, message: 'Deleted' }),
      });
      const client = await makeClient();
      await client.callTool({ name: 'delete_model_override', arguments: { scope: 'global' } });
      expect(fetchMock.mock.calls[0]![0]).toBe(`${BUS_URL}/api/v1/model-overrides?scope=global`);
      await client.close();
    });

    it('deletes everything with all=true', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted_count: 3, message: 'Cleared 3 model override(s)' }),
      });
      const client = await makeClient();
      await client.callTool({ name: 'delete_model_override', arguments: { all: true } });
      expect(fetchMock.mock.calls[0]![0]).toBe(`${BUS_URL}/api/v1/model-overrides?all=true`);
      await client.close();
    });

    it('errors when neither agent_id, scope, nor all is given', async () => {
      const client = await makeClient();
      const result = await client.callTool({ name: 'delete_model_override', arguments: {} });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    });
  });

  describe('deprecated aliases', () => {
    it('set_headless_model still writes an override', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ ok: true, id: 1, override: { id: 1, agent_id: null, model: 'opus', created_at: 't', updated_at: 't' } }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'set_headless_model', arguments: { model: 'opus' } });
      expect(result.isError).toBeFalsy();
      await client.close();
    });

    it('set_headless_model rejects schedule_id, pointing at the schedule', async () => {
      const client = await makeClient();
      const result = await client.callTool({
        name: 'set_headless_model',
        arguments: { model: 'opus', schedule_id: 'sched-1' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/schedule/i);
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    });

    it('get_headless_model rejects schedule_id', async () => {
      const client = await makeClient();
      const result = await client.callTool({ name: 'get_headless_model', arguments: { schedule_id: 'sched-1' } });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    });

    it('delete_headless_model rejects schedule_id', async () => {
      const client = await makeClient();
      const result = await client.callTool({ name: 'delete_headless_model', arguments: { schedule_id: 'sched-1' } });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    });

    it('list_headless_model still lists', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, overrides: [], count: 0 }),
      });
      const client = await makeClient();
      const result = await client.callTool({ name: 'list_headless_model', arguments: {} });
      expect(result.isError).toBeFalsy();
      await client.close();
    });

    it('tool descriptions are marked deprecated', async () => {
      const client = await makeClient();
      const { tools } = await client.listTools();
      const deprecated = tools.filter((t) => t.name.endsWith('_headless_model'));
      expect(deprecated.length).toBe(4);
      for (const tool of deprecated) {
        expect(tool.description).toMatch(/^Deprecated:/);
      }
      await client.close();
    });
  });
});
