import { describe, expect, it, vi } from 'vitest';
import { MbtaLive, parsePredictions } from './mbta.js';

const body = {
  data: [
    { id: 'p1', type: 'prediction', attributes: { departure_time: '2026-11-03T07:09:00-05:00', arrival_time: null, status: 'Delayed', schedule_relationship: null },
      relationships: { trip: { data: { id: 't1' } }, schedule: { data: { id: 's1' } } } },
    { id: 'p2', type: 'prediction', attributes: { departure_time: '2026-11-03T07:42:00-05:00', schedule_relationship: 'CANCELLED' }, relationships: { trip: { data: { id: 't2' } }, schedule: { data: null } } },
    { id: 'p3', type: 'prediction', attributes: { departure_time: null, arrival_time: null }, relationships: { trip: { data: { id: 't3' } }, schedule: { data: null } } },
  ],
  included: [
    { id: 't1', type: 'trip', attributes: { name: '6008' } }, { id: 't2', type: 'trip', attributes: { name: '6010' } }, { id: 't3', type: 'trip', attributes: { name: '6012' } },
    { id: 's1', type: 'schedule', attributes: { departure_time: '2026-11-03T07:01:00-05:00' } },
  ],
};

describe('parsePredictions', () => {
  it('maps train number to predicted and scheduled departure, skipping cancelled and time-less predictions', () => {
    const m = parsePredictions(body);
    expect([...m.keys()]).toEqual(['6008']);
    expect(m.get('6008')).toEqual({ departsMs: Date.parse('2026-11-03T07:09:00-05:00'), scheduledMs: Date.parse('2026-11-03T07:01:00-05:00'), status: 'Delayed' });
  });
  it('throws on a response that is not a prediction list', () => {
    expect(() => parsePredictions({ errors: [] })).toThrow();
  });
});

describe('MbtaLive', () => {
  const ok = () => ({ ok: true, status: 200, json: async () => body }) as Response;
  const q = { stop: 'place-NEC-2040', direction: 1 as const };
  it('caches per stop and direction, sends the key, and builds the V3 query', async () => {
    let t = 0;
    const f = vi.fn(async () => ok());
    const m = new MbtaLive({ route: 'CR-Providence', apiKey: 'K', cacheMs: 30_000, fetchFn: f as never, now: () => t });
    await Promise.all([m.get(q), m.get(q)]);                  // in-flight dedupe
    t = 29_000; await m.get(q);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('filter[route]=CR-Providence&filter[stop]=place-NEC-2040&filter[direction_id]=1&include=trip,schedule');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('K');
    t = 31_000; await m.get(q);
    await m.get({ stop: 'place-sstat', direction: 0 });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('backs off after a failure, serves stale data for a while, then reports unavailable', async () => {
    let t = 0; let fail = false;
    const f = vi.fn(async () => (fail ? ({ ok: false, status: 503 } as Response) : ok()));
    const log = vi.fn();
    const m = new MbtaLive({ route: 'R', cacheMs: 30_000, fetchFn: f as never, now: () => t, log });
    expect((await m.get(q))?.size).toBe(1);
    fail = true; t = 40_000;
    expect((await m.get(q))?.size).toBe(1);                   // failed refresh, stale answer
    expect(log).toHaveBeenCalledTimes(1);
    t = 60_000; await m.get(q);
    expect(f).toHaveBeenCalledTimes(2);                       // inside the backoff: no new request
    t = 4 * 60_000;
    expect(await m.get(q)).toBeNull();                        // past the stale window
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('treats a thrown fetch as unavailable', async () => {
    const m = new MbtaLive({ route: 'R', fetchFn: (async () => { throw new Error('offline'); }) as never });
    expect(await m.get(q)).toBeNull();
  });
});
