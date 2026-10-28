import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerStatusTool } from './status.js';

async function makeClient() {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerStatusTool(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

async function call(text: unknown) {
  const client = await makeClient();
  return client.callTool({ name: 'status', arguments: { text } });
}

function body(result: Awaited<ReturnType<typeof call>>): { status?: string } {
  return JSON.parse(((result.content as Array<{ text: string }>)[0]!).text) as { status?: string };
}

describe('status tool', () => {
  it('accepts plain text and returns the sanitised status', async () => {
    const result = await call('  Checking *the* calendar  ');
    expect(result.isError).toBeFalsy();
    expect(body(result).status).toBe('Checking the calendar');
  });

  it('rejects text that is empty after sanitising', async () => {
    expect((await call('***')).isError).toBe(true);
    expect((await call('   ')).isError).toBe(true);
  });

  it('rejects text over 40 characters or over 5 words', async () => {
    expect((await call('a'.repeat(41))).isError).toBe(true);
    expect((await call('one two three four five six')).isError).toBe(true);
  });

  it('rejects a missing or non-string argument', async () => {
    expect((await call(undefined)).isError).toBe(true);
    expect((await call(12)).isError).toBe(true);
  });
});
