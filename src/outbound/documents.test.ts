import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocumentPath, resolveSendDirs, MAX_DOCUMENT_BYTES } from './documents.js';
import type { AppConfig } from '../config/schema.js';

describe('checkDocumentPath (S81.7)', () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'e81-docs-')));
    allowed = join(root, 'data');
    outside = join(root, 'secrets');
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(allowed, 'report.pdf'), 'pdf bytes');
    writeFileSync(join(outside, 'passwd'), 'secret');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts a file inside an allowed directory and returns its real path and size', () => {
    const res = checkDocumentPath(join(allowed, 'report.pdf'), [allowed]);
    expect(res).toEqual({ ok: true, realPath: join(allowed, 'report.pdf'), size: 9 });
  });

  it('rejects a path outside every allowed directory', () => {
    const res = checkDocumentPath(join(outside, 'passwd'), [allowed]);
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain('outside the allowed');
  });

  it('rejects ../ traversal out of an allowed directory', () => {
    const res = checkDocumentPath(join(allowed, '..', 'secrets', 'passwd'), [allowed]);
    expect(res.ok).toBe(false);
  });

  it('rejects a sibling directory that merely shares the allowed prefix', () => {
    const sibling = `${allowed}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'x.txt'), 'x');
    expect(checkDocumentPath(join(sibling, 'x.txt'), [allowed]).ok).toBe(false);
  });

  it('rejects a symlink inside the allowed directory that points outside it', () => {
    symlinkSync(join(outside, 'passwd'), join(allowed, 'innocent.txt'));
    const res = checkDocumentPath(join(allowed, 'innocent.txt'), [allowed]);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('outside the allowed');
  });

  it('rejects a symlinked directory that escapes', () => {
    symlinkSync(outside, join(allowed, 'link'));
    expect(checkDocumentPath(join(allowed, 'link', 'passwd'), [allowed]).ok).toBe(false);
  });

  it('accepts a symlink that stays inside the allowed directory', () => {
    symlinkSync(join(allowed, 'report.pdf'), join(allowed, 'alias.pdf'));
    const res = checkDocumentPath(join(allowed, 'alias.pdf'), [allowed]);
    expect(res).toMatchObject({ ok: true, realPath: join(allowed, 'report.pdf') });
  });

  it('allows an allowed directory that is itself reached through a symlink', () => {
    const viaLink = join(root, 'data-link');
    symlinkSync(allowed, viaLink);
    expect(checkDocumentPath(join(allowed, 'report.pdf'), [viaLink]).ok).toBe(true);
  });

  it('rejects an oversize file before any read', () => {
    const big = join(allowed, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, MAX_DOCUMENT_BYTES + 1);
    const res = checkDocumentPath(big, [allowed]);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('upload limit');
  });

  it('accepts a file at exactly the limit', () => {
    const exact = join(allowed, 'exact.bin');
    writeFileSync(exact, '');
    truncateSync(exact, 1024);
    expect(checkDocumentPath(exact, [allowed], 1024).ok).toBe(true);
    expect(checkDocumentPath(exact, [allowed], 1023).ok).toBe(false);
  });

  it('rejects relative paths, NUL bytes, missing files, directories and empty files', () => {
    expect(checkDocumentPath('report.pdf', [allowed]).ok).toBe(false);
    expect(checkDocumentPath(`${allowed}/report.pdf\0.png`, [allowed]).ok).toBe(false);
    expect(checkDocumentPath(join(allowed, 'nope.pdf'), [allowed]).ok).toBe(false);
    expect(checkDocumentPath(allowed, [allowed]).ok).toBe(false);
    writeFileSync(join(allowed, 'empty'), '');
    expect(checkDocumentPath(join(allowed, 'empty'), [allowed]).ok).toBe(false);
  });

  it('allows nothing when the allowed directory does not exist', () => {
    expect(checkDocumentPath(join(allowed, 'report.pdf'), [join(root, 'missing')]).ok).toBe(false);
  });
});

describe('resolveSendDirs (S81.7)', () => {
  const config = {
    agents: { peggy: { working_dir: '/Users/x/peggy' }, other: {} },
    adapters: {},
  } as unknown as AppConfig;

  it('uses the configured send_paths when present', () => {
    expect(resolveSendDirs(config, ['/srv/outbox'])).toEqual(['/srv/outbox']);
  });

  it('defaults to each agent data/ directory and its scratchpad root', () => {
    const dirs = resolveSendDirs(config);
    expect(dirs).toContain('/Users/x/peggy/data');
    expect(dirs.some((d) => d.startsWith('/tmp/claude-') && d.endsWith('-Users-x-peggy'))).toBe(true);
  });

  it('is empty (allows nothing) when no agent has a working directory', () => {
    expect(resolveSendDirs({ agents: {}, adapters: {} } as unknown as AppConfig)).toEqual([]);
  });
});
