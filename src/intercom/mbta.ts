/**
 * Live MBTA V3 predictions for the desk departure (on-my-way ETA).
 *
 * One cached query per (stop, direction): `/predictions?filter[route]&filter[stop]&filter[direction_id]&include=trip,schedule`.
 * Results are kept `cache_s` (default 30 s) so the 5 s desk tick never costs more than two requests a minute; a failure
 * backs off for `BACKOFF_MS` and serves the last good answer for up to `STALE_MS`, then reports "unavailable" (null),
 * which makes the desk fall back to its scheduled-time behaviour. Without an API key the public rate limit applies (20/min).
 */

export interface LivePrediction {
  /** Predicted departure (epoch ms). */
  departsMs: number;
  /** Scheduled departure (epoch ms), when the schedule was included. */
  scheduledMs: number | null;
  status: string | null;
}
/** Train number (trip name) to its live prediction. A train missing from the map has no prediction (yet, or any more). */
export type LiveTrains = ReadonlyMap<string, LivePrediction>;
export interface StopQuery { stop: string; direction: 0 | 1 }
export interface LiveSource {
  /** The live predictions for the stop, or null when the API is unavailable. Never throws. */
  get(q: StopQuery): Promise<LiveTrains | null>;
}

export const MBTA_BASE = 'https://api-v3.mbta.com';
export const MBTA_BACKOFF_MS = 60_000;
export const MBTA_STALE_MS = 3 * 60_000;
const TIMEOUT_MS = 8_000;

interface JsonApiRes { id: string; type: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } | null }> }

const ms = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** Pure: turn a V3 `/predictions` response (with included trips and schedules) into {@link LiveTrains}. */
export function parsePredictions(body: unknown): LiveTrains {
  const out = new Map<string, LivePrediction>();
  const b = body as { data?: JsonApiRes[]; included?: JsonApiRes[] } | null;
  if (!b || !Array.isArray(b.data)) throw new Error('unexpected MBTA response');
  const inc = new Map<string, JsonApiRes>();
  for (const i of b.included ?? []) inc.set(`${i.type}:${i.id}`, i);
  for (const p of b.data) {
    const a = p.attributes ?? {};
    if (a['schedule_relationship'] === 'CANCELLED' || a['schedule_relationship'] === 'SKIPPED') continue;
    const departsMs = ms(a['departure_time']) ?? ms(a['arrival_time']);
    if (departsMs === null) continue;
    const trip = inc.get(`trip:${p.relationships?.['trip']?.data?.id ?? ''}`);
    const name = typeof trip?.attributes?.['name'] === 'string' ? (trip.attributes['name'] as string) : '';
    if (!name) continue;
    const sch = inc.get(`schedule:${p.relationships?.['schedule']?.data?.id ?? ''}`);
    const scheduledMs = sch ? ms(sch.attributes?.['departure_time']) ?? ms(sch.attributes?.['arrival_time']) : null;
    out.set(name, { departsMs, scheduledMs, status: typeof a['status'] === 'string' ? (a['status'] as string) : null });
  }
  return out;
}

export interface MbtaOptions {
  route: string;
  apiKey?: string;
  cacheMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class MbtaLive implements LiveSource {
  private readonly cache = new Map<string, { at: number; trains: LiveTrains }>();
  private readonly inflight = new Map<string, Promise<LiveTrains | null>>();
  private backoffUntil = 0;
  private lastWarn = Number.NEGATIVE_INFINITY;
  constructor(private readonly o: MbtaOptions) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  async get(q: StopQuery): Promise<LiveTrains | null> {
    const k = `${q.stop}:${q.direction}`;
    const now = this.now();
    const hit = this.cache.get(k);
    if (hit && now - hit.at < (this.o.cacheMs ?? 30_000)) return hit.trains;
    const stale = (): LiveTrains | null => (hit && now - hit.at < MBTA_STALE_MS ? hit.trains : null);
    if (now < this.backoffUntil) return stale();
    let p = this.inflight.get(k);
    if (!p) {
      p = this.fetchOne(q, k).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return (await p) ?? stale();
  }

  private async fetchOne(q: StopQuery, k: string): Promise<LiveTrains | null> {
    const url = `${MBTA_BASE}/predictions?filter[route]=${encodeURIComponent(this.o.route)}&filter[stop]=${encodeURIComponent(q.stop)}`
      + `&filter[direction_id]=${q.direction}&include=trip,schedule&sort=departure_time`;
    try {
      const res = await (this.o.fetchFn ?? fetch)(url, {
        headers: { accept: 'application/vnd.api+json', ...(this.o.apiKey ? { 'x-api-key': this.o.apiKey } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trains = parsePredictions(await res.json());
      this.cache.set(k, { at: this.now(), trains });
      return trains;
    } catch (err) {
      this.backoffUntil = this.now() + MBTA_BACKOFF_MS;
      if (this.now() - this.lastWarn > 10 * 60_000) {
        this.lastWarn = this.now();
        this.o.log?.(`warn: MBTA predictions unavailable (${err instanceof Error ? err.message : String(err)}); using the schedule`);
      }
      return null;
    }
  }
}
