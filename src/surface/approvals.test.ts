import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ApprovalStore } from '../approvals/store.js';
import type { ResolveApprovalDeps } from '../approvals/resolve.js';
import { BOUNDS, type ResourceOp, type ResourceSnapshot } from './types.js';
import {
  approvalDetail, approvalEventsFor, approvalIdFromEvent, resolveApprovalFromSurface, syncApprovalEvents,
} from './approvals.js';

const NOW = new Date('2026-11-03T12:00:00Z');
const MIN = 60_000;

describe('approval events', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); store = new ApprovalStore(db); });

  const raise = (o: { summary?: string; context?: unknown; contact?: string; adapter?: string; tool?: string } = {}) =>
    store.insert({ adapterId: o.adapter ?? 'test', agentId: 'peggy-pool-1', contactId: o.contact ?? 'chris', toolName: o.tool ?? 'Bash',
      summary: o.summary ?? 'git push', context: o.context }, 15 * MIN, new Date(NOW.getTime() - MIN));

  it('maps a pending approval to an Approval event with the exact command', () => {
    const cmd = 'git push origin feat/e96 --force-with-lease';
    const r = raise({ summary: 'git push origin feat/e96…', context: { cwd: '/x', tool_input: { command: cmd } } });
    const [e] = approvalEventsFor(db, NOW);
    expect(e).toMatchObject({
      id: `approval-${r.id}`, kind: 'approval', level: 'attention', source: 'bus', expires_at: r.expires_at,
      title: 'Bash: git push origin feat/e96…',
      approval: { approval_id: r.id, tool: 'Bash', detail: cmd },
      actions: [{ id: 'approve', style: 'primary' }, { id: 'deny', style: 'destructive' }],
    });
    expect(e!.body).toContain('peggy-pool-1');
    expect(approvalIdFromEvent(`events:${e!.id}`)).toBe(r.id);
    expect(approvalIdFromEvent('events:train-1')).toBeNull();
  });

  it('prefers raw_context.details, falls back to the summary, and bounds what it cuts', () => {
    expect(approvalDetail({ raw_context: JSON.stringify({ details: 'diff…' }), summary: 's' })).toBe('diff…');
    expect(approvalDetail({ raw_context: null, summary: 'edit /a/b.ts' })).toBe('edit /a/b.ts');
    raise({ context: { tool_input: { command: 'y'.repeat(5000) } }, summary: 'z'.repeat(300) });
    const [e] = approvalEventsFor(db, NOW);
    expect(e!.approval!.detail.length).toBeLessThanOrEqual(BOUNDS.draft);
    expect(e!.approval!.detail).toMatch(/… \[\d+ more characters\]$/);
    expect(Array.from(e!.title)).toHaveLength(BOUNDS.title);
  });

  it('lists only pending, unexpired approvals for the contact', () => {
    raise({ contact: 'chris' });
    raise({ contact: 'contact:chris', summary: 'b' });
    raise({ contact: 'alice', summary: 'c' });
    const done = raise({ summary: 'd' });
    store.resolve(done.id, 'approved', 'contact:chris');
    expect(approvalEventsFor(db, NOW, { contactId: 'contact:chris' })).toHaveLength(2);
    expect(approvalEventsFor(db, NOW)).toHaveLength(3);
    expect(approvalEventsFor(db, new Date(NOW.getTime() + 30 * MIN))).toHaveLength(0);
  });

  it('syncApprovalEvents sets new ones, tombstones resolved ones (E100) and leaves agent events alone', () => {
    const items: ResourceSnapshot['items'] = { 'train-1': { id: 'train-1', kind: 'event' } };
    let rev = 0;
    const applied: ResourceOp[][] = [];
    const hub = {
      snapshot: () => ({ rev, items: { ...items } }),
      apply: (_s: string, _r: string, ops: ResourceOp[]) => {
        applied.push(ops);
        for (const op of ops) { if (op.op === 'remove') delete items[op.id]; else items[op.id] = op.value; }
        return ++rev;
      },
    };
    const r = raise();
    expect(syncApprovalEvents(hub, 's', db, { now: NOW })).toBe(1);
    expect(Object.keys(items).sort()).toEqual([`approval-${r.id}`, 'train-1']);
    expect(syncApprovalEvents(hub, 's', db, { now: NOW })).toBeNull();
    expect(items[`approval-${r.id}`]).toMatchObject({ weight: 'decision', state: 'open', actions: [{ id: 'approve', kind: 'hold' }, { id: 'deny', kind: 'hold' }] });
    store.resolve(r.id, 'denied', 'contact:chris');
    expect(syncApprovalEvents(hub, 's', db, { now: NOW })).toBe(2);
    expect(Object.keys(items).sort()).toEqual([`approval-${r.id}`, 'train-1']);
    expect(applied[1]).toEqual([{ op: 'set', id: `approval-${r.id}`, value: expect.objectContaining({ state: 'answered', ended_at: store.getById(r.id)!.resolved_at }) }]);
    // A tombstone is left alone by later syncs (the hub's sweep purges it).
    expect(syncApprovalEvents(hub, 's', db, { now: NOW })).toBeNull();
  });

  it('an approval that expired or vanished ends as expired or withdrawn', () => {
    const items: ResourceSnapshot['items'] = {};
    const hub = {
      snapshot: () => ({ rev: 0, items: { ...items } }),
      apply: (_s: string, _r: string, ops: ResourceOp[]) => { for (const op of ops) if (op.op === 'set') items[op.id] = op.value; return 1; },
    };
    const late = raise({ summary: 'late' });
    const gone = raise({ summary: 'gone' });
    syncApprovalEvents(hub, 's', db, { now: NOW });
    db.prepare('DELETE FROM approval_requests WHERE id = ?').run(gone.id);
    syncApprovalEvents(hub, 's', db, { now: new Date(NOW.getTime() + 30 * MIN) });
    expect(items[`approval-${late.id}`]).toMatchObject({ state: 'expired', ended_at: late.expires_at });
    expect(items[`approval-${gone.id}`]).toMatchObject({ state: 'withdrawn' });
  });
});

