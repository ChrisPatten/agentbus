import { describe, it, expect } from 'vitest';
import { buildDemo } from './publish-demo.mjs';
import { validateEvent, validateSlot, validateWidget, checkRingCapacity } from '../../../src/surface/validate.ts';

const NOW = new Date(2026, 10, 3, 9, 0, 0);
const follow = { contact: 'chris', channel: 'telegram:peggy' };

describe('publish-demo payloads pass the bus validators', () => {
  const d = buildDemo(NOW, 'peggy');
  it('every Event validates, and the ring capacity holds as they are published in order', () => {
    const published = [];
    for (const e of d.events) {
      const { agent_id: _a, ...input } = e;
      const { event } = validateEvent(input, { follow, source: 'agent:peggy', now: NOW.getTime() });
      checkRingCapacity(published, event, NOW.getTime());
      published.push(event);
    }
    expect(published.length).toBe(d.events.length);
    expect(published.some((e) => e.travel)).toBe(true);
    expect(published.some((e) => e.at && !e.end)).toBe(true); // a deadline tick
    expect(published.filter((e) => e.layer === 'overlap')).toHaveLength(2);
  });
  it('widgets, the primary slot (with a confirm-draft button) and both context forms validate', () => {
    for (const w of d.widgets) validateWidget(w, { source: 'agent:peggy', now: NOW.getTime() });
    const ids = new Set(d.widgets.map((w) => w.id));
    const ctx = { source: 'agent:peggy', now: NOW.getTime(), follow, widgetExists: (id) => ids.has(id) };
    const p = validateSlot({ ...strip(d.primary), id: 'primary' }, ctx, true);
    expect(p.slot.action.confirm.draft).toMatch(/curb/);
    expect(p.jobs).toHaveLength(1);
    validateSlot({ ...strip(d.contextLines), id: 'context' }, ctx);
    validateSlot({ ...strip(d.contextWidgets), id: 'context' }, ctx);
  });
  it('calendar-style Events are spread across the day', () => {
    const hours = d.events.filter((e) => e.end).map((e) => new Date(e.at).getHours());
    expect(Math.min(...hours)).toBeLessThanOrEqual(9);
    expect(Math.max(...hours)).toBeGreaterThanOrEqual(19);
  });
});
const strip = ({ agent_id: _a, ...rest }) => rest;
