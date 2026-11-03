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

// ── Follow-on: event shape, slots, faces ────────────────────────────────────

import { checkRingCapacity, drawsOnRing, validateAction, validateFaceLayout } from './validate.js';

const ring = (extra: Record<string, unknown> = {}) => ({ id: 'dentist', title: 'Dentist', at: iso(NOW + 3600_000), end: iso(NOW + 7200_000), ...extra });

describe('validateEvent: ring shape', () => {
  it('accepts layer, color, travel, detail and opens/conversation_id and stores them normalised', () => {
    const { event } = validateEvent(ring({
      layer: 'overlap', color: '#D9822B', travel: { minutes: 20, mode: 'drive' },
      detail: { description: ' Cleaning ', location: '1 Main St', image: `asset:${'AB'.repeat(32)}` },
      opens: 'conversation', conversation_id: 'abc123',
    }), ctx);
    expect(event).toMatchObject({
      layer: 'overlap', color: '#d9822b', travel: { minutes: 20, mode: 'drive' },
      detail: { description: 'Cleaning', location: '1 Main St', image: 'ab'.repeat(32) }, opens: 'conversation', conversation_id: 'abc123',
    });
    expect(drawsOnRing(event)).toBe(true);
  });

  it('leaves the new fields out when not given (old shape unchanged)', () => {
    const { event } = validateEvent({ id: 'x', title: 't', at: iso(NOW + 1000) }, ctx);
    for (const k of ['layer', 'color', 'travel', 'detail', 'opens', 'conversation_id']) expect(event).not.toHaveProperty(k);
    expect(drawsOnRing(event)).toBe(false);
  });

  it('accepts palette names case-insensitively and rejects other colours', () => {
    expect(validateEvent(ring({ color: 'Orange' }), ctx).event.color).toBe('orange');
    expect(err(() => validateEvent(ring({ color: 'chartreuse' }), ctx))).toMatch(/color "chartreuse" is invalid/);
    expect(err(() => validateEvent(ring({ color: '#12' }), ctx))).toMatch(/color/);
    expect(err(() => validateEvent(ring({ color: 5 }), ctx))).toMatch(/color must be a string/);
  });

  it('validates layer, travel and opens', () => {
    expect(err(() => validateEvent(ring({ layer: 'top' }), ctx))).toMatch(/layer must be one of primary, overlap/);
    expect(err(() => validateEvent(ring({ travel: { minutes: 0 } }), ctx))).toMatch(/travel.minutes/);
    expect(err(() => validateEvent(ring({ travel: { minutes: 1.5 } }), ctx))).toMatch(/travel.minutes/);
    expect(err(() => validateEvent(ring({ travel: { minutes: BOUNDS.travelMinutes + 1 } }), ctx))).toMatch(/travel.minutes/);
    expect(err(() => validateEvent(ring({ travel: { minutes: 5, mode: 'rocket' } }), ctx))).toMatch(/travel.mode must be one of/);
    expect(err(() => validateEvent(ring({ travel: 'soon' }), ctx))).toMatch(/travel must be an object/);
    expect(err(() => validateEvent(ring({ opens: 'popup' }), ctx))).toMatch(/opens must be one of focus, conversation/);
  });

  it('opens conversation needs conversation_id, and conversation_id needs opens conversation', () => {
    expect(err(() => validateEvent(ring({ opens: 'conversation' }), ctx))).toMatch(/needs conversation_id/);
    expect(err(() => validateEvent(ring({ conversation_id: 'abc' }), ctx))).toMatch(/only used with opens "conversation"/);
    expect(err(() => validateEvent(ring({ opens: 'conversation', conversation_id: 'no spaces' }), ctx))).toMatch(/conversation_id is invalid/);
    expect(validateEvent(ring({ opens: 'focus' }), ctx).event.opens).toBe('focus');
  });

  it('bounds detail.description (600) and detail.location (120), and requires a real asset hash', () => {
    expect(validateEvent(ring({ detail: { description: 'd'.repeat(600), location: 'l'.repeat(120) } }), ctx).event.detail).toBeDefined();
    expect(err(() => validateEvent(ring({ detail: { description: 'd'.repeat(601) } }), ctx))).toMatch(/detail.description is 601 characters; the limit is 600/);
    expect(err(() => validateEvent(ring({ detail: { location: 'l'.repeat(121) } }), ctx))).toMatch(/detail.location is 121 characters; the limit is 120/);
    expect(err(() => validateEvent(ring({ detail: { image: 'logo.png' } }), ctx))).toMatch(/detail.image must be an asset hash/);
    expect(err(() => validateEvent(ring({ detail: 'x' }), ctx))).toMatch(/detail must be an object/);
  });

  it('layer, color and travel need both at and end (the ring placement)', () => {
    expect(err(() => validateEvent({ id: 'x', title: 't', at: iso(NOW + 1000), layer: 'primary' }, ctx))).toMatch(/layer needs both at and end/);
    expect(err(() => validateEvent({ id: 'x', title: 't', color: 'red' }, ctx))).toMatch(/color needs both at and end/);
    expect(err(() => validateEvent({ id: 'x', title: 't', travel: { minutes: 5 } }, ctx))).toMatch(/travel needs both at and end/);
  });

  it('approvals never draw on the ring even with at and end', () => {
    expect(drawsOnRing({ kind: 'approval', at: 'a', end: 'b' })).toBe(false);
    expect(drawsOnRing({ kind: 'event', at: 'a' })).toBe(false);
  });
});

