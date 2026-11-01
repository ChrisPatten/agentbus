import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { appendEvent, createPairCode, cursorNeedsReset, eventBounds, getSend, hashPairCode, normalizePairCode, putSend, readEvents, redeemPairCode, sweepEvents, sweepPairCodes } from './store.js';

let db: Database.Database;
function fresh() { db = new Database(':memory:'); runMigrations(db); return db; }
afterEach(() => db?.close());

describe('pairing codes', () => {
  it('stores only a sha256 hash and redeems exactly once', () => {
    fresh();
    const { code } = createPairCode(db, 'iphone', 60_000);
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const row = db.prepare('SELECT * FROM intercom_pair_codes').get() as { code_hash: string };
    expect(row.code_hash).toBe(hashPairCode(code));
    expect(JSON.stringify(row)).not.toContain(normalizePairCode(code));
    expect(redeemPairCode(db, code)).toEqual({ ok: true, surface_id: 'iphone' });
    expect(redeemPairCode(db, code)).toEqual({ ok: false, reason: 'used' });
  });
  it('accepts lowercase and unhyphenated input', () => {
    fresh();
    const { code } = createPairCode(db, 'iphone', 60_000);
    expect(redeemPairCode(db, code.toLowerCase().replace('-', ' '))).toEqual({ ok: true, surface_id: 'iphone' });
  });
  it('refuses unknown and expired codes', () => {
    fresh();
    expect(redeemPairCode(db, 'AAAAA-BBBBB')).toEqual({ ok: false, reason: 'unknown' });
    const { code } = createPairCode(db, 'iphone', 1000, 1_000_000);
    expect(redeemPairCode(db, code, 1_000_000 + 1001)).toEqual({ ok: false, reason: 'expired' });
  });
  it('sweeps codes spent or expired for more than a day', () => {
    fresh();
    createPairCode(db, 'iphone', 1000, 0);
    const { code } = createPairCode(db, 'iphone', 60_000, Date.now());
    expect(sweepPairCodes(db, Date.now())).toBe(1);
    expect(redeemPairCode(db, code).ok).toBe(true);
  });
});

describe('durable events', () => {
  it('numbers events per surface and replays after a cursor', () => {
    fresh();
    expect(appendEvent(db, 'a', 'reply', { n: 1 })).toBe(1);
    expect(appendEvent(db, 'a', 'reply', { n: 2 })).toBe(2);
    expect(appendEvent(db, 'b', 'reply', { n: 1 })).toBe(1);
    expect(readEvents(db, 'a', 1).map((e) => e.data['n'])).toEqual([2]);
    expect(readEvents(db, 'a', 0)).toHaveLength(2);
    expect(eventBounds(db, 'a')).toEqual({ first: 1, latest: 2 });
  });
  it('flags a cursor outside retention or ahead of the log as a reset, and keeps counting after a sweep', () => {
    fresh();
    for (let i = 0; i < 3; i++) appendEvent(db, 'a', 'reply', { i });
    db.prepare(`UPDATE intercom_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE seq < 3`).run();
    expect(sweepEvents(db, 7)).toBe(2);
    expect(eventBounds(db, 'a')).toEqual({ first: 3, latest: 3 });
    expect(cursorNeedsReset(db, 'a', 0)).toBe(false);
    expect(cursorNeedsReset(db, 'a', 1)).toBe(true);
    expect(cursorNeedsReset(db, 'a', 2)).toBe(false);
    expect(cursorNeedsReset(db, 'a', 3)).toBe(false);
    expect(cursorNeedsReset(db, 'a', 9)).toBe(true);
    db.prepare('DELETE FROM intercom_events').run();
    expect(appendEvent(db, 'a', 'reply', {})).toBe(4);                 // the counter survives retention
  });
});

describe('send idempotency', () => {
  it('returns the stored ack', () => {
    fresh();
    expect(getSend(db, 'a', 'c1')).toBeNull();
    putSend(db, 'a', 'c1', 'm1', { type: 'ack', status: 'queued' });
    expect(getSend(db, 'a', 'c1')).toEqual({ type: 'ack', status: 'queued' });
  });
});
