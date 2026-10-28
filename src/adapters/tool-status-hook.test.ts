/** scripts/hooks/agentbus_tool_status_hook.sh (E79 phrase mode) against a stub bus. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/hooks/agentbus_tool_status_hook.sh');
const hasJq = ['/usr/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].some((p) => existsSync(p));

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function stubBus(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function runHook(input: unknown, url: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((done) => {
    const child = spawn('/bin/bash', [HOOK], {
      env: { PATH: process.env['PATH'], HOME: '/tmp', AGENTBUS_URL: url, ...extraEnv },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', () => done());
    child.stdin.end(JSON.stringify(input));
  });
}

async function settle(seen: Seen[], count: number): Promise<void> {
  for (let i = 0; i < 100 && seen.length < count; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150)); // let any unexpected extra post land
}

const prompt = 'New message from contact:chris via telegram:peggy (topic: general) at 2026-10-27T12:00:00Z [id:abc]:\nhello';

async function startTurn(url: string, session: string, env: Record<string, string> = {}): Promise<void> {
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }, url, env);
}

function post(url: string, session: string, tool_name: string, tool_input: unknown, env: Record<string, string> = {}) {
  return runHook({ hook_event_name: 'PostToolUse', session_id: session, tool_name, tool_input }, url, env);
}

const statusPosts = (seen: Seen[]) => seen.filter((s) => s.path.endsWith('/tool-status'));

describe.skipIf(!hasJq)('agentbus_tool_status_hook.sh phrase mode', { timeout: 60_000 }, () => {
  it('posts a fixed transient phrase and no argument content', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'Read', { file_path: '/Users/chris/SECRET-notes.md' });
    await settle(seen, 2);

    const posts = statusPosts(seen);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/api/v1/adapters/telegram:peggy/tool-status');
    expect(posts[0]!.body).toMatchObject({ contact_id: 'contact:chris', text: 'Reading a file', placeholder: true });
    expect(JSON.stringify(posts[0]!.body)).not.toMatch(/SECRET|Users/);
  });

  it('refines Bash by command word and never echoes the command', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'Bash', { command: 'calctl show today --output json SECRET' });
    await settle(seen, 2);
    expect(statusPosts(seen)[0]!.body['text']).toBe('Checking the calendar');
    expect(JSON.stringify(statusPosts(seen))).not.toContain('SECRET');
  });

  it('uses the Working on it fallback for unknown MCP tools', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'mcp__mystery__do_thing', { a: 'SECRET' });
    await settle(seen, 2);
    expect(statusPosts(seen)[0]!.body['text']).toBe('Working on it');
  });

  it('status tool posts sanitised text and holds against later fixed phrases until the next turn', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'mcp__agentbus__status', { text: ' Comparing *the* quotes ' });
    await post(url, session, 'Read', { file_path: '/a' });
    await settle(seen, 2);
    let posts = statusPosts(seen);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body['text']).toBe('Comparing the quotes');

    await post(url, session, 'mcp__agentbus__status', { text: 'Drafting the reply' });
    await settle(seen, 3);
    posts = statusPosts(seen);
    expect(posts.map((p) => p.body['text'])).toEqual(['Comparing the quotes', 'Drafting the reply']);

    // next turn: fixed phrases flow again
    await startTurn(url, session);
    await post(url, session, 'Read', { file_path: '/a' });
    await settle(seen, 5);
    expect(statusPosts(seen).map((p) => p.body['text'])).toEqual(['Comparing the quotes', 'Drafting the reply', 'Reading a file']);
  });

  it('ignores invalid status text and does not make it sticky', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'mcp__agentbus__status', { text: 'this is far too many words for a status' });
    await post(url, session, 'Read', {});
    await settle(seen, 2);
    expect(statusPosts(seen).map((p) => p.body['text'])).toEqual(['Reading a file']);
  });

  it('stays silent after delivery and for email channels', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    await startTurn(url, session);
    await post(url, session, 'mcp__agentbus__reply', { message_id: 'abc', body: 'hi' });
    await post(url, session, 'Read', {});
    await post(url, session, 'mcp__agentbus__status', { text: 'Tidying up' });
    await settle(seen, 2);
    expect(statusPosts(seen)).toHaveLength(0);

    const emailSession = `t-${randomUUID()}`;
    await runHook(
      { hook_event_name: 'UserPromptSubmit', session_id: emailSession, prompt: prompt.replace('telegram:peggy', 'email:main') },
      url,
    );
    await post(url, emailSession, 'Read', {});
    await settle(seen, 2);
    expect(seen.filter((s) => s.path.includes('email'))).toHaveLength(0);
  });

  it('raw mode restores the old lines (and silences the status tool)', async () => {
    const { url, seen } = await stubBus();
    const session = `t-${randomUUID()}`;
    const env = { AGENTBUS_TOOL_STATUS_MODE: 'raw' };
    await startTurn(url, session, env);
    await post(url, session, 'Read', { file_path: '/a/b.md' }, env);
    await post(url, session, 'mcp__agentbus__status', { text: 'Comparing the quotes' }, env);
    await settle(seen, 2);
    const posts = statusPosts(seen);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body['text']).toBe('Reading /a/b.md');
    expect(posts[0]!.body['placeholder']).toBeUndefined();
  });
});
