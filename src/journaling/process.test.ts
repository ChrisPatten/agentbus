import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, tail } from './process.js';

const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Spawning is slow when the whole suite runs in parallel.
describe('runProcess (S66.6/S66.7)', { timeout: 30_000 }, () => {
  it('passes stdin, collects stdout/stderr and the exit code, without a shell', async () => {
    const r = await runProcess({
      command: '/bin/sh', args: ['-c', 'cat; echo err >&2; exit 3'], cwd: tmpdir(), env: ENV, stdin: 'hello', timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ code: 3, stdout: 'hello', timedOut: false, aborted: false, spawnError: null });
    expect(r.stderr.trim()).toBe('err');
  });

  it('treats arguments literally (no shell expansion)', async () => {
    const r = await runProcess({ command: '/bin/echo', args: ['$HOME', '; rm -rf /'], cwd: tmpdir(), env: ENV, timeoutMs: 20_000 });
    expect(r.stdout.trim()).toBe('$HOME ; rm -rf /');
  });

  it('reports a missing command as a spawn error', async () => {
    const r = await runProcess({ command: '/nonexistent/journaler', args: [], cwd: tmpdir(), env: ENV, timeoutMs: 20_000 });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.code).toBeNull();
  });

  it('times out', async () => {
    const r = await runProcess({ command: '/bin/sleep', args: ['30'], cwd: tmpdir(), env: ENV, timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('kills the whole process group, background children included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-proc-'));
    const pidFile = join(dir, 'child.pid');
    const controller = new AbortController();
    // Stop only once the background child exists, however slow the spawn is.
    const poll = setInterval(() => { if (existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim()) controller.abort(); }, 20);
    const r = await runProcess({
      command: '/bin/sh',
      args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
      cwd: dir, env: ENV, timeoutMs: 25_000, killGraceMs: 200, signal: controller.signal,
    });
    clearInterval(poll);
    expect(r.aborted).toBe(true);
    const childPid = Number(readFileSync(pidFile, 'utf-8').trim());
    for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(childPid)).toBe(false);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runProcess({ command: '/bin/sleep', args: ['30'], cwd: tmpdir(), env: ENV, timeoutMs: 10_000, signal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('gives only the environment it is handed', async () => {
    const r = await runProcess({ command: '/usr/bin/env', args: [], cwd: tmpdir(), env: { ...ENV, ONLY: 'this' }, timeoutMs: 20_000 });
    const keys = r.stdout.trim().split('\n').map((l) => l.split('=')[0]).sort();
    expect(keys).toEqual(['ONLY', 'PATH']);
  });
});

describe('tail', () => {
  it('keeps the end of long text', () => {
    expect(tail('abcdef', 4)).toBe('…def');
    expect(tail(' ok ', 10)).toBe('ok');
  });
});
