/** E81 — MCP tools: send_location/venue/contact/document, ask_input, send_rich, edit/pin/unpin, and the send options. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTelegramSendTools } from './telegram-send.js';
import { registerMessagingTools } from './messaging.js';
import type { AppConfig } from '../../config/schema.js';

const BUS = 'http://bus:4000';

async function makeClient(config?: AppConfig) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerTelegramSendTools(server, BUS, 'claude', config);
  registerMessagingTools(server, BUS, 'claude');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(ct);
  return client;
}

const text = (r: { content: unknown }) => ((r.content as Array<{ text: string }>)[0]!).text;

describe('E81 MCP tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let posted: Array<{ url: string; body: Record<string, any> }>;

  beforeEach(() => {
    posted = [];
    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).includes('/adapters/resolve')) {
        const exists = !String(url).includes('nope');
        return { ok: true, json: async () => ({ ok: true, exists }) };
      }
      posted.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
      return { ok: true, json: async () => ({ ok: true, id: 'msg-1' }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  const addr = { to: 'contact:chris', channel: 'telegram' };

  describe('send options on send_message (S81.2)', () => {
    it('carries silent, no_preview and pin in metadata, and only when true', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_message', arguments: { ...addr, body: 'hi', silent: true, no_preview: true, pin: true, choices: ['A'] } });
      expect(posted[0]!.body.metadata).toMatchObject({ silent: true, no_preview: true, pin: true, choices: ['A'] });
      await client.callTool({ name: 'send_message', arguments: { ...addr, body: 'hi', silent: false } });
      expect(posted[1]!.body.metadata).not.toHaveProperty('silent');
      await client.close();
    });
  });

  describe('send_location / venue / contact (S81.6)', () => {
    it('send_location on Telegram carries the native form and a map-link fallback body', async () => {
      const client = await makeClient();
      const res = await client.callTool({ name: 'send_location', arguments: { ...addr, latitude: 42.0334, longitude: -71.2198, silent: true } });
      expect(JSON.parse(text(res as never))).toEqual({ success: true, message_id: 'msg-1' });
      const env = posted[0]!.body;
      expect(env.metadata).toMatchObject({ silent: true, telegram_send: { kind: 'location', latitude: 42.0334, longitude: -71.2198 } });
      expect(env.payload.body).toContain('https://maps.apple.com/?ll=42.0334,-71.2198');
      expect(env.recipient).toBe('contact:chris');
      await client.close();
    });

    it('on a non-Telegram channel sends only the text rendering, with no telegram_send', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_venue', arguments: { to: 'contact:chris', channel: 'email', latitude: 1, longitude: 2, title: 'Cafe Uno', address: '1 Main St' } });
      expect(posted[0]!.body.metadata).not.toHaveProperty('telegram_send');
      expect(posted[0]!.body.payload.body).toBe('Cafe Uno\n1 Main St\nhttps://maps.apple.com/?ll=1,2&q=Cafe%20Uno');
      await client.close();
    });

    it('send_contact renders a name and number as the fallback and requires a phone number', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_contact', arguments: { to: 'contact:chris', channel: 'email', phone_number: '+16175551212', first_name: 'Ann', last_name: 'Lee' } });
      expect(posted[0]!.body.payload.body).toBe('Contact: Ann Lee, +16175551212');
      const missing = await client.callTool({ name: 'send_contact', arguments: { ...addr, first_name: 'Ann' } });
      expect(missing.isError).toBe(true);
      await client.close();
    });

    it('validates coordinate ranges before any request', async () => {
      const client = await makeClient();
      for (const args of [{ latitude: 91, longitude: 0 }, { latitude: -91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: 0, longitude: -181 }]) {
        const res = await client.callTool({ name: 'send_location', arguments: { ...addr, ...args } });
        expect(res.isError).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    });

    it('reports an unknown channel without enqueueing', async () => {
      const client = await makeClient();
      const res = await client.callTool({ name: 'send_location', arguments: { to: 'contact:chris', channel: 'nope', latitude: 1, longitude: 2 } });
      expect(res.isError).toBe(true);
      expect(text(res as never)).toContain('Unknown channel');
      expect(posted).toHaveLength(0);
      await client.close();
    });
  });

  describe('send_document (S81.7)', () => {
    let dir: string;
    let config: AppConfig;
    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'e81-tool-')));
      writeFileSync(join(dir, 'a.pdf'), 'pdf');
      config = { agents: {}, adapters: { telegram: { token: 't', poll_timeout: 30, send_paths: [dir] } } } as unknown as AppConfig;
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('enqueues an allowed file with the native form', async () => {
      const client = await makeClient(config);
      const res = await client.callTool({ name: 'send_document', arguments: { ...addr, path: join(dir, 'a.pdf'), caption: 'Hi' } });
      expect(res.isError).toBeFalsy();
      expect(posted[0]!.body.metadata.telegram_send).toEqual({ kind: 'document', path: join(dir, 'a.pdf'), caption: 'Hi' });
      expect(posted[0]!.body.payload.body).toBe('[file: a.pdf] Hi');
      await client.close();
    });

    it('rejects traversal, a symlink escape and a missing file before enqueueing', async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'e81-tool-out-')));
      writeFileSync(join(outside, 's.txt'), 'x');
      symlinkSync(join(outside, 's.txt'), join(dir, 'l.txt'));
      const client = await makeClient(config);
      for (const path of [join(dir, '..', 'x'), join(outside, 's.txt'), join(dir, 'l.txt'), join(dir, 'missing.pdf')]) {
        const res = await client.callTool({ name: 'send_document', arguments: { ...addr, path } });
        expect(res.isError).toBe(true);
      }
      expect(posted).toHaveLength(0);
      rmSync(outside, { recursive: true, force: true });
      await client.close();
    });

    it('is unsupported on non-Telegram channels', async () => {
      const client = await makeClient(config);
      const res = await client.callTool({ name: 'send_document', arguments: { to: 'contact:chris', channel: 'email', path: join(dir, 'a.pdf') } });
      expect(res.isError).toBe(true);
      expect(text(res as never)).toContain('not supported');
      expect(posted).toHaveLength(0);
      await client.close();
    });

    it('supports as=photo', async () => {
      const client = await makeClient(config);
      await client.callTool({ name: 'send_document', arguments: { ...addr, path: join(dir, 'a.pdf'), as: 'photo' } });
      expect(posted[0]!.body.metadata.telegram_send.kind).toBe('photo');
      await client.close();
    });
  });

  describe('ask_input (S81.8)', () => {
    it('carries the input kind and placeholder on Telegram', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'ask_input', arguments: { ...addr, kind: 'text', prompt: 'Which dish?', placeholder: 'e.g. lasagne' } });
      expect(posted[0]!.body.metadata.telegram_send).toEqual({ kind: 'ask_input', input: 'text', placeholder: 'e.g. lasagne' });
      expect(posted[0]!.body.payload.body).toBe('Which dish?');
      await client.close();
    });

    it('on other channels asks in plain text', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'ask_input', arguments: { to: 'contact:chris', channel: 'email', kind: 'location', prompt: 'Where are you?' } });
      expect(posted[0]!.body.metadata).not.toHaveProperty('telegram_send');
      expect(posted[0]!.body.payload.body).toBe('Where are you?\n\n(Please reply with a location.)');
      await client.close();
    });

    it('rejects an unknown kind', async () => {
      const client = await makeClient();
      expect((await client.callTool({ name: 'ask_input', arguments: { ...addr, kind: 'photo', prompt: 'x' } })).isError).toBe(true);
      await client.close();
    });
  });

  describe('send_rich (S81.9)', () => {
    const MD = '# Brief\n\n| Item | Time |\n|--|--|\n| Dentist | 10:00 |\n\n<details><summary>More</summary>\n\n- a\n\n</details>';

    it('sends the native form plus a table-free plain body on Telegram', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_rich', arguments: { ...addr, markdown: MD, choices: ['OK'] } });
      const env = posted[0]!.body;
      expect(env.metadata.telegram_send).toEqual({ kind: 'rich', format: 'markdown', content: MD });
      expect(env.metadata.choices).toEqual(['OK']);
      expect(env.payload.body).not.toMatch(/\|/);
      expect(env.payload.body).toContain('- Dentist: 10:00');
      await client.close();
    });

    it('yields a readable plain-text body with a numbered choice list on email', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_rich', arguments: { to: 'contact:chris', channel: 'email', markdown: MD, choices: ['Yes', 'No'] } });
      const env = posted[0]!.body;
      expect(env.metadata).not.toHaveProperty('telegram_send');
      expect(env.payload.body).toContain('Brief');
      expect(env.payload.body).toContain('- Dentist: 10:00');
      expect(env.payload.body).toMatch(/1\. Yes\n2\. No$/);
      expect(env.payload.body).not.toMatch(/\|/);
      await client.close();
    });

    it('requires exactly one of markdown or html', async () => {
      const client = await makeClient();
      expect((await client.callTool({ name: 'send_rich', arguments: { ...addr } })).isError).toBe(true);
      expect((await client.callTool({ name: 'send_rich', arguments: { ...addr, markdown: 'a', html: '<p>a</p>' } })).isError).toBe(true);
      expect(posted).toHaveLength(0);
      await client.close();
    });

    it('accepts html', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'send_rich', arguments: { ...addr, html: '<h2>Hi</h2>' } });
      expect(posted[0]!.body.metadata.telegram_send).toMatchObject({ format: 'html' });
      await client.close();
    });
  });

  describe('edit_message / pin_message / unpin_message (S81.4, S81.5)', () => {
    it('edit_message posts body and choices to the edit endpoint', async () => {
      const client = await makeClient();
      const res = await client.callTool({ name: 'edit_message', arguments: { message_id: 'm1', body: 'new', choices: ['A'] } });
      expect(JSON.parse(text(res as never))).toEqual({ success: true, message_id: 'm1' });
      expect(posted[0]).toMatchObject({ url: `${BUS}/api/v1/messages/m1/edit`, body: { body: 'new', choices: ['A'] } });
      await client.close();
    });

    it('returns the bus error for an unknown or foreign id', async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'No record of a delivered message for bus message "ghost".' }) }));
      const client = await makeClient();
      const res = await client.callTool({ name: 'edit_message', arguments: { message_id: 'ghost', body: 'x' } });
      expect(res.isError).toBe(true);
      expect(text(res as never)).toContain('No record');
      await client.close();
    });

    it('pin_message defaults to silent and surfaces a rights error to the agent', async () => {
      const client = await makeClient();
      await client.callTool({ name: 'pin_message', arguments: { message_id: 'm1' } });
      expect(posted[0]).toMatchObject({ url: `${BUS}/api/v1/messages/m1/pin`, body: { silent: true } });
      fetchMock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'This bot lacks the "Pin Messages" admin right in this chat.' }) }));
      const res = await client.callTool({ name: 'pin_message', arguments: { message_id: 'm1' } });
      expect(res.isError).toBe(true);
      expect(text(res as never)).toContain('Pin Messages');
      await client.close();
    });

    it('unpin_message supports unpin_all', async () => {
      const client = await makeClient();
      const res = await client.callTool({ name: 'unpin_message', arguments: { message_id: 'm1', unpin_all: true } });
      expect(JSON.parse(text(res as never))).toMatchObject({ pinned: false, all: true });
      expect(posted[0]).toMatchObject({ url: `${BUS}/api/v1/messages/m1/unpin`, body: { all: true } });
      await client.close();
    });
  });
});
