import { describe, it, expect } from 'vitest';
import { parseFireAt, formatInZone } from './time.js';

describe('parseFireAt', () => {
  it('honours an explicit UTC offset', () => {
    expect(parseFireAt('2026-05-01T09:00:00-05:00').toISOString()).toBe('2026-05-01T14:00:00.000Z');
    expect(parseFireAt('2026-05-01T09:00:00+0200').toISOString()).toBe('2026-05-01T07:00:00.000Z');
    expect(parseFireAt('2026-05-01T09:00:00Z', 'America/New_York').toISOString()).toBe('2026-05-01T09:00:00.000Z');
  });

  it('reads an offset-less time as wall-clock time in the named zone, across DST', () => {
    // EDT (UTC-4) in summer, EST (UTC-5) in winter
    expect(parseFireAt('2026-07-01T09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(parseFireAt('2026-12-01T09:00:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
    expect(parseFireAt('2026-07-01T09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('defaults offset-less times to UTC', () => {
    expect(parseFireAt('2026-07-01T09:00:00').toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(parseFireAt('2026-07-01').toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects garbage and unknown zones', () => {
    expect(() => parseFireAt('next tuesday')).toThrow();
    expect(() => parseFireAt('2026-07-01T09:00', 'Mars/Olympus')).toThrow();
  });
});

describe('formatInZone', () => {
  it('formats a UTC instant in the given zone', () => {
    expect(formatInZone('2026-07-01T13:00:00.000Z', 'America/New_York')).toEqual({
      text: '2026-07-01 09:00',
      zone: 'America/New_York',
    });
    expect(formatInZone('2026-07-01T13:00:00.000Z', 'UTC')).toEqual({ text: '2026-07-01 13:00', zone: 'UTC' });
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(formatInZone('2026-07-01T13:00:00.000Z', 'Nope/Nope')).toEqual({ text: '2026-07-01 13:00', zone: 'UTC' });
  });
});
