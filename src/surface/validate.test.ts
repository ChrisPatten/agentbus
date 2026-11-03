import { describe, expect, it } from 'vitest';
import { BoundsError, BOUNDS } from './types.js';
import { DEFAULT_EVENT_TTL_MS, validateEvent, validateSlot, validateWidget } from './validate.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const ctx = { follow: { contact: 'chris', channel: 'telegram:peggy' }, source: 'agent:peggy', now: NOW };
const iso = (ms: number) => new Date(ms).toISOString();
const err = (fn: () => unknown) => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(BoundsError); return (e as Error).message; }
  throw new Error('expected a BoundsError');
};

describe('validateEvent', () => {
  it('builds an event with defaults and one job per action aimed at the follow target', () => {
    const { event, jobs } = validateEvent({
      id: 'train', title: '  Train in 10 min ', actions: [{ id: 'here', label: "I'm here", run: { body: 'Chris tapped I am here' } }],
    }, ctx);
    expect(event).toEqual({
      id: 'train', kind: 'event', title: 'Train in 10 min', level: 'info', expires_at: iso(NOW + DEFAULT_EVENT_TTL_MS),
      actions: [{ id: 'here', label: "I'm here", once: true }], source: 'agent:peggy', created_at: iso(NOW), updated_at: iso(NOW),
    });
    expect(jobs).toEqual([{
      action_id: 'here', channel: 'telegram:peggy', sender: 'contact:chris', topic: 'general', payload_body: 'Chris tapped I am here',
      sends_on_behalf: false, confirm_draft: null, once: true, expires_at: iso(NOW + DEFAULT_EVENT_TTL_MS),
    }]);
  });

  it('keeps the follow topic, confirm drafts and explicit expiry on the jobs', () => {
    const exp = iso(NOW + 3600_000);
    const { event, jobs } = validateEvent({
      id: 'late', title: 'Running late?', level: 'attention', expires_at: exp, at: iso(NOW + 600_000),
      actions: [{ id: 'send', label: 'Tell Sam', style: 'primary', once: false, confirm: { draft: 'Running 10 min late', prompt: 'Send to Sam?' }, run: { body: 'send it', sends_on_behalf: true } }],
    }, { ...ctx, follow: { contact: 'contact:chris', channel: 'telegram:group', topic: 'thread:abc' } });
    expect(event.expires_at).toBe(exp);
    expect(event.actions[0]).toEqual({ id: 'send', label: 'Tell Sam', style: 'primary', confirm: { draft: 'Running 10 min late', prompt: 'Send to Sam?' }, once: false });
    expect(jobs[0]).toMatchObject({ sender: 'contact:chris', topic: 'thread:abc', sends_on_behalf: true, confirm_draft: 'Running 10 min late', once: false, expires_at: exp });
  });

  it('rejects sends_on_behalf without a confirm draft', () => {
    expect(err(() => validateEvent({ id: 'x', title: 't', actions: [{ id: 'a', label: 'Go', run: { body: 'b', sends_on_behalf: true } }] }, ctx)))
      .toMatch(/actions\[0\].*confirm\.draft is required/);
  });

  it('gives readable bound messages', () => {
    expect(err(() => validateEvent({ id: 'x', title: 'a'.repeat(112) }, ctx))).toBe('title is 112 characters; the limit is 80');
    expect(err(() => validateEvent({ id: 'x', title: 't', body: 'b'.repeat(BOUNDS.body + 1) }, ctx))).toMatch(/body is 501 characters; the limit is 500/);
    expect(err(() => validateEvent({ id: 'Bad Id', title: 't' }, ctx))).toMatch(/id "Bad Id" is invalid/);
    const four = [1, 2, 3, 4].map((i) => ({ id: `a${i}`, label: 'x', run: { body: 'b' } }));
    expect(err(() => validateEvent({ id: 'x', title: 't', actions: four }, ctx))).toBe('actions has 4 buttons; the limit is 3');
    expect(err(() => validateEvent({ id: 'x', title: 't', actions: [{ id: 'a', label: 'x'.repeat(25), run: { body: 'b' } }] }, ctx))).toBe('actions[0].label is 25 characters; the limit is 24');
    expect(err(() => validateEvent({ id: 'x', title: 't', actions: [{ id: 'a', label: 'x' }] }, ctx))).toMatch(/actions\[0\]\.run is required/);
    const dup = [{ id: 'a', label: 'x', run: { body: 'b' } }, { id: 'a', label: 'y', run: { body: 'b' } }];
    expect(err(() => validateEvent({ id: 'x', title: 't', actions: dup }, ctx))).toMatch(/used twice/);
  });

  it('checks expires_at, at and end', () => {
    expect(err(() => validateEvent({ id: 'x', title: 't', expires_at: iso(NOW - 1) }, ctx))).toMatch(/not in the future/);
    expect(err(() => validateEvent({ id: 'x', title: 't', expires_at: iso(NOW + 15 * 86_400_000) }, ctx))).toMatch(/more than 14 days ahead/);
    expect(err(() => validateEvent({ id: 'x', title: 't', expires_at: 'tomorrow' }, ctx))).toMatch(/not a valid ISO 8601 time/);
    expect(err(() => validateEvent({ id: 'x', title: 't', at: iso(NOW + 2000), end: iso(NOW + 1000) }, ctx))).toBe('end is before at');
    expect(validateEvent({ id: 'x', title: 't', expires_at: iso(NOW + 14 * 86_400_000) }, ctx).event.expires_at).toBe(iso(NOW + 14 * 86_400_000));
  });

  it('refuses approvals (bus only)', () => {
    expect(err(() => validateEvent({ id: 'x', kind: 'approval', title: 't' }, ctx))).toMatch(/bus only/);
  });
});

