/**
 * E91 — the day-dial's calendar feed: `calctl show date:YYYY-MM-DD --output json`,
 * filtered to the configured calendars and cached.
 */
import { execFile } from 'node:child_process';
import type { IntercomAdapterConfig } from '../config/schema.js';

export interface CalendarEvent {
  id: string; title: string; start: string; end: string; all_day: boolean; calendar: string; color: string;
  /** Free-text location from the calendar, when the event has one (used for the desk face's leave-by estimate). */
  location?: string;
}
export interface CalendarPayload {
  date: string; tz: string; generated_at: string; events: CalendarEvent[];
}

/** Stable colours per calendar (calctl does not report any). */
const PALETTE = ['#c9a14a', '#6aa0d6', '#7fb685', '#d9825b', '#a58bd0', '#d1708f', '#5fb5b0', '#b8b25a', '#e0a458', '#8e8e93'];
export function colorFor(calendar: string): string {
  let h = 0;
  for (const ch of calendar) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Lowercase letters and digits only, so "Patriots 🏈" matches "Patriots". */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function calendarAllowed(name: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const n = norm(name);
  return allowed.some((a) => {
    const w = norm(a);
    if (!w || !n) return false;
    return n === w || (Math.min(n.length, w.length) >= 4 && (n.startsWith(w) || w.startsWith(n)));
  });
}

function partsIn(date: Date, tz: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** `YYYY-MM-DD` of `date` in `tz`. */
export function dateInTz(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  return `${String(p['year']).padStart(4, '0')}-${String(p['month']).padStart(2, '0')}-${String(p['day']).padStart(2, '0')}`;
}

/** ISO-8601 with the zone's offset, e.g. `2026-11-01T09:00:00-05:00`. */
export function isoInTz(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
  const offsetMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(p['year']!, 4)}-${pad(p['month']!)}-${pad(p['day']!)}T${pad(p['hour']!)}:${pad(p['minute']!)}:${pad(p['second']!)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

interface CalctlEvent {
  id?: string; calendarName?: string; startDate?: string; endDate?: string; isAllDay?: boolean; title?: string; location?: string;
}

export function parseCalctl(json: string, allowed: readonly string[], tz: string): CalendarEvent[] {
  const parsed = JSON.parse(json) as { data?: CalctlEvent[] };
  const out: CalendarEvent[] = [];
  for (const e of parsed.data ?? []) {
    if (!e.startDate || !e.endDate || !e.calendarName) continue;
    if (!calendarAllowed(e.calendarName, allowed)) continue;
    const start = new Date(e.startDate); const end = new Date(e.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    out.push({
      id: e.id ?? `${e.calendarName}:${e.startDate}:${e.title ?? ''}`,
      title: e.title ?? '', start: isoInTz(start, tz), end: isoInTz(end, tz),
      all_day: e.isAllDay === true, calendar: e.calendarName, color: colorFor(e.calendarName),
      ...(e.location && e.location.trim() ? { location: e.location.trim() } : {}),
    });
  }
  // All-day first, then by start time.
  out.sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return out;
}

export type CalctlRunner = (args: string[]) => Promise<string>;

export function execCalctl(path: string): CalctlRunner {
  return (args) => new Promise((resolve, reject) => {
    execFile(path, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

export class CalendarFeed {
  private cache: { date: string; at: number; payload: CalendarPayload } | null = null;
  private inflight: Promise<CalendarPayload> | null = null;

  constructor(
    private readonly cfg: IntercomAdapterConfig['calendar'],
    private readonly run: CalctlRunner = execCalctl(cfg.calctl_path),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Today's payload. Served from cache for `cache_s`; on a calctl failure a stale copy for the same date is returned if there is one. */
  async today(): Promise<CalendarPayload> {
    const now = this.now();
    const date = dateInTz(now, this.cfg.timezone);
    const c = this.cache;
    if (c && c.date === date && now.getTime() - c.at < this.cfg.cache_s * 1000) return c.payload;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const out = await this.run(['show', `date:${date}`, '--output', 'json', '--quiet']);
        const payload: CalendarPayload = {
          date, tz: this.cfg.timezone, generated_at: now.toISOString(),
          events: parseCalctl(out, this.cfg.calendars, this.cfg.timezone),
        };
        this.cache = { date, at: now.getTime(), payload };
        return payload;
      } catch (err) {
        if (this.cache && this.cache.date === date) return this.cache.payload;
        throw err;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
