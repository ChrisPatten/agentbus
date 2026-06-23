import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AppConfigSchema, type AppConfig } from '../../config/schema.js';
import { buildEmailToolConfig, registerEmailTool, type EmailToolConfig } from './messaging.js';

const BUS_URL = 'http://bus:4000';

/** Parse a partial config through the real schema so adapter defaults apply. */
function parse(adaptersEmail: unknown, contacts: unknown = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: adaptersEmail ? { email: adaptersEmail } : {},
    contacts,
    memory: {},
  });
}

describe('buildEmailToolConfig', () => {
  it('returns null when no email adapter is configured', () => {
    expect(buildEmailToolConfig(parse(undefined))).toBeNull();
  });

  it('returns null when no contact has an email address', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } });
    expect(buildEmailToolConfig(config)).toBeNull();
  });

  it('uses the single-account channel id "email" and the contact address allowlist', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } }, {
      chris: { id: 'chris', displayName: 'Chris', platforms: { email: { address: 'chris@example.com' } } },
    });
    expect(buildEmailToolConfig(config)).toEqual({
      channel: 'email',
      allowlist: ['chris@example.com'],
      addressToContact: { 'chris@example.com': 'chris' },
    });
  });

  it('uses the named-instance channel id "email:<name>"', () => {
    const config = parse({ peggy: { imap: { user: 'peggy@icloud.com', password: 'pw' } } }, {
      chris: { id: 'chris', displayName: 'Chris', platforms: { email: { address: 'chris@example.com' } } },
    });
    expect(buildEmailToolConfig(config)!.channel).toBe('email:peggy');
  });

  it('collects addresses across contacts in config order, de-duplicated', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } }, {
      chris: {
        id: 'chris',
        displayName: 'Chris',
        platforms: { email: { address: ['chris@example.com', 'chris@work.com'] } },
      },
      alice: {
        id: 'alice',
        displayName: 'Alice',
        platforms: { email: { address: ['CHRIS@example.com', 'alice@example.com'] } },
      },
    });
    expect(buildEmailToolConfig(config)!.allowlist).toEqual([
      'chris@example.com',
      'chris@work.com',
      'alice@example.com',
    ]);
  });
});

describe('send_email tool', () => {
  const emailCfg: EmailToolConfig = {
    channel: 'email:peggy',
    allowlist: ['chris@example.com', 'chris@work.com'],
    addressToContact: { 'chris@example.com': 'chris', 'chris@work.com': 'chris' },
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  async function makeClient(cfg: EmailToolConfig = emailCfg) {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerEmailTool(server, BUS_URL, cfg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);
    return client;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to the first allowlisted address', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'm1' }) });

    const client = await makeClient();
    const result = await client.callTool({ name: 'send_email', arguments: { body: 'Hi there' } });

    expect(result.isError).toBeFalsy();
    const postCall = fetchMock.mock.calls[0]! as [string, { body: string }];
    const sent = JSON.parse(postCall[1].body) as {
      channel: string;
      recipient: string;
      sender: string;
      metadata: { email_to: string };
    };
    expect(postCall[0]).toBe(`${BUS_URL}/api/v1/messages`);
    expect(sent.channel).toBe('email:peggy');
    // Routed via the owning contact so the delivery worker dispatches it...
    expect(sent.recipient).toBe('contact:chris');
    // ...with the exact target address in metadata for the adapter.
    expect(sent.metadata.email_to).toBe('chris@example.com');
    expect(sent.sender).toBe('agent:claude');

    await client.close();
  });

  it('passes an explicit subject through metadata.email_subject', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'm-sub' }) });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_email',
      arguments: { body: 'hi', subject: 'Weekly status' },
    });

    expect(result.isError).toBeFalsy();
    const sent = JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body) as {
      metadata: { email_subject?: string };
    };
    expect(sent.metadata.email_subject).toBe('Weekly status');

    await client.close();
  });

  it('omits email_subject when no subject is given', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'm-nosub' }) });

    const client = await makeClient();
    await client.callTool({ name: 'send_email', arguments: { body: 'hi' } });

    const sent = JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body) as {
      metadata: Record<string, unknown>;
    };
    expect(sent.metadata).not.toHaveProperty('email_subject');

    await client.close();
  });

  it('accepts an explicit allowlisted `to`', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'm2' }) });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_email',
      arguments: { body: 'hi', to: 'chris@work.com' },
    });

    expect(result.isError).toBeFalsy();
    const sent = JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body) as {
      recipient: string;
      metadata: { email_to: string };
    };
    expect(sent.recipient).toBe('contact:chris');
    expect(sent.metadata.email_to).toBe('chris@work.com');

    await client.close();
  });

  it('matches the allowlist case-insensitively', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, id: 'm3' }) });

    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_email',
      arguments: { body: 'hi', to: 'CHRIS@Example.com' },
    });

    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('rejects a `to` that is not on the allowlist (no send)', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'send_email',
      arguments: { body: 'hi', to: 'evil@attacker.com' },
    });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('not on the email allowlist');
    expect(fetchMock).not.toHaveBeenCalled();

    await client.close();
  });

  it('reports a bus rejection', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: 'boom' }),
    });

    const client = await makeClient();
    const result = await client.callTool({ name: 'send_email', arguments: { body: 'hi' } });

    expect(result.isError).toBe(true);
    expect(((result.content as Array<{ text: string }>)[0]!).text).toContain('boom');

    await client.close();
  });
});