describe('checkRingCapacity', () => {
  const at = (h: number) => iso(NOW + h * 3600_000);
  const ev = (id: string, a: number, b: number, layer?: string) => ({ id, kind: 'event', at: at(a), end: at(b), ...(layer ? { layer } : {}) });
  const mk = (id: string, a: number, b: number, layer?: 'primary' | 'overlap') => ({ id, kind: 'event' as const, at: at(a), end: at(b), ...(layer ? { layer } : {}) });

  it('allows one primary at a time and rejects a second overlapping one', () => {
    checkRingCapacity([ev('a', 1, 2)], mk('b', 2, 3), NOW);                      // touching is fine
    expect(err(() => checkRingCapacity([ev('a', 1, 3)], mk('b', 2, 4), NOW))).toMatch(/2 "primary" events at once \(limit 1\).*"a"/);
  });

  it('allows two overlapping overlap events but not three', () => {
    const existing = [ev('o1', 1, 4, 'overlap'), ev('o2', 2, 5, 'overlap')];
    expect(err(() => checkRingCapacity(existing, mk('o3', 3, 4, 'overlap'), NOW))).toMatch(/3 "overlap" events at once \(limit 2\)/);
    checkRingCapacity(existing, mk('o3', 4, 6, 'overlap'), NOW);                  // o1 ended at 4
    checkRingCapacity([ev('o1', 1, 4, 'overlap')], mk('o2', 2, 5, 'overlap'), NOW);
  });

  it('layers do not count against each other; replacing the same id, expired, non-ring and bus events are ignored', () => {
    checkRingCapacity([ev('a', 1, 3)], mk('o', 1, 3, 'overlap'), NOW);
    checkRingCapacity([ev('a', 1, 3)], mk('a', 1, 3), NOW);
    checkRingCapacity([{ ...ev('a', 1, 3), expires_at: iso(NOW - 1) }], mk('b', 1, 3), NOW);
    checkRingCapacity([{ id: 'c', kind: 'event', at: at(1) }], mk('b', 1, 3), NOW);
    checkRingCapacity([{ ...ev('ap', 1, 3), kind: 'approval' }], mk('b', 1, 3), NOW);
    checkRingCapacity([ev('a', 1, 3)], { id: 'card', kind: 'event', at: at(1) }, NOW);
  });
});

