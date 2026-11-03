import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { createPairCode as createV1Code } from '../intercom/store.js';
import { createDeviceStore, legacyDeviceId, sha256Hex, type SurfaceDeviceStore, type SyncSurface } from './devices.js';

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);
const FP = 'AA:BB:CC';

let db: Database.Database;
let clock = Date.parse('2026-11-03T12:00:00Z');
const logs: string[] = [];

function setup(opts: { maxDevices?: (id: string) => number } = {}): SurfaceDeviceStore {
  db = new Database(':memory:');
  runMigrations(db);
  logs.length = 0;
  clock = Date.parse('2026-11-03T12:00:00Z');
  return createDeviceStore({ db, now: () => clock, log: (l) => logs.push(l), ...opts });
}
afterEach(() => db?.close());

const kitchen = (extra: Partial<SyncSurface> = {}): SyncSurface => ({
  id: 'kitchen', profile: 'round466', follow: { contact: 'chris', channel: 'telegram' }, ...extra,
});

function pair(store: SurfaceDeviceStore, name: string, surfaceId = 'kitchen') {
  const { code } = store.createPairCode({ surfaceId, name, ttlMs: 60_000 });
  const res = store.redeem(code, FP);
  if (!res.ok) throw new Error(`redeem failed: ${res.reason}`);
  return res;
}

describe('syncFromConfig', () => {
  it('mirrors surfaces and removes the ones dropped from config', () => {
    const store = setup();
    store.syncFromConfig([kitchen({ follow: { contact: 'chris', channel: 'telegram', topic: 'home' } }), { ...kitchen(), id: 'desk', profile: 'rectangular' }], {});
    expect(store.surface('kitchen')).toMatchObject({ id: 'kitchen', profile: 'round466', follow: { contact: 'chris', channel: 'telegram', topic: 'home' } });
    expect(store.surface('desk')?.profile).toBe('rectangular');
    const dev = pair(store, 'Desk display', 'desk');
    expect(store.authenticate(dev.result.credential)?.id).toBe(dev.device.id);

    store.syncFromConfig([kitchen()], {});
    expect(store.surface('desk')).toBeNull();
    expect(store.authenticate(dev.result.credential)).toBeNull();
    expect(store.get(dev.device.id)).not.toBeNull(); // row kept
  });

  it('creates, rotates and revokes the legacy device from token_env, idempotently', () => {
    const store = setup();
    const cfg = [kitchen({ token_env: 'KITCHEN_TOKEN' })];
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: TOKEN_A });
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: TOKEN_A }); // restart
    const legacy = store.list('kitchen');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ id: legacyDeviceId('kitchen'), name: 'legacy token', legacy: true, scope: 'interactive', profile: 'round466', revoked_at: null });
    const row = db.prepare('SELECT credential_hash FROM surface_devices').get() as { credential_hash: string };
    expect(row.credential_hash).toBe(sha256Hex(TOKEN_A));
    expect(store.authenticate(TOKEN_A)?.id).toBe('kitchen-legacy');

    // Rotation: the new token works, the old one does not.
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: TOKEN_B });
    expect(store.authenticate(TOKEN_A)).toBeNull();
    expect(store.authenticate(TOKEN_B)?.id).toBe('kitchen-legacy');
    expect(store.list('kitchen', true)).toHaveLength(1);
    expect(logs.some((l) => l.includes('rotated'))).toBe(true);

    // Unset or short token: revoked.
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: 'short' });
    expect(store.authenticate(TOKEN_B)).toBeNull();
    expect(store.get('kitchen-legacy')?.revoked_at).not.toBeNull();
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('shorter than 32'))).toBe(true);

    // Token back: active again, still exactly one legacy device.
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: TOKEN_B });
    expect(store.authenticate(TOKEN_B)?.id).toBe('kitchen-legacy');
    expect(store.list('kitchen', true)).toHaveLength(1);

    // token_env removed from config: revoked.
    store.syncFromConfig([kitchen()], { KITCHEN_TOKEN: TOKEN_B });
    expect(store.authenticate(TOKEN_B)).toBeNull();
  });

  it('leaves legacy devices alone with { legacy: false } (the pairing CLI)', () => {
    const store = setup();
    const cfg = [kitchen({ token_env: 'KITCHEN_TOKEN' })];
    store.syncFromConfig(cfg, { KITCHEN_TOKEN: TOKEN_A });
    store.syncFromConfig(cfg, {}, { legacy: false });
    expect(store.authenticate(TOKEN_A)?.id).toBe('kitchen-legacy');
  });

  it('does not install one token as two surfaces\' legacy credential', () => {
    const store = setup();
    store.syncFromConfig([kitchen({ token_env: 'T' }), { ...kitchen({ token_env: 'T' }), id: 'desk' }], { T: TOKEN_A });
    expect(store.authenticate(TOKEN_A)?.surface_id).toBe('kitchen');
    expect(store.get('desk-legacy')).toBeNull();
    expect(logs.some((l) => l.includes('already the credential of device kitchen-legacy'))).toBe(true);
  });
});

