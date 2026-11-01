import { describe, expect, it, vi } from 'vitest';
import { CalendarFeed, calendarAllowed, colorFor, dateInTz, isoInTz, parseCalctl } from './calendar.js';

const CALCTL = JSON.stringify({ data: [
  { id: 'e1', calendarName: 'Work', title: 'B', startDate: '2026-11-01T14:00:00Z', endDate: '2026-11-01T15:00:00Z', isAllDay: false },
  { id: 'e2', calendarName: 'Patriots', title: '🏈 Patriots at Jets', startDate: '2026-11-01T18:00:00Z', endDate: '2026-11-01T21:00:00Z', isAllDay: false },
  { id: 'e3', calendarName: 'Holidays in United States', title: 'Daylight Saving Time ends', startDate: '2026-11-01T04:00:00Z', endDate: '2026-11-02T04:59:59Z', isAllDay: true },
  { id: 'e4', calendarName: 'Family', title: 'Dentist', startDate: '2026-11-01T13:30:00Z', endDate: '2026-11-01T14:00:00Z', isAllDay: false },
  { calendarName: 'Family', title: 'broken' },
] });

describe('calendar filtering', () => {
  it('matches names ignoring case, emoji and punctuation', () => {
    expect(calendarAllowed('Patriots', ['Patriots 🏈'])).toBe(true);
    expect(calendarAllowed('Boston Celtics 2026-27 Full-Season Schedule', ['Boston Celtics 2026-27 Full-Season Schedule'])).toBe(true);
    expect(calendarAllowed('Events Calendar', ['Events Calendar 🎪'])).toBe(true);
    expect(calendarAllowed('Holidays in United States', ['Home', 'Family'])).toBe(false);
    expect(calendarAllowed('Anything', [])).toBe(true);
  });
  it('keeps only configured calendars, converts to America/New_York, titles untouched, all-day first', () => {
    const events = parseCalctl(CALCTL, ['Work', 'Patriots 🏈', 'Family'], 'America/New_York');
    expect(events.map((e) => e.id)).toEqual(['e4', 'e1', 'e2']);
    const dentist = events[0]!;
    expect(dentist).toMatchObject({ title: 'Dentist', calendar: 'Family', all_day: false, start: '2026-11-01T08:30:00-05:00', end: '2026-11-01T09:00:00-05:00' });
    expect(events[2]!.title).toBe('🏈 Patriots at Jets');
    expect(dentist.color).toBe(colorFor('Family'));
    expect(colorFor('Family')).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('shows all-day events from allowed calendars first', () => {
    const events = parseCalctl(CALCTL, ['Holidays in United States', 'Family'], 'America/New_York');
    expect(events[0]).toMatchObject({ id: 'e3', all_day: true });
  });
});

describe('time zone helpers', () => {
  it('formats offsets across the DST change', () => {
    expect(isoInTz(new Date('2026-10-31T16:00:00Z'), 'America/New_York')).toBe('2026-10-31T12:00:00-04:00');
    expect(isoInTz(new Date('2026-11-01T16:00:00Z'), 'America/New_York')).toBe('2026-11-01T11:00:00-05:00');
    expect(dateInTz(new Date('2026-11-02T03:30:00Z'), 'America/New_York')).toBe('2026-11-01');
  });
});

describe('CalendarFeed', () => {
  const cfg = { calendars: ['Family', 'Work'], cache_s: 300, calctl_path: 'calctl', timezone: 'America/New_York' };
  it('asks calctl for today in the zone, caches for cache_s, and serves stale data when calctl fails', async () => {
    let t = Date.parse('2026-11-01T15:00:00Z');
    const run = vi.fn(async (_args: string[]) => CALCTL);
    const feed = new CalendarFeed(cfg, run, () => new Date(t));
    const first = await feed.today();
    expect(run).toHaveBeenCalledWith(['show', 'date:2026-11-01', '--output', 'json', '--quiet']);
    expect(first).toMatchObject({ date: '2026-11-01', tz: 'America/New_York' });
    expect(first.events).toHaveLength(2);
    await feed.today();
    expect(run).toHaveBeenCalledTimes(1);
    t += 301_000;
    run.mockRejectedValueOnce(new Error('calctl failed'));
    expect((await feed.today()).events).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('throws when calctl fails and nothing is cached', async () => {
    const feed = new CalendarFeed(cfg, async () => { throw new Error('boom'); }, () => new Date());
    await expect(feed.today()).rejects.toThrow('boom');
  });
});
