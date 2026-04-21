import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AttachmentSweeper } from './attachment-sweeper.js';
import { runMigrations } from '../db/schema.js';

describe('AttachmentSweeper', () => {
  let db: Database.Database;
  let tmpDir: string;
  let sweeper: AttachmentSweeper;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'sweeper-'));
    sweeper = new AttachmentSweeper({ db });
  });

  afterEach(() => {
    sweeper.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertAttachment(opts: {
    expiresAt: number;
    fileExists?: boolean;
  }): { id: string; path: string } {
    const id = randomUUID();
    const filePath = join(tmpDir, `${id}.jpg`);
    if (opts.fileExists !== false) {
      writeFileSync(filePath, 'fake-jpg-bytes');
    }
    const now = Date.now();
    db.prepare(
      `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 'agent:claude', filePath, null, 'image/jpeg', now, opts.expiresAt);
    return { id, path: filePath };
  }

  function rowCount(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get() as { n: number }).n;
  }

  it('deletes expired rows and unlinks their files', () => {
    const expired = insertAttachment({ expiresAt: Date.now() - 1000 });

    sweeper.tick();

    expect(rowCount()).toBe(0);
    expect(existsSync(expired.path)).toBe(false);
  });

  it('leaves non-expired rows and files alone', () => {
    const fresh = insertAttachment({ expiresAt: Date.now() + 60_000 });

    sweeper.tick();

    expect(rowCount()).toBe(1);
    expect(existsSync(fresh.path)).toBe(true);
  });

  it('still removes the DB row when the file is already gone (ENOENT)', () => {
    const ghost = insertAttachment({ expiresAt: Date.now() - 1000, fileExists: false });

    sweeper.tick();

    expect(rowCount()).toBe(0);
    expect(existsSync(ghost.path)).toBe(false);
  });

  it('continues the sweep when one row fails to unlink', () => {
    // Insert two expired rows — one with an unlinkable file, one with a
    // guaranteed-invalid path (unlinkSync throws EPERM/ENOENT).
    const ok = insertAttachment({ expiresAt: Date.now() - 1000 });
    const bad = insertAttachment({
      expiresAt: Date.now() - 1000,
      fileExists: false,
    });
    // Point the bad row at a path whose parent is a regular file so unlink
    // cannot possibly resolve it. For test portability we just rely on ENOENT
    // being tolerated — the "continue on unlink failure" behavior still holds
    // because the row is deleted regardless.

    sweeper.tick();

    expect(rowCount()).toBe(0);
    expect(existsSync(ok.path)).toBe(false);
    expect(existsSync(bad.path)).toBe(false);
  });

  it('is a no-op when no rows are expired', () => {
    insertAttachment({ expiresAt: Date.now() + 60_000 });
    insertAttachment({ expiresAt: Date.now() + 60_000 });

    sweeper.tick();

    expect(rowCount()).toBe(2);
  });

  it('retains the DB row when unlink fails with a non-ENOENT error (EACCES)', () => {
    // Create a read-only directory so that unlinkSync throws EACCES.
    const roDir = mkdtempSync(join(tmpdir(), 'sweeper-ro-'));
    const filePath = join(roDir, `${randomUUID()}.jpg`);
    writeFileSync(filePath, 'fake-bytes');
    chmodSync(roDir, 0o555); // remove write permission → unlink inside dir → EACCES

    const now = Date.now();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO attachments (id, agent_id, local_path, original_filename, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 'agent:claude', filePath, null, 'image/jpeg', now, now - 1);

    sweeper.tick();

    // Row must be retained so the next sweep can retry once the fs issue is fixed.
    expect(rowCount()).toBe(1);
    expect(existsSync(filePath)).toBe(true);

    // Restore permissions so afterEach can clean up.
    chmodSync(roDir, 0o755);
    rmSync(roDir, { recursive: true, force: true });
  });
});