describe('validateSlot', () => {
  const sctx = { source: 'agent:peggy', now: NOW };
  it('builds a slot', () => {
    expect(validateSlot({ id: 'status', text: 'At the dentist', icon: 'tooth', color: '#ffaa00', until: iso(NOW + 3600_000) }, sctx))
      .toEqual({ id: 'status', text: 'At the dentist', icon: 'tooth', color: '#ffaa00', until: iso(NOW + 3600_000), source: 'agent:peggy', updated_at: iso(NOW) });
  });
  it('requires a future until at most 24 hours ahead', () => {
    expect(err(() => validateSlot({ id: 's', text: 'x' }, sctx))).toMatch(/until is required/);
    expect(err(() => validateSlot({ id: 's', text: 'x', until: iso(NOW) }, sctx))).toMatch(/not in the future/);
    expect(err(() => validateSlot({ id: 's', text: 'x', until: iso(NOW + 25 * 3600_000) }, sctx))).toMatch(/more than 24 hours ahead/);
    expect(err(() => validateSlot({ id: 's', text: 'x'.repeat(61), until: iso(NOW + 1000) }, sctx))).toBe('text is 61 characters; the limit is 60');
    expect(err(() => validateSlot({ id: 's', text: 'x', color: 'rgb(1,2,3)', until: iso(NOW + 1000) }, sctx))).toMatch(/color/);
  });
});

describe('validateWidget', () => {
  const wctx = { source: 'agent:peggy', now: NOW };
  it('builds a widget', () => {
    expect(validateWidget({ id: 'wx', type: 'weather', data: { temp: 12 } }, wctx)).toEqual({ id: 'wx', type: 'weather', data: { temp: 12 }, source: 'agent:peggy', updated_at: iso(NOW) });
  });
  it('checks type, data shape and size', () => {
    expect(err(() => validateWidget({ id: 'wx', type: 'Weather!', data: {} }, wctx))).toMatch(/type "Weather!" is invalid/);
    expect(err(() => validateWidget({ id: 'wx', type: 'weather', data: [1] }, wctx))).toBe('data must be a JSON object');
    expect(err(() => validateWidget({ id: 'wx', type: 'weather', data: { s: 'x'.repeat(5000) } }, wctx))).toMatch(/bytes as JSON; the limit is 4096/);
  });
});
