/**
 * E96 S96.1 — surface and device registry.
 *
 * Surfaces are mirrored from `adapters.intercom.surfaces` into `surfaces`. Each device
 * paired to a surface has its own credential (`sdc_` + 32 random bytes, base64url); only
 * its sha256 is stored. A surface's pre-E96 shared `token_env` token becomes its `legacy`
 * device (`<surface>-legacy`), so a client paired before E96 keeps working.
 *
 * Pairing codes: v2 codes live in `surface_pair_codes` (name, profile, scope); v1 codes in
 * `intercom_pair_codes` are still redeemable and create a device with the surface defaults.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generatePairCode, hashPairCode } from '../intercom/store.js';
import type { Device, DeviceScope, DeviceStore, PairResult, SurfaceRow } from './types.js';

export const CREDENTIAL_PREFIX = 'sdc_';
export const DEFAULT_MAX_DEVICES = 10;
const LEGACY_MIN_LENGTH = 32;
const MAX_CREDENTIAL_LENGTH = 512;
const TOUCH_THROTTLE_MS = 60_000;
const DAY_MS = 86_400_000;

export type SyncSurface = Parameters<DeviceStore['syncFromConfig']>[0][number];

export interface SyncOptions {
  /**
   * Create, rotate and revoke legacy devices from `token_env` (default true). The pairing
   * CLI passes false: it runs without the bus's env, and an absent token there must not
   * revoke anything.
   */
  legacy?: boolean;
}

export type RedeemOutcome = ReturnType<DeviceStore['redeem']>;

/** The S96.1 store: the {@link DeviceStore} contract plus housekeeping. */
export interface SurfaceDeviceStore extends DeviceStore {
  syncFromConfig(surfaces: SyncSurface[], env: NodeJS.ProcessEnv, opts?: SyncOptions): void;
  /** Delete v2 pairing codes spent or expired more than a day ago (v1 codes: `sweepPairCodes` in intercom/store). */
  sweepPairCodes(): number;
}

export interface DeviceStoreDeps {
  db: Database.Database;
  now?: () => number;
  log?: (line: string) => void;
  /** Overrides the per-surface limit (otherwise `max_devices` from the last sync, default 10). */
  maxDevices?: (surfaceId: string) => number;
}

interface DeviceRow {
  id: string; surface_id: string; name: string; profile: string; scope: DeviceScope;
  credential_hash: string; legacy: number; created_at: string; last_seen_at: string | null; revoked_at: string | null;
}
interface SurfaceDbRow { id: string; profile: string; follow: string; created_at: string; updated_at: string }
interface CodeRow { id: number; surface_id: string; expires_at: string; used_at: string | null; name?: string; profile?: string; scope?: string }

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A fresh device credential: `sdc_` + 32 random bytes, base64url. */
export function generateCredential(): string {
  return CREDENTIAL_PREFIX + randomBytes(32).toString('base64url');
}

export const legacyDeviceId = (surfaceId: string): string => `${surfaceId}-legacy`;

const toDevice = (r: DeviceRow): Device => ({
  id: r.id, surface_id: r.surface_id, name: r.name, profile: r.profile, scope: r.scope,
  legacy: r.legacy === 1, created_at: r.created_at, last_seen_at: r.last_seen_at, revoked_at: r.revoked_at,
});

const toSurface = (r: SurfaceDbRow): SurfaceRow => ({
  id: r.id, profile: r.profile, follow: JSON.parse(r.follow) as SurfaceRow['follow'], created_at: r.created_at, updated_at: r.updated_at,
});

const isScope = (s: unknown): s is DeviceScope => s === 'interactive' || s === 'read_only';

