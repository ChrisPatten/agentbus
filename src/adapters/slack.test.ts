import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { SlackAdapter } from './slack.js';
import type { AppConfig, SlackAdapterConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

const secret = 'a-shared-n8n-passphrase-of-32-chars!';

interface Captured {
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let respond: (res: ServerResponse) => void = (res) => res.end();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      captured.push({ headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/agentbus/slack-dm`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  respond = (res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ts: '1729430000.123456' }));
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function makeCfg(overrides: Partial<SlackAdapterConfig> = {}): SlackAdapterConfig {
  return {
    enabled: true,
    webhook_url: baseUrl,
    jwt_secret: secret,
    jwt_ttl_seconds: 60,
    request_timeout_ms: 2000,
    ...overrides,
  };
}

const contacts = {
  chris: { id: 'chris', displayName: 'Chris', platforms: { slack: { user_id: 'U012ABCDEF' } } },
  alice: { id: 'alice', displayName: 'Alice', platforms: {} },
} as unknown as AppConfig['contacts'];

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'out-1',
    timestamp: new Date().toISOString(),
    channel: 'slack',
    topic: 'general',
    sender: 'agent:peggy',
    recipient: 'contact:chris',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'Build finished: 3 tests failing' },
    metadata: {},
    ...overrides,
  };
}

function verify(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  expect(signature).toBe(expected);
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('SlackAdapter.send (E76, S76.0)', () => {
  it('POSTs the Slack user id and message with a valid bearer JWT', async () => {
    const adapter = new SlackAdapter(makeCfg(), contacts);
    const before = Math.floor(Date.now() / 1000);
    const result = await adapter.send(envelope());

    expect(result).toEqual({ success: true, platformMessageId: '1729430000.123456' });
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({ slack_user_id: 'U012ABCDEF', message: 'Build finished: 3 tests failing' });

    const auth = req.headers['authorization'] ?? '';
    expect(auth).toMatch(/^Bearer /);
    const claims = verify(auth.slice('Bearer '.length));
    expect(claims['iss']).toBe('agentbus');
    expect(claims['jti']).toBe('out-1');
    expect(claims['iat']).toBeGreaterThanOrEqual(before);
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(60);
  });

  it('falls back to the envelope id when n8n returns no ts', async () => {
    respond = (res) => res.end('');
    const result = await new SlackAdapter(makeCfg(), contacts).send(envelope());
    expect(result).toEqual({ success: true, platformMessageId: 'out-1' });
  });

  it('does not call n8n for a contact without a Slack user id', async () => {
    const result = await new SlackAdapter(makeCfg(), contacts).send(envelope({ recipient: 'contact:alice' }));
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('platforms.slack.user_id');
    expect(captured).toHaveLength(0);
  });

  it('does not send reactions', async () => {
    const result = await new SlackAdapter(makeCfg(), contacts).send(
      envelope({ payload: { type: 'reaction', emoji: '👍', removed: false, target_message_id: 'x' } }),
    );
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(captured).toHaveLength(0);
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [429, true],
    [500, true],
    [502, true],
  ])('maps HTTP %i to retryable=%s', async (status, retryable) => {
    respond = (res) => {
      res.statusCode = status;
      res.end(JSON.stringify({ ok: false, error: 'nope' }));
    };
    const result = await new SlackAdapter(makeCfg(), contacts).send(envelope());
    expect(result).toEqual({ success: false, retryable, error: `n8n webhook HTTP ${status}: nope` });
  });

  it('treats a 200 with ok:false as a non-retryable failure', async () => {
    respond = (res) => res.end(JSON.stringify({ ok: false, error: 'user_not_found' }));
    const result = await new SlackAdapter(makeCfg(), contacts).send(envelope());
    expect(result).toMatchObject({ success: false, retryable: false });
  });

  it('retries a timeout', async () => {
    respond = (res) => setTimeout(() => res.end('{}'), 1500);
    const result = await new SlackAdapter(makeCfg({ request_timeout_ms: 1000 }), contacts).send(envelope());
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('timed out after 1000ms');
  });

  it('retries when n8n is unreachable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await new SlackAdapter(makeCfg({ webhook_url: `http://127.0.0.1:${port}/webhook` }), contacts).send(envelope());
    expect(result).toMatchObject({ success: false, retryable: true });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports degraded health after three failures in a row, healthy after a success', async () => {
    const adapter = new SlackAdapter(makeCfg(), contacts);
    respond = (res) => {
      res.statusCode = 502;
      res.end();
    };
    for (let i = 0; i < 3; i++) await adapter.send(envelope());
    expect((await adapter.health()).status).toBe('degraded');

    respond = (res) => res.end(JSON.stringify({ ok: true, ts: '1.2' }));
    await adapter.send(envelope());
    const health = await adapter.health();
    expect(health.status).toBe('healthy');
    expect(health.lastActivity).toBeDefined();
  });
});
