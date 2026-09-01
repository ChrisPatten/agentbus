import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logWebhookRequest } from './webhook-log.js';

function todayDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('logWebhookRequest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webhook-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when config is undefined', () => {
    logWebhookRequest(undefined, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' });
    expect(existsSync(join(dir, 'pebble'))).toBe(false);
  });

  it('is a no-op when config.enabled is false', () => {
    logWebhookRequest({ enabled: false, dir }, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' });
    expect(existsSync(join(dir, 'pebble'))).toBe(false);
  });

  it('writes a line for a successful request', () => {
    logWebhookRequest(
      { enabled: true, dir },
      { webhook: 'pebble', ok: true, status: 200, reason: 'ok', raw: { fields: { transcription: 'hi' } } },
    );

    const filePath = join(dir, 'pebble', `${todayDateStamp()}.jsonl`);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ webhook: 'pebble', ok: true, status: 200, reason: 'ok' });
    expect(lines[0]!['raw']).toEqual({ fields: { transcription: 'hi' } });
    expect(typeof lines[0]!['timestamp']).toBe('string');
  });

  it('writes a line for a rejected request', () => {
    logWebhookRequest(
      { enabled: true, dir },
      { webhook: 'pebble', ok: false, status: 401, reason: 'unauthorized' },
    );

    const filePath = join(dir, 'pebble', `${todayDateStamp()}.jsonl`);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ webhook: 'pebble', ok: false, status: 401, reason: 'unauthorized' });
  });

  it('writes to a date-based file path — <dir>/<webhook>/<YYYY-MM-DD>.jsonl', () => {
    logWebhookRequest({ enabled: true, dir }, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' });

    const expectedPath = join(dir, 'pebble', `${todayDateStamp()}.jsonl`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('appends multiple entries to the same day-file rather than overwriting', () => {
    logWebhookRequest({ enabled: true, dir }, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' });
    logWebhookRequest({ enabled: true, dir }, { webhook: 'pebble', ok: false, status: 400, reason: 'bad_request' });

    const filePath = join(dir, 'pebble', `${todayDateStamp()}.jsonl`);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]!['ok']).toBe(true);
    expect(lines[1]!['ok']).toBe(false);
  });

  it('is reusable across different webhook names, each getting its own subdirectory', () => {
    logWebhookRequest({ enabled: true, dir }, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' });
    logWebhookRequest({ enabled: true, dir }, { webhook: 'some-future-webhook', ok: true, status: 200, reason: 'ok' });

    expect(existsSync(join(dir, 'pebble', `${todayDateStamp()}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, 'some-future-webhook', `${todayDateStamp()}.jsonl`))).toBe(true);
  });

  it('logs a console error and does not throw when the write fails', () => {
    // Force a write failure: the "directory" is actually a file, so mkdirSync underneath it fails.
    const blockedDir = join(dir, 'blocked');
    writeFileSync(blockedDir, 'not a directory');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      logWebhookRequest({ enabled: true, dir: blockedDir }, { webhook: 'pebble', ok: true, status: 200, reason: 'ok' }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
