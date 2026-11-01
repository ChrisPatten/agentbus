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
