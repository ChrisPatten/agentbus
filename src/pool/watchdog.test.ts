import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { LeaseStore } from './lease-store.js';
import { IncidentStore } from './watchdog-store.js';
import { PaneWatchdog } from './watchdog.js';
import { resolveWatchdogConfig } from './watchdog-config.js';
import type { TmuxController } from './tmux.js';
import type { PoolLeaseRow } from './types.js';

const MIN = 60_000;

function setup(opts: { unhandled?: () => string | null } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const leaseStore = new LeaseStore(db);
  leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:1', agentId: 'agent:peggy-pool-1' }]);
  const incidentStore = new IncidentStore(db);
  let nowMs = Date.parse('2026-01-01T00:00:00Z');
  let screen = 'screen A';
  let captureFails = false;
  const calls: string[] = [];
  const tmux = {
    capturePane: vi.fn(async () => {
      if (captureFails) throw new Error('tmux gone');
      return screen;
    }),
    sendKeys: vi.fn(async () => { calls.push('sendKeys'); }),
    sendCommand: vi.fn(async () => { calls.push('sendCommand'); }),
    killWindow: vi.fn(async () => { calls.push('killWindow'); }),
  } as unknown as TmuxController;
  let unhandled: string | null = opts.unhandled ? opts.unhandled() : new Date(nowMs - 10 * MIN).toISOString();
  const getUnhandledSince = vi.fn((_db: Database.Database, _row: PoolLeaseRow) => unhandled);
  const wd = new PaneWatchdog({
    poolId: 'peggy',
    leaseStore,
    tmux,
    db,
    incidentStore,
    cfg: resolveWatchdogConfig({ stall_after_ms: 5 * MIN }),
    now: () => new Date(nowMs),
    getUnhandledSince,
  });
  const lease = () => {
    db.prepare(
      `UPDATE pool_leases SET state='leased', conversation_id='c1' WHERE pool_id='peggy' AND pane_id='peggy-pool:1'`,
    ).run();
  };
  return {
    db, wd, leaseStore, incidentStore, tmux, calls, lease,
    advance: (ms: number) => { nowMs += ms; },
    setScreen: (s: string) => { screen = s; },
    setUnhandled: (u: string | null) => { unhandled = u; },
    setCaptureFails: (f: boolean) => { captureFails = f; },
    nowIso: () => new Date(nowMs).toISOString(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('PaneWatchdog', () => {
  it('records one incident for a static screen with old unhandled work, and never presses keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.lease();
    await t.wd.sampleOnce(); // first observation
    expect(t.incidentStore.list()).toHaveLength(0);
    t.advance(5 * MIN);
    await t.wd.sampleOnce();
    const rows = t.incidentStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.class).toBe('unknown_blocked');
    expect(rows[0]!.screen_snapshot).toBe('screen A');
    expect(rows[0]!.conversation_id).toBe('c1');
    expect(rows[0]!.unhandled_since).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(t.wd.stallFor('peggy-pool:1')?.class).toBe('unknown_blocked');

    t.advance(MIN);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(t.calls).toEqual([]);
    expect(t.tmux.sendKeys).not.toHaveBeenCalled();
    expect(t.tmux.sendCommand).not.toHaveBeenCalled();
    expect(t.tmux.killWindow).not.toHaveBeenCalled();
  });

  it('does not match an idle pane (no unhandled work)', async () => {
    const t = setup();
    t.lease();
    t.setUnhandled(null);
    await t.wd.sampleOnce();
    t.advance(30 * MIN);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(0);
  });

  it('does not match while the screen keeps changing', async () => {
    const t = setup();
    t.lease();
    for (let i = 0; i < 6; i++) {
      t.setScreen(`tick ${i}`);
      await t.wd.sampleOnce();
      t.advance(MIN);
    }
    expect(t.incidentStore.list()).toHaveLength(0);
  });

  it('does not match when unhandled work is younger than stall_after_ms', async () => {
    const t = setup();
    t.lease();
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    t.setUnhandled(new Date(Date.parse(t.nowIso()) - MIN).toISOString());
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(0);
  });

  it('defers to a pending E51 approval for the same pane only', async () => {
    const t = setup();
    t.lease();
    const ins = (agent: string, status: string) =>
      t.db
        .prepare(
          `INSERT INTO approval_requests (id, adapter_id, agent_id, contact_id, tool_name, summary, status, requested_at, expires_at)
           VALUES (?, 'cc-pool', ?, 'chris', 'Bash', 's', ?, ?, ?)`,
        )
        .run(`${agent}-${status}`, agent, status, t.nowIso(), t.nowIso());
    ins('peggy-pool-2', 'pending'); // other pane: irrelevant
    ins('peggy-pool-1', 'expired'); // not pending: irrelevant
    ins('peggy-pool-1', 'pending');
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(0);

    t.db.prepare(`UPDATE approval_requests SET status='expired' WHERE agent_id='peggy-pool-1'`).run();
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(1);
  });

  it('resolves as recovered when the screen changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.lease();
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    t.setScreen('screen B');
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()[0]!.resolution).toBe('recovered');
    expect(t.wd.stallFor('peggy-pool:1')).toBeNull();
  });

  it('resolves as recovered when the turn ends (no unhandled work)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.lease();
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    t.setUnhandled(null);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()[0]!.resolution).toBe('recovered');
  });

  it('resolves as released when the lease is freed or the conversation changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.lease();
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    t.leaseStore.release('peggy', 'peggy-pool:1');
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()[0]!.resolution).toBe('released');

    // conversation change on a still-leased pane
    t.lease();
    t.advance(MIN);
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list({ open: true })).toHaveLength(1);
    t.db.prepare(`UPDATE pool_leases SET conversation_id='c2'`).run();
    await t.wd.sampleOnce();
    const rows = t.incidentStore.list();
    expect(rows.filter((r) => r.resolution === 'released')).toHaveLength(2);
  });

  it('capture failure skips the pane without resetting screen_changed_at', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.lease();
    await t.wd.sampleOnce();
    t.advance(3 * MIN);
    t.setCaptureFails(true);
    await t.wd.sampleOnce();
    t.advance(3 * MIN);
    t.setCaptureFails(false);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list()).toHaveLength(1);
  });

  it('an error on one pane does not abort the pass', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.leaseStore.seedPanes('peggy', [{ paneId: 'peggy-pool:2', agentId: 'agent:peggy-pool-2' }]);
    t.db.prepare(`UPDATE pool_leases SET state='leased', conversation_id='c1'`).run();
    (t.tmux.capturePane as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === 'peggy-pool:1') throw new Error('boom');
      return 'ok';
    });
    await t.wd.sampleOnce();
    t.advance(6 * MIN);
    await t.wd.sampleOnce();
    expect(t.incidentStore.list().map((r) => r.pane_id)).toEqual(['peggy-pool:2']);
  });

  it('start is a no-op when disabled, idempotent, and stop clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.lease();
      const mk = (enabled: boolean) =>
        new PaneWatchdog({
          poolId: 'peggy', leaseStore: t.leaseStore, tmux: t.tmux, db: t.db, incidentStore: t.incidentStore,
          cfg: resolveWatchdogConfig({ enabled, sample_interval_ms: 1000 }),
          getUnhandledSince: () => null,
        });
      const off = mk(false);
      off.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(t.tmux.capturePane).not.toHaveBeenCalled();

      const on = mk(true);
      on.start();
      on.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.tmux.capturePane).toHaveBeenCalledTimes(1);
      on.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(t.tmux.capturePane).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