describe('validateSlot: primary action, context lines and widgets', () => {
  const sctx = { source: 'agent:peggy', now: NOW, follow: { contact: 'chris', channel: 'telegram:peggy' }, widgetExists: (w: string) => ['gauge', 'timer', 'icon', 'extra'].includes(w) };
  const until = iso(NOW + 3600_000);

  it('keeps the old shape: plain text slots validate exactly as before', () => {
    expect(validateSlot({ id: 'status', text: 'Home', until }, { source: 'agent:peggy', now: NOW })).toEqual({
      id: 'status', text: 'Home', until, source: 'agent:peggy', updated_at: iso(NOW),
    });
  });

  it('primary carries an action and yields one job expiring with the slot', () => {
    const { slot, jobs } = validateSlot({ id: 'primary', text: 'Leave now', until, action: { id: 'go', label: 'On my way', run: { body: 'tapped go' } } }, sctx, true);
    expect(slot.action).toEqual({ id: 'go', label: 'On my way', once: true });
    expect(jobs).toEqual([expect.objectContaining({ action_id: 'go', payload_body: 'tapped go', expires_at: until, sender: 'contact:chris' })]);
  });

  it('a primary action follows the Event button rules (sends_on_behalf needs confirm.draft; errors name `action`)', () => {
    expect(err(() => validateSlot({ id: 'primary', text: 't', until, action: { id: 'go', label: 'Go', run: { body: 'b', sends_on_behalf: true } } }, sctx))).toMatch(/action: run.sends_on_behalf is true/);
    expect(err(() => validateSlot({ id: 'primary', text: 't', until, action: { id: 'go', label: 'x'.repeat(25), run: { body: 'b' } } }, sctx))).toMatch(/action.label is 25/);
    expect(err(() => validateSlot({ id: 'primary', text: 't', until, action: { id: 'go', label: 'Go' } }, sctx))).toMatch(/action.run is required/);
  });

  it('only the primary slot takes an action', () => {
    expect(err(() => validateSlot({ id: 'status', text: 't', until, action: { id: 'go', label: 'Go', run: { body: 'b' } } }, sctx))).toMatch(/action is only for the "primary" slot/);
  });

  it('context takes lines (max 2, each bounded) or widgets (max 3, must exist)', () => {
    expect(validateSlot({ id: 'context', lines: ['Budget 62%', 'Rain at 4'], until }, sctx)).toMatchObject({ lines: ['Budget 62%', 'Rain at 4'] });
    expect(validateSlot({ id: 'context', widgets: ['gauge', 'timer', 'icon'], until }, sctx)).toMatchObject({ widgets: ['gauge', 'timer', 'icon'] });
    expect(err(() => validateSlot({ id: 'context', lines: ['a', 'b', 'c'], until }, sctx))).toMatch(/lines has 3 entries; the limit is 2/);
    expect(err(() => validateSlot({ id: 'context', lines: ['x'.repeat(BOUNDS.contextLineText + 1)], until }, sctx))).toMatch(/lines\[0\] is 41 characters; the limit is 40/);
    expect(err(() => validateSlot({ id: 'context', lines: [], until }, sctx))).toMatch(/lines is empty/);
    expect(err(() => validateSlot({ id: 'context', lines: 'a', until }, sctx))).toMatch(/lines must be an array/);
    expect(err(() => validateSlot({ id: 'context', widgets: ['gauge', 'timer', 'icon', 'extra'], until }, sctx))).toMatch(/widgets has 4 entries; the limit is 3/);
  });

  it('rejects dangling widget ids, duplicates and bad ids', () => {
    expect(err(() => validateSlot({ id: 'context', widgets: ['gauge', 'ghost'], until }, sctx))).toMatch(/widgets\[1\] "ghost" does not exist/);
    expect(err(() => validateSlot({ id: 'context', widgets: ['gauge', 'gauge'], until }, sctx))).toMatch(/listed twice/);
    expect(err(() => validateSlot({ id: 'context', widgets: ['Bad Id'], until }, sctx))).toMatch(/widgets\[0\]/);
    expect(validateSlot({ id: 'context', widgets: ['anything'], until }, { source: 's', now: NOW })).toMatchObject({ widgets: ['anything'] });  // no lookup supplied: shape only
  });

  it('context is one of text, lines or widgets; lines and widgets are context-only', () => {
    expect(err(() => validateSlot({ id: 'context', lines: ['a'], widgets: ['gauge'], until }, sctx))).toMatch(/either lines or widgets, not both/);
    expect(err(() => validateSlot({ id: 'context', until }, sctx))).toMatch(/text is required|context needs lines/);
    expect(err(() => validateSlot({ id: 'context', text: 'x', lines: ['a'], until }, sctx))).toMatch(/not several/);
    expect(err(() => validateSlot({ id: 'primary', lines: ['a'], text: 't', until }, sctx))).toMatch(/only for the "context" slot/);
    expect(err(() => validateSlot({ id: 'primary', until }, sctx))).toMatch(/text is required/);
    expect(validateSlot({ id: 'context', text: 'legacy', until }, sctx).text).toBe('legacy');
  });
});

describe('validateFaceLayout', () => {
  it('accepts the slot bindings and nothing else', () => {
    expect(validateFaceLayout({ slots: { event_ring: true, primary: true, context: 'lines' } })).toEqual({ slots: { event_ring: true, primary: true, context: 'lines' } });
    expect(validateFaceLayout({ slots: {} })).toEqual({ slots: {} });
    expect(err(() => validateFaceLayout('day'))).toMatch(/layout must be an object/);
    expect(err(() => validateFaceLayout({ slots: [] }))).toMatch(/layout.slots must be an object/);
    expect(err(() => validateFaceLayout({ slots: { context: 'grid' } }))).toMatch(/context must be "lines" or "widgets"/);
    expect(err(() => validateFaceLayout({ slots: { event_ring: 'yes' } }))).toMatch(/event_ring must be true or false/);
    expect(err(() => validateFaceLayout({ slots: { sidebar: true } }))).toMatch(/unknown slot "sidebar"/);
    expect(err(() => validateFaceLayout({ slots: {}, extra: 1 }))).toMatch(/unknown key "extra"/);
  });
});

describe('validateAction (exported)', () => {
  it('names the field path in errors', () => {
    expect(err(() => validateAction({ id: 'BAD', label: 'x', run: { body: 'b' } }, 'action', ctx, iso(NOW + 1000)))).toMatch(/action\.id/);
  });
});
