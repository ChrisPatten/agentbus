/** scripts/hooks/agentbus_journal_hook.sh against a stub bus. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/hooks/agentbus_journal_hook.sh');
const hasJq = ['/usr/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].some((p) => existsSync(p));

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function stubBus(): Promise<{ url: string; seen: Array<{ token: string | undefined; body: unknown }> }> {
  const seen: Array<{ token: string | undefined; body: unknown }> = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      seen.push({ token: req.headers['x-bus-token'] as string | undefined, body: JSON.parse(body) });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe.skipIf(!hasJq)('agentbus_journal_hook.sh', () => {
  it('posts pre-compact with a snapshot and sends AGENTBUS_BUS_TOKEN as X-Bus-Token', async () => {
    const { url, seen } = await stubBus();
    const dir = mkdtempSync(join(tmpdir(), 'journal-hook-'));
    try {
      const transcript = join(dir, 't.jsonl');
      writeFileSync(transcript, '{"a":1}\n');
      const input = JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'sess-1', transcript_path: transcript });
      // spawnSync blocks the event loop the stub server needs, so run it async.
      await new Promise<void>((done) => {
        const child = spawn('/bin/bash', [HOOK], {
          env: { PATH: process.env['PATH'], HOME: dir, AGENTBUS_URL: url, AGENTBUS_BUS_TOKEN: 'tok"en', AGENTBUS_SNAPSHOT_DIR: join(dir, 'snaps') },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('close', () => done());
        child.stdin.end(input);
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.token).toBe('tok"en');
      expect(seen[0]!.body).toMatchObject({ harness_session_id: 'sess-1', event: 'pre-compact', transcript_path: transcript });
      expect((seen[0]!.body as { snapshot_path: string }).snapshot_path).toContain(join(dir, 'snaps'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('exits 0 without a session id', () => {
    const r = spawnSync('/bin/bash', [HOOK], { input: '{}', env: { PATH: process.env['PATH'] } });
    expect(r.status).toBe(0);
  });
});