export function createDeviceStore(deps: DeviceStoreDeps): SurfaceDeviceStore {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const log = deps.log ?? ((l: string) => console.log(`[surface] ${l}`));
  const configuredMax = new Map<string, number>();
  const lastTouch = new Map<string, number>();

  const maxFor = (surfaceId: string) => deps.maxDevices?.(surfaceId) ?? configuredMax.get(surfaceId) ?? DEFAULT_MAX_DEVICES;

  const q = {
    surface: db.prepare(`SELECT * FROM surfaces WHERE id = ?`),
    surfaceIds: db.prepare(`SELECT id FROM surfaces`),
    upsertSurface: db.prepare(`INSERT INTO surfaces(id, profile, follow, created_at, updated_at) VALUES (@id, @profile, @follow, @at, @at)
      ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, follow = excluded.follow, updated_at = excluded.updated_at
      WHERE surfaces.profile IS NOT excluded.profile OR surfaces.follow IS NOT excluded.follow`),
    deleteSurface: db.prepare(`DELETE FROM surfaces WHERE id = ?`),
    device: db.prepare(`SELECT * FROM surface_devices WHERE id = ?`),
    deviceByHash: db.prepare(`SELECT d.* FROM surface_devices d JOIN surfaces s ON s.id = d.surface_id
      WHERE d.credential_hash = ? AND d.revoked_at IS NULL`),
    deviceIdByHash: db.prepare(`SELECT id FROM surface_devices WHERE credential_hash = ?`),
    activeCount:db.prepare(`SELECT COUNT(*) AS n FROM surface_devices WHERE surface_id = ? AND revoked_at IS NULL`),
    insertDevice: db.prepare(`INSERT INTO surface_devices(id, surface_id, name, profile, scope, credential_hash, legacy, created_at)
      VALUES (@id, @surface_id, @name, @profile, @scope, @credential_hash, @legacy, @created_at)`),
    upsertLegacy: db.prepare(`INSERT INTO surface_devices(id, surface_id, name, profile, scope, credential_hash, legacy, created_at)
      VALUES (@id, @surface_id, 'legacy token', @profile, 'interactive', @credential_hash, 1, @created_at)
      ON CONFLICT(id) DO UPDATE SET credential_hash = excluded.credential_hash, profile = excluded.profile, revoked_at = NULL`),
    revokeLegacy: db.prepare(`UPDATE surface_devices SET revoked_at = ? WHERE id = ? AND legacy = 1 AND revoked_at IS NULL`),
    revoke: db.prepare(`UPDATE surface_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`),
    touch: db.prepare(`UPDATE surface_devices SET last_seen_at = ? WHERE id = ?`),
    v2Code: db.prepare(`SELECT id, surface_id, expires_at, used_at, name, profile, scope FROM surface_pair_codes WHERE code_hash = ?`),
    v1Code: db.prepare(`SELECT id, surface_id, expires_at, used_at FROM intercom_pair_codes WHERE code_hash = ?`),
    flipV2: db.prepare(`UPDATE surface_pair_codes SET used_at = ?, device_id = ? WHERE id = ? AND used_at IS NULL`),
    flipV1: db.prepare(`UPDATE intercom_pair_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`),
    insertCode: db.prepare(`INSERT INTO surface_pair_codes(surface_id, code_hash, name, profile, scope, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?)`),
    sweep: db.prepare(`DELETE FROM surface_pair_codes WHERE expires_at < ? OR used_at < ?`),
  };

  function surface(id: string): SurfaceRow | null {
    const row = q.surface.get(id) as SurfaceDbRow | undefined;
    return row ? toSurface(row) : null;
  }

  function syncLegacy(s: SyncSurface, env: NodeJS.ProcessEnv): void {
    const id = legacyDeviceId(s.id);
    const token = s.token_env ? env[s.token_env] : undefined;
    if (!token || token.length < LEGACY_MIN_LENGTH) {
      if (s.token_env) log(`warn: surface "${s.id}" legacy token unused: env ${s.token_env} is ${token ? `shorter than ${LEGACY_MIN_LENGTH} characters` : 'not set'}`);
      if (q.revokeLegacy.run(iso(), id).changes > 0) log(`surface "${s.id}": legacy device revoked (no usable token_env)`);
      return;
    }
    const hash = sha256Hex(token);
    const existing = q.device.get(id) as DeviceRow | undefined;
    if (existing && existing.legacy !== 1) {
      log(`warn: surface "${s.id}": device id ${id} is taken by a paired device; legacy token not installed`);
      return;
    }
    if (existing && existing.credential_hash === hash && existing.revoked_at === null && existing.profile === s.profile) return;
    const clash = q.deviceIdByHash.get(hash) as { id: string } | undefined;
    if (clash && clash.id !== id) {
      log(`warn: surface "${s.id}": the token in ${s.token_env} is already the credential of device ${clash.id}; legacy token not installed`);
      return;
    }
    q.upsertLegacy.run({ id, surface_id: s.id, profile: s.profile, credential_hash: hash, created_at: iso() });
    if (existing && existing.credential_hash !== hash) log(`surface "${s.id}": legacy token rotated`);
    else if (!existing) log(`surface "${s.id}": legacy device created from ${s.token_env}`);
  }

  function syncFromConfig(surfaces: SyncSurface[], env: NodeJS.ProcessEnv, opts: SyncOptions = {}): void {
    const at = iso();
    db.transaction(() => {
      const keep = new Set<string>();
      configuredMax.clear();
      for (const s of surfaces) {
        keep.add(s.id);
        if (s.max_devices !== undefined) configuredMax.set(s.id, s.max_devices);
        const follow: SurfaceRow['follow'] = { contact: s.follow.contact, channel: s.follow.channel, ...(s.follow.topic !== undefined ? { topic: s.follow.topic } : {}) };
        q.upsertSurface.run({ id: s.id, profile: s.profile, follow: JSON.stringify(follow), at });
        if (opts.legacy !== false) syncLegacy(s, env);
      }
      for (const { id } of q.surfaceIds.all() as { id: string }[]) {
        if (keep.has(id)) continue;
        q.deleteSurface.run(id);
        log(`surface "${id}" removed from config; its devices no longer authenticate`);
      }
    })();
  }

  function authenticate(credential: string | undefined): Device | null {
    if (!credential || credential.length > MAX_CREDENTIAL_LENGTH) return null;
    const hash = sha256Hex(credential);
    const row = q.deviceByHash.get(hash) as DeviceRow | undefined;
    if (!row) return null;
    return timingSafeEqual(Buffer.from(row.credential_hash), Buffer.from(hash)) ? toDevice(row) : null;
  }

  function createPairCode(input: { surfaceId: string; name: string; profile?: string; scope?: DeviceScope; ttlMs: number }): { code: string; expires_at: string } {
    const s = surface(input.surfaceId);
    if (!s) throw new Error(`Unknown surface "${input.surfaceId}"`);
    const name = input.name.trim();
    if (!name || name.length > 64) throw new Error('Device name must be 1-64 characters');
    const scope = input.scope ?? 'interactive';
    if (!isScope(scope)) throw new Error(`Bad scope "${String(scope)}" (interactive or read_only)`);
    const profile = input.profile?.trim() || s.profile;
    if (!(input.ttlMs > 0)) throw new Error('ttlMs must be positive');
    const code = generatePairCode();
    const t = now();
    const expiresAt = new Date(t + input.ttlMs).toISOString();
    q.insertCode.run(input.surfaceId, hashPairCode(code), name, profile, scope, new Date(t).toISOString(), expiresAt);
    return { code, expires_at: expiresAt };
  }

  function redeem(code: string, certFingerprint: string | null): RedeemOutcome {
    const hash = hashPairCode(code);
    // IMMEDIATE: take the write lock before reading, so a second process (or request) waits and then sees `used`.
    return db.transaction((): RedeemOutcome => {
      const v2 = q.v2Code.get(hash) as CodeRow | undefined;
      const row = v2 ?? (q.v1Code.get(hash) as CodeRow | undefined);
      if (!row) return { ok: false, reason: 'unknown' };
      if (row.used_at) return { ok: false, reason: 'used' };
      const t = now();
      if (Date.parse(row.expires_at) <= t) return { ok: false, reason: 'expired' };
      const s = surface(row.surface_id);
      if (!s) return { ok: false, reason: 'surface_unavailable' };
      const { n } = q.activeCount.get(s.id) as { n: number };
      if (n >= maxFor(s.id)) return { ok: false, reason: 'device_limit' };

      const at = new Date(t).toISOString();
      const deviceId = `${s.id}-${randomBytes(4).toString('hex')}`;
      const flipped = v2 ? q.flipV2.run(at, deviceId, row.id) : q.flipV1.run(at, row.id);
      if (flipped.changes !== 1) return { ok: false, reason: 'used' };

      const credential = generateCredential();
      const scope: DeviceScope = v2 && isScope(row.scope) ? row.scope : 'interactive';
      const dev: DeviceRow = {
        id: deviceId, surface_id: s.id,
        name: v2 ? row.name! : `paired ${at.slice(0, 10)}`,
        profile: v2 ? row.profile! : s.profile,
        scope, credential_hash: sha256Hex(credential), legacy: 0, created_at: at, last_seen_at: null, revoked_at: null,
      };
      q.insertDevice.run({ id: dev.id, surface_id: dev.surface_id, name: dev.name, profile: dev.profile, scope: dev.scope, credential_hash: dev.credential_hash, legacy: 0, created_at: at });
      const result: PairResult = {
        surface_id: s.id, device_id: dev.id, credential, token: credential,
        scope: dev.scope, profile: dev.profile, cert_fingerprint: certFingerprint,
      };
      return { ok: true, result, device: toDevice(dev) };
    }).immediate();
  }

  function list(surfaceId?: string, includeRevoked = false): Device[] {
    const where: string[] = [];
    const params: string[] = [];
    if (surfaceId !== undefined) { where.push('surface_id = ?'); params.push(surfaceId); }
    if (!includeRevoked) where.push('revoked_at IS NULL');
    const sql = `SELECT * FROM surface_devices${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY surface_id, created_at, id`;
    return (db.prepare(sql).all(...params) as DeviceRow[]).map(toDevice);
  }

  function get(deviceId: string): Device | null {
    const row = q.device.get(deviceId) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  function revoke(deviceId: string): Device | null {
    const at = iso();
    if (q.revoke.run(at, deviceId).changes !== 1) return null;
    lastTouch.delete(deviceId);
    return get(deviceId);
  }

  function touch(deviceId: string): void {
    const t = now();
    const prev = lastTouch.get(deviceId);
    if (prev !== undefined && t - prev < TOUCH_THROTTLE_MS) return;
    lastTouch.set(deviceId, t);
    q.touch.run(new Date(t).toISOString(), deviceId);
  }

  function sweepPairCodes(): number {
    // Keep spent and expired codes a day so a retried request still gets 410, not 404.
    const cutoff = new Date(now() - DAY_MS).toISOString();
    return q.sweep.run(cutoff, cutoff).changes;
  }

  return { syncFromConfig, surface, authenticate, createPairCode, redeem, list, get, revoke, touch, sweepPairCodes };
}