describe('pairing and devices', () => {
  it('pairs two devices to one surface; revoking one leaves the other working', () => {
    const store = setup();
    store.syncFromConfig([kitchen()], {});
    const { code, expires_at } = store.createPairCode({ surfaceId: 'kitchen', name: 'Kitchen Compact', profile: 'compact', scope: 'read_only', ttlMs: 60_000 });
    expect(expires_at).toBe(new Date(clock + 60_000).toISOString());
    const one = store.redeem(code, FP);
    if (!one.ok) throw new Error(one.reason);
    expect(one.result).toMatchObject({ surface_id: 'kitchen', scope: 'read_only', profile: 'compact', cert_fingerprint: FP });
    expect(one.result.credential).toMatch(/^sdc_[A-Za-z0-9_-]{43}$/);
    expect(one.result.token).toBe(one.result.credential);
    expect(one.device).toMatchObject({ name: 'Kitchen Compact', legacy: false, scope: 'read_only' });

    const two = pair(store, 'Phone');
    expect(two.device.profile).toBe('round466'); // surface default
    expect(two.device.scope).toBe('interactive');

    // Only hashes are stored.
    const hashes = (db.prepare('SELECT credential_hash FROM surface_devices').all() as { credential_hash: string }[]).map((r) => r.credential_hash);
    expect(hashes).toContain(sha256Hex(one.result.credential));
    expect(JSON.stringify(db.prepare('SELECT * FROM surface_devices').all())).not.toContain(one.result.credential);
    const codeRow = db.prepare('SELECT device_id, used_at FROM surface_pair_codes WHERE device_id = ?').get(one.device.id) as { device_id: string; used_at: string };
    expect(codeRow.used_at).not.toBeNull();

    expect(store.list('kitchen').map((d) => d.id).sort()).toEqual([one.device.id, two.device.id].sort());

    const revoked = store.revoke(one.device.id);
    expect(revoked?.revoked_at).toBe(new Date(clock).toISOString());
    expect(store.revoke(one.device.id)).toBeNull();
    expect(store.revoke('nope')).toBeNull();
    expect(store.authenticate(one.result.credential)).toBeNull();
    expect(store.authenticate(two.result.credential)?.id).toBe(two.device.id);
    expect(store.list('kitchen').map((d) => d.id)).toEqual([two.device.id]);
    expect(store.list('kitchen', true)).toHaveLength(2);
    expect(store.list()).toHaveLength(1);
  });

  it('rejects junk credentials', () => {
    const store = setup();
    store.syncFromConfig([kitchen()], {});
    expect(store.authenticate(undefined)).toBeNull();
    expect(store.authenticate('')).toBeNull();
    expect(store.authenticate('sdc_nope')).toBeNull();
    expect(store.authenticate('x'.repeat(10_000))).toBeNull();
  });

  it('redeems a v1 intercom code into a device with surface defaults', () => {
    const store = setup();
    store.syncFromConfig([kitchen({ profile: 'round466' })], {});
    const { code } = createV1Code(db, 'kitchen', 60_000, clock);
    const res = store.redeem(code.toLowerCase(), null);
    if (!res.ok) throw new Error(res.reason);
    expect(res.device).toMatchObject({ surface_id: 'kitchen', name: 'paired 2026-11-03', profile: 'round466', scope: 'interactive', legacy: false });
    expect(res.result.cert_fingerprint).toBeNull();
    expect(store.authenticate(res.result.token)?.id).toBe(res.device.id);
    expect(store.redeem(code, null)).toEqual({ ok: false, reason: 'used' });
  });

  it('answers unknown, expired, used and surface_unavailable', () => {
    const store = setup();
    store.syncFromConfig([kitchen(), { ...kitchen(), id: 'desk' }], {});
    expect(store.redeem('AAAAA-BBBBB', null)).toEqual({ ok: false, reason: 'unknown' });

    const { code: expired } = store.createPairCode({ surfaceId: 'kitchen', name: 'x', ttlMs: 1000 });
    clock += 1001;
    expect(store.redeem(expired, null)).toEqual({ ok: false, reason: 'expired' });

    const { code: used } = store.createPairCode({ surfaceId: 'kitchen', name: 'x', ttlMs: 60_000 });
    expect(store.redeem(used, null).ok).toBe(true);
    expect(store.redeem(used, null)).toEqual({ ok: false, reason: 'used' });

    const { code: gone } = store.createPairCode({ surfaceId: 'desk', name: 'x', ttlMs: 60_000 });
    const { code: goneV1 } = createV1Code(db, 'desk', 60_000, clock);
    store.syncFromConfig([kitchen()], {});
    expect(store.redeem(gone, null)).toEqual({ ok: false, reason: 'surface_unavailable' });
    expect(store.redeem(goneV1, null)).toEqual({ ok: false, reason: 'surface_unavailable' });

    expect(() => store.createPairCode({ surfaceId: 'desk', name: 'x', ttlMs: 60_000 })).toThrow(/Unknown surface/);
    expect(() => store.createPairCode({ surfaceId: 'kitchen', name: '  ', ttlMs: 60_000 })).toThrow(/name/);
  });

  it('enforces max_devices (the legacy device counts) without spending the code', () => {
    const store = setup();
    store.syncFromConfig([kitchen({ token_env: 'T', max_devices: 2 })], { T: TOKEN_A });
    const first = pair(store, 'One');
    const { code } = store.createPairCode({ surfaceId: 'kitchen', name: 'Two', ttlMs: 60_000 });
    expect(store.redeem(code, null)).toEqual({ ok: false, reason: 'device_limit' });
    store.revoke(first.device.id);
    expect(store.redeem(code, null).ok).toBe(true); // same code still good after freeing a slot
  });

  it('takes the limit from the maxDevices option when given', () => {
    const store = setup({ maxDevices: () => 1 });
    store.syncFromConfig([kitchen({ max_devices: 10 })], {});
    pair(store, 'One');
    const { code } = store.createPairCode({ surfaceId: 'kitchen', name: 'Two', ttlMs: 60_000 });
    expect(store.redeem(code, null)).toEqual({ ok: false, reason: 'device_limit' });
  });

  it('lets exactly one of two racing redeems win', async () => {
    const store = setup();
    store.syncFromConfig([kitchen()], {});
    const { code } = store.createPairCode({ surfaceId: 'kitchen', name: 'Race', ttlMs: 60_000 });
    const results = await Promise.all([Promise.resolve().then(() => store.redeem(code, null)), Promise.resolve().then(() => store.redeem(code, null))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'used' }]);
    expect(store.list('kitchen')).toHaveLength(1);
  });

  it('lets exactly one of two stores (separate connections) win', () => {
    const dir = process.env['TMPDIR'] ?? '/tmp';
    const path = `${dir}/devices-race-${process.pid}-${Date.now()}.db`;
    const a = new Database(path); a.pragma('journal_mode = WAL'); runMigrations(a);
    const b = new Database(path); b.pragma('journal_mode = WAL'); b.pragma('busy_timeout = 2000');
    try {
      const sa = createDeviceStore({ db: a, log: () => {} });
      const sb = createDeviceStore({ db: b, log: () => {} });
      sa.syncFromConfig([kitchen()], {});
      const { code } = sa.createPairCode({ surfaceId: 'kitchen', name: 'Race', ttlMs: 60_000 });
      const r1 = sa.redeem(code, null);
      const r2 = sb.redeem(code, null);
      expect([r1.ok, r2.ok]).toEqual([true, false]);
      expect(r2).toEqual({ ok: false, reason: 'used' });
    } finally {
      a.close(); b.close();
    }
  });

  it('touch records last_seen_at at most once a minute per device', () => {
    const store = setup();
    store.syncFromConfig([kitchen()], {});
    const { device } = pair(store, 'One');
    store.touch(device.id);
    const first = store.get(device.id)!.last_seen_at;
    expect(first).toBe(new Date(clock).toISOString());
    clock += 30_000;
    store.touch(device.id);
    expect(store.get(device.id)!.last_seen_at).toBe(first);
    clock += 31_000;
    store.touch(device.id);
    expect(store.get(device.id)!.last_seen_at).toBe(new Date(clock).toISOString());
  });

  it('sweeps v2 codes spent or expired more than a day ago', () => {
    const store = setup();
    store.syncFromConfig([kitchen()], {});
    store.createPairCode({ surfaceId: 'kitchen', name: 'old', ttlMs: 1000 });
    const { code } = store.createPairCode({ surfaceId: 'kitchen', name: 'used', ttlMs: 3 * 86_400_000 });
    store.redeem(code, null);
    clock += 86_400_000 + 2000;
    const { code: fresh } = store.createPairCode({ surfaceId: 'kitchen', name: 'fresh', ttlMs: 60_000 });
    expect(store.sweepPairCodes()).toBe(2);
    expect(store.redeem(fresh, null).ok).toBe(true);
  });
});
