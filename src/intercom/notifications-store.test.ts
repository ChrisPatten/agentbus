import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import {
  NotifyInput, UpdateInput, acknowledgeNotification, attentionFor, expireDue, getNotification, listNotifications,
  sweepNotifications, updateNotification, upsertNotification,
} from './notifications-store.js';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const mk = (over: Record<string, unknown> = {}) => NotifyInput.parse({ title: 'Leave for the dentist', source: 'test', ...over });
const fresh = () => { const db = new Database(':memory:'); runMigrations(db); return db; };

describe('notifications store (E89)', () => {
  it('applies defaults and truncates title and body with an ellipsis', () => {
    const db = fresh();
    const { notification: n, created } = upsertNotification(db, mk({ title: 'T'.repeat(90), body: 'b'.repeat(400) }), T0);
    expect(created).toBe(true);
    expect(Array.from(n.title)).toHaveLength(60);
    expect(n.title.endsWith('…')).toBe(true);
    expect(Array.from(n.body!)).toHaveLength(280);
    expect(n).toMatchObject({ contact_id: 'chris', level: 'attention', state: 'active', targets: ['*'], actions: [], acked_by: null });
  });

  it('validates actions: at most 3, labels at most 24 characters', () => {
    expect(NotifyInput.safeParse({ title: 't', source: 's', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }).success).toBe(false);
    expect(NotifyInput.safeParse({ title: 't', source: 's', actions: [{ label: 'x'.repeat(25) }] }).success).toBe(false);
    expect(NotifyInput.safeParse({ title: 't', source: 's', actions: [{ label: 'Snooze 10', style: 'danger' }] }).success).toBe(true);
    expect(NotifyInput.safeParse({ title: 't' }).success).toBe(false);
    expect(NotifyInput.safeParse({ title: 't', source: 's', level: 'loud' }).success).toBe(false);
  });

  it('upserts by key while non-terminal: same row, reset to active, content change flagged', () => {
    const db = fresh();
    const a = upsertNotification(db, mk({ key: 'dentist', body: 'one' }), T0);
    acknowledgeNotification(db, a.notification.id, 'iphone', T0 + 1000);
    const same = upsertNotification(db, mk({ key: 'dentist', body: 'one' }), T0 + 2000);
    expect(same.created).toBe(false);
    expect(same.notification.id).toBe(a.notification.id);
    expect(same.notification).toMatchObject({ state: 'active', acked_by: null, created_at: a.notification.created_at });
    expect(same.contentChanged).toBe(false);
    const changed = upsertNotification(db, mk({ key: 'dentist', body: 'two', level: 'urgent' }), T0 + 3000);
    expect(changed.contentChanged).toBe(true);
    expect(changed.notification).toMatchObject({ body: 'two', level: 'urgent' });
    expect(listNotifications(db, 'all')).toHaveLength(1);
  });

  it('a resolved key starts a new row', () => {
    const db = fresh();
    const a = upsertNotification(db, mk({ key: 'k' }), T0);
    expect(updateNotification(db, UpdateInput.parse({ key: 'k', state: 'resolved' }), T0 + 1)).toMatchObject({ notification: { state: 'resolved' } });
    const b = upsertNotification(db, mk({ key: 'k' }), T0 + 2);
    expect(b.created).toBe(true);
    expect(b.notification.id).not.toBe(a.notification.id);
  });

  it('terminal states cannot be changed or acknowledged; unknown ids are not_found', () => {
    const db = fresh();
    const a = upsertNotification(db, mk(), T0).notification;
    updateNotification(db, UpdateInput.parse({ id: a.id, state: 'resolved' }), T0 + 1);
    expect(updateNotification(db, UpdateInput.parse({ id: a.id, title: 'again' }), T0 + 2)).toEqual({ error: 'terminal' });
    expect(acknowledgeNotification(db, a.id, 's', T0 + 3)).toBeNull();
    expect(updateNotification(db, UpdateInput.parse({ id: 'nope', title: 'x' }), T0)).toEqual({ error: 'not_found' });
    expect(updateNotification(db, UpdateInput.parse({ title: 'x' }), T0)).toEqual({ error: 'invalid' });
  });

  it('attention: highest level among active items for the surface; acknowledged and other-surface items do not count', () => {
    const db = fresh();
    expect(attentionFor(db, 's1')).toEqual({ level: 'none', count: 0 });
    upsertNotification(db, mk({ title: 'a', level: 'info' }), T0);
    upsertNotification(db, mk({ title: 'b', level: 'urgent', targets: ['s2'] }), T0);
    const c = upsertNotification(db, mk({ title: 'c', level: 'attention', targets: ['s1'] }), T0).notification;
    expect(attentionFor(db, 's1')).toEqual({ level: 'attention', count: 2 });
    expect(attentionFor(db, 's2')).toEqual({ level: 'urgent', count: 2 });
    acknowledgeNotification(db, c.id, 's1', T0);
    expect(attentionFor(db, 's1')).toEqual({ level: 'info', count: 1 });
  });

  it('expiry sweep marks due items expired; retention deletes old terminal rows only', () => {
    const db = fresh();
    const a = upsertNotification(db, mk({ title: 'a', expires_in_s: 60 }), T0).notification;
    upsertNotification(db, mk({ title: 'b', expires_in_s: 600 }), T0);
    expect(expireDue(db, T0 + 30_000)).toHaveLength(0);
    const out = expireDue(db, T0 + 61_000);
    expect(out.map((n) => n.id)).toEqual([a.id]);
    expect(getNotification(db, a.id)!.state).toBe('expired');
    expect(sweepNotifications(db, 14, T0 + 13 * 86_400_000)).toBe(0);
    expect(sweepNotifications(db, 14, T0 + 15 * 86_400_000)).toBe(1);
    expect(listNotifications(db, 'all')).toHaveLength(1); // b is still open
  });

  it('list filters by state', () => {
    const db = fresh();
    const a = upsertNotification(db, mk({ title: 'a' }), T0).notification;
    const b = upsertNotification(db, mk({ title: 'b' }), T0 + 1).notification;
    const c = upsertNotification(db, mk({ title: 'c' }), T0 + 2).notification;
    acknowledgeNotification(db, b.id, 's', T0 + 3);
    updateNotification(db, UpdateInput.parse({ id: c.id, state: 'resolved' }), T0 + 4);
    expect(listNotifications(db, 'active').map((n) => n.id)).toEqual([a.id]);
    expect(listNotifications(db, 'open').map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(listNotifications(db, 'all')).toHaveLength(3);
    expect(listNotifications(db, 'all', 2)).toHaveLength(2);
  });
});
