import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { busTokenEnv, resolveBusToken, withBusToken, BUS_TOKEN_ENV } from './bus-auth.js';

const BASE = 'http://127.0.0.1:3000';

function okResponse(): Response {
  return { ok: true, json: async () => ({}) } as unknown as Response;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('resolveBusToken', () => {
  it('prefers config bus.auth_token, falls back to AGENTBUS_BUS_TOKEN, treats empty as unset', () => {
    expect(resolveBusToken({ bus: { auth_token: 'cfg' } }, { [BUS_TOKEN_ENV]: 'env' })).toBe('cfg');
    expect(resolveBusToken({ bus: {} }, { [BUS_TOKEN_ENV]: 'env' })).toBe('env');
    expect(resolveBusToken({ bus: { auth_token: '' } }, { [BUS_TOKEN_ENV]: '' })).toBeUndefined();
    expect(resolveBusToken(null, {})).toBeUndefined();
  });

  it('busTokenEnv is empty without a token', () => {
    expect(busTokenEnv(undefined)).toEqual({});
    expect(busTokenEnv('t')).toEqual({ [BUS_TOKEN_ENV]: 't' });
  });
});

describe('withBusToken', () => {
  it('adds X-Bus-Token to bus requests and keeps existing headers', async () => {
    const base = vi.fn(async (_i: Parameters<typeof fetch>[0], _init?: RequestInit) => okResponse());
    const f = withBusToken(BASE, 'secret', base as unknown as typeof fetch);
    await f(`${BASE}/api/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const init = base.mock.calls[0]![1];
    expect(headerOf(init, 'X-Bus-Token')).toBe('secret');
    expect(headerOf(init, 'Content-Type')).toBe('application/json');
    expect(init?.method).toBe('POST');
  });

  it('never sends the token to other hosts', async () => {
    const base = vi.fn(async (_i: Parameters<typeof fetch>[0], _init?: RequestInit) => okResponse());
    const f = withBusToken(BASE, 'secret', base as unknown as typeof fetch);
    await f('https://api.telegram.org/botX/sendMessage');
    await f('http://127.0.0.1:30001/api');
    for (const call of base.mock.calls) expect(headerOf(call[1], 'X-Bus-Token')).toBeNull();
  });

  it('passes requests through unchanged when no token is configured', async () => {
    const base = vi.fn(async (_i: Parameters<typeof fetch>[0], _init?: RequestInit) => okResponse());
    const f = withBusToken(BASE, undefined, base as unknown as typeof fetch);
    const init = { headers: { 'Content-Type': 'application/json' } };
    await f(`${BASE}/api/v1/messages`, init);
    expect(base).toHaveBeenCalledWith(`${BASE}/api/v1/messages`, init);
  });

  it('resolves globalThis.fetch lazily when no base fetch is given', async () => {
    const stub = vi.fn(async (_i: Parameters<typeof fetch>[0], _init?: RequestInit) => okResponse());
    const f = withBusToken(BASE, 'secret');
    vi.stubGlobal('fetch', stub);
    try {
      await f(`${BASE}/api/v1/health`);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(headerOf(stub.mock.calls[0]![1], 'X-Bus-Token')).toBe('secret');
  });
});

// The pool hook scripts are bash; exercise them with a stub `curl` on PATH
// that records its argv and stdin, so we can see whether the token was sent.
// Spawning bash + curl stubs is slow under full-suite load; allow extra time.
describe('scripts/hooks bus token', { timeout: 30_000 }, () => {
  const hooksDir = resolve(__dirname, '../../scripts/hooks');

  function runHook(script: string, input: unknown, token?: string): { args: string; stdin: string } {
    const dir = mkdtempSync(join(tmpdir(), 'agentbus-hook-test-'));
    const log = join(dir, 'curl.log');
    const curl = join(dir, 'curl');
    writeFileSync(
      curl,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}.args"\ncat > "${log}.stdin"\n`,
    );
    chmodSync(curl, 0o755);
    const env: NodeJS.ProcessEnv = { PATH: `${dir}:${process.env['PATH'] ?? ''}`, HOME: dir };
    if (token) env[BUS_TOKEN_ENV] = token;
    execFileSync('bash', [join(hooksDir, script)], { input: JSON.stringify(input), env });
    // The POST is backgrounded; wait briefly for the stub to write its log.
    const deadline = Date.now() + 5000;
    while (!existsSync(`${log}.stdin`) && Date.now() < deadline) execFileSync('sleep', ['0.05']);
    execFileSync('sleep', ['0.1']);
    return { args: readFileSync(`${log}.args`, 'utf-8'), stdin: readFileSync(`${log}.stdin`, 'utf-8') };
  }

  const stopInput = { session_id: 'sess-1' };

  it('stop hook sends X-Bus-Token via curl config on stdin when AGENTBUS_BUS_TOKEN is set', () => {
    const { args, stdin } = runHook('agentbus_stop_hook.sh', stopInput, 'tok-123');
    expect(stdin).toContain('header = "X-Bus-Token: tok-123"');
    expect(args).not.toContain('tok-123'); // never on the command line
    expect(args).toContain('/api/v1/journal/events');
  });

  it('stop hook sends no token header when AGENTBUS_BUS_TOKEN is unset', () => {
    const { args, stdin } = runHook('agentbus_stop_hook.sh', stopInput);
    expect(stdin).not.toContain('X-Bus-Token');
    expect(args).not.toContain('-K');
  });

  it('approval hook sends the token too', () => {
    const { stdin } = runHook(
      'agentbus_approval_hook.sh',
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' },
      'tok-abc',
    );
    expect(stdin).toContain('X-Bus-Token: tok-abc');
  });
});
