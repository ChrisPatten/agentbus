import { describe, expect, it } from 'vitest';
import { applySendOptions } from './send-options.js';

describe('applySendOptions glance (E90 I3)', () => {
  it('stores a clamped glance and nothing when it is absent or blank', () => {
    expect(applySendOptions({}, { glance: 'Moved to four' })).toEqual({ glance: 'Moved to four' });
    expect(applySendOptions({ a: 1 }, { glance: '   ' })).toEqual({ a: 1 });
    expect(applySendOptions({}, {})).toEqual({});
    expect(String(applySendOptions({}, { glance: 'x '.repeat(100) })['glance']).length).toBeLessThanOrEqual(100);
  });
});

describe('applySendOptions answer_needed (E96)', () => {
  it('adds answer_needed only when true', () => {
    expect(applySendOptions({}, { answer_needed: true })).toEqual({ answer_needed: true });
    expect(applySendOptions({}, { answer_needed: false })).toEqual({});
    expect(applySendOptions({}, {})).toEqual({});
  });
});
