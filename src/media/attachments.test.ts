import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { persistAttachmentBuffer, extensionFor } from './attachments.js';

describe('persistAttachmentBuffer', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentbus-media-test-'));
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the buffer to disk and inserts a row with the correct TTL', () => {
    const content = Buffer.from('hello attachment');
    const { id, local_path } = persistAttachmentBuffer(
      db,
      { agentId: 'agent:claude', download_path: tmpDir, ttl_seconds: 600 },
      content,
      { mime_type: 'image/png', original_filename: 'pic.png' },
    );

    expect(local_path).toMatch(/\.png$/);
    expect(readFileSync(local_path).equals(content)).toBe(true);
    expect(readdirSync(tmpDir)).toHaveLength(1);

    const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as {
      agent_id: string;
      local_path: string;
      mime_type: string;
      original_filename: string;
      created_at: number;
      expires_at: number;
    };
    expect(row.agent_id).toBe('agent:claude');
    expect(row.local_path).toBe(local_path);
    expect(row.mime_type).toBe('image/png');
    expect(row.original_filename).toBe('pic.png');
    expect(row.expires_at - row.created_at).toBe(600 * 1000);
  });

  it('derives the extension from MIME / filename / fallback', () => {
    const { local_path } = persistAttachmentBuffer(
      db,
      { agentId: 'agent:claude', download_path: tmpDir, ttl_seconds: 60 },
      Buffer.from('x'),
      {},
    );
    // No mime, no filename → .bin
    expect(local_path).toMatch(/\.bin$/);
    expect(extensionFor('application/pdf', 'report.pdf')).toBe('.pdf');
  });
});
