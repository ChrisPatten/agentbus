/**
 * Time-zone helpers for the scheduler.
 *
 * `scheduled_items.fire_at` is always stored as a UTC ISO string
 * (`toISOString()`), because the tick query compares it as text against the
 * current UTC time. Anything that writes `fire_at` from user input must go
 * through `parseFireAt` first.
 */

const OFFSET_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

/** Throws RangeError if `timeZone` is not a valid IANA zone. */
function partsIn(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset (ms) of `timeZone` from UTC at instant `date`: local wall time minus UTC. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']! % 24, p['minute']!, p['second']!);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Parse a schedule `fire_at` into an instant.
 *
 * - With an explicit offset (`Z`, `+02:00`, `-0500`), the offset is used.
 * - Without one (`2026-10-06T09:00`, `2026-10-06`), the value is a wall-clock
 *   time in `timeZone` (an IANA name such as `America/New_York`; default UTC).
 *
 * Throws on an unparseable value or an unknown time zone.
 */
export function parseFireAt(value: string, timeZone = 'UTC'): Date {
  const trimmed = value.trim();
  if (OFFSET_RE.test(trimmed)) {
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) throw new Error(`fire_at "${value}" is not a valid ISO 8601 timestamp`);
    return d;
  }
  const m = WALL_RE.exec(trimmed);
  if (!m) throw new Error(`fire_at "${value}" is not a valid ISO 8601 timestamp`);
  const [y, mo, d, h, mi, s, frac] = [
    Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
    Number((m[7] ?? '0').slice(0, 3).padEnd(3, '0')),
  ];
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s, frac);
  if (isNaN(wallAsUtc)) throw new Error(`fire_at "${value}" is not a valid ISO 8601 timestamp`);
  // Two passes settle the offset, including across a DST boundary.
  let guess = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  guess = wallAsUtc - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/**
 * Format a stored UTC ISO instant as `YYYY-MM-DD HH:MM` in `timeZone`.
 * Falls back to UTC (and reports it) if the zone is unknown.
 */
export function formatInZone(iso: string, timeZone: string): { text: string; zone: string } {
  const date = new Date(iso);
  let zone = timeZone || 'UTC';
  let p: Record<string, number>;
  try {
    p = partsIn(date, zone);
  } catch {
    zone = 'UTC';
    p = partsIn(date, zone);
  }
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
  return {
    text: `${p['year']}-${pad(p['month'])}-${pad(p['day'])} ${pad((p['hour'] ?? 0) % 24)}:${pad(p['minute'])}`,
    zone,
  };
}