describe('resolveApprovalFromSurface (real approvals store and resolveApproval)', () => {
  let db: Database.Database;
  let store: ApprovalStore;
  let backend: ReturnType<typeof vi.fn>;
  let onResolved: ReturnType<typeof vi.fn>;
  let deps: ResolveApprovalDeps;
  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db); store = new ApprovalStore(db);
    backend = vi.fn(async (_r: unknown, d: string) => ({ result: 'resolved' as const, key: d === 'approve' ? 'Enter' : 'Escape' }));
    onResolved = vi.fn();
    deps = { store, poolManagers: new Map(), backends: { test: backend as never }, onResolved: onResolved as never };
  });
  const raise = (adapter = 'test', contact = 'chris') =>
    store.insert({ adapterId: adapter, agentId: 'peggy-pool-1', contactId: contact, toolName: 'Bash', summary: 'ls' }, 15 * MIN, NOW);

  it('approve round-trips: done, row approved by the device, backend and hooks ran once; a second tap is already_done', async () => {
    const r = raise();
    const out = await resolveApprovalFromSurface(deps, { approvalId: r.id, decision: 'approve', deviceId: 'dev1', contactId: 'chris', now: NOW });
    expect(out.status).toBe('done');
    expect(store.getById(r.id)).toMatchObject({ status: 'approved', resolved_by: 'device:dev1' });
    expect(JSON.parse(store.getById(r.id)!.raw_context!)).toMatchObject({ keys_sent: 'Enter' });
    expect(backend).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: r.id }), 'approved');
    expect((await resolveApprovalFromSurface(deps, { approvalId: r.id, decision: 'deny', deviceId: 'dev2', now: NOW })).status).toBe('already_done');
    expect(backend).toHaveBeenCalledTimes(1);
    expect(approvalEventsFor(db, NOW)).toHaveLength(0);
  });

  it('deny sends the deny decision', async () => {
    const r = raise();
    expect((await resolveApprovalFromSurface(deps, { approvalId: r.id, decision: 'deny', deviceId: 'd', now: NOW })).status).toBe('done');
    expect(store.getById(r.id)!.status).toBe('denied');
    expect(backend).toHaveBeenCalledWith(expect.anything(), 'deny');
  });

  it('expired, stale, unknown, other contact and invalid decision', async () => {
    const r1 = raise();
    expect(await resolveApprovalFromSurface(deps, { approvalId: r1.id, decision: 'approve', deviceId: 'd', now: new Date(NOW.getTime() + 20 * MIN) }))
      .toMatchObject({ status: 'expired' });
    expect((await resolveApprovalFromSurface(deps, { approvalId: r1.id, decision: 'approve', deviceId: 'd', now: NOW })).status).toBe('expired');
    const r2 = raise('cc-pool');
    expect(await resolveApprovalFromSurface(deps, { approvalId: r2.id, decision: 'approve', deviceId: 'd', now: NOW }))
      .toMatchObject({ status: 'failed', reason: expect.stringMatching(/^stale: /) });
    expect(await resolveApprovalFromSurface(deps, { approvalId: 'nope', decision: 'approve', deviceId: 'd', now: NOW }))
      .toEqual({ status: 'failed', reason: 'not_found' });
    const r3 = raise('test', 'alice');
    expect(await resolveApprovalFromSurface(deps, { approvalId: r3.id, decision: 'approve', deviceId: 'd', contactId: 'chris', now: NOW }))
      .toEqual({ status: 'failed', reason: 'not_found' });
    expect(store.getById(r3.id)!.status).toBe('pending');
    expect(await resolveApprovalFromSurface(deps, { approvalId: r3.id, decision: 'maybe', deviceId: 'd', now: NOW }))
      .toEqual({ status: 'failed', reason: 'invalid' });
  });
});
