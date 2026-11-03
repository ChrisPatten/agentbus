import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetContentType, assetExists, storeAsset, validateAssetBytes } from './assets.js';
import { BoundsError } from './types.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('data')]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('surface assets', () => {
  let root: string; let dir: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'assets-')); dir = join(root, 'surface-assets'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads content types from headers', () => {
    expect(assetContentType('image/png')).toBe('image/png');
    expect(assetContentType('Image/JPEG; charset=binary')).toBe('image/jpeg');
    expect(assetContentType('image/gif')).toBeNull();
    expect(assetContentType(undefined)).toBeNull();
  });

  it('stores under <sha256>.<ext>, creates the directory, and is idempotent', () => {
    const a = storeAsset(dir, 'image/png', PNG);
    expect(a).toMatchObject({ hash: sha(PNG), size: PNG.length, created: true, content_type: 'image/png', url: `/api/v1/surface/assets/${sha(PNG)}` });
    expect(readFileSync(join(dir, `${sha(PNG)}.png`)).equals(PNG)).toBe(true);
    expect(storeAsset(dir, 'image/png', PNG).created).toBe(false);
    storeAsset(dir, 'image/jpeg', JPG);
    storeAsset(dir, 'image/svg+xml', SVG);
    expect(readdirSync(dir).sort()).toEqual([`${sha(PNG)}.png`, `${sha(JPG)}.jpg`, `${sha(SVG)}.svg`].sort());
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('knows what it has', () => {
    expect(assetExists(dir, sha(PNG))).toBe(false);
    storeAsset(dir, 'image/png', PNG);
    expect(assetExists(dir, sha(PNG))).toBe(true);
    expect(assetExists(dir, 'nothex')).toBe(false);
    expect(assetExists(dir, 'f'.repeat(64))).toBe(false);
  });

  it('rejects bytes that do not match the declared type, and writes nothing', () => {
    expect(() => storeAsset(dir, 'image/png', JPG)).toThrow(/not a PNG/);
    expect(() => storeAsset(dir, 'image/jpeg', PNG)).toThrow(/not a JPEG/);
    expect(() => storeAsset(dir, 'image/svg+xml', Buffer.from('hello'))).toThrow(/not an SVG/);
    expect(() => storeAsset(dir, 'image/png', Buffer.alloc(0))).toThrow(BoundsError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses active SVG content', () => {
    for (const bad of [
      '<svg><script>x()</script></svg>', '<svg onload="x()"></svg>', '<svg><foreignObject/></svg>',
      '<svg><a href="javascript:x()"/></svg>', '<svg><iframe/></svg>', '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>',
    ]) expect(() => validateAssetBytes('image/svg+xml', Buffer.from(bad)), bad).toThrow(BoundsError);
    expect(() => validateAssetBytes('image/svg+xml', Buffer.from('<?xml version="1.0"?>\n<!-- c --><svg width="1"/>'))).not.toThrow();
  });
});
