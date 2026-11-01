import { describe, it, expect } from 'vitest';
import { recordAgentPoll, getLastPollAt, getLastPoll, registerAgentLaunch, getRegisteredLaunch, isStaleLaunch } from './agent-liveness.js';

// Each test uses its own agent id to stay independent despite this module's
// shared, unresettable module-level Map state (by design — see agent-liveness.ts).

describe('agent-liveness', () => {
  it('returns null for an agent id that has never polled', () => {
    expect(getLastPollAt('never-seen-agent')).toBeNull();
  });

  it('recording a poll then reading it back returns the recorded time', () => {
    const agentId = 'record-then-read-agent';
    const at = new Date('2026-01-01T00:00:00.000Z');

    recordAgentPoll(agentId, at);

    expect(getLastPollAt(agentId)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('recording twice keeps the latest time', () => {
    const agentId = 'record-twice-agent';
    const first = new Date('2026-01-01T00:00:00.000Z');
    const second = new Date('2026-01-01T00:05:00.000Z');

    recordAgentPoll(agentId, first);
    recordAgentPoll(agentId, second);

    expect(getLastPollAt(agentId)).toBe('2026-01-01T00:05:00.000Z');
  });

  it('defaults to the current time when `at` is omitted', () => {
    const agentId = 'default-now-agent';
    const before = Date.now();

    recordAgentPoll(agentId);

    const recorded = getLastPollAt(agentId);
    expect(recorded).not.toBeNull();
    expect(new Date(recorded!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('E88: records the launch id a poll carried', () => {
    recordAgentPoll('e88-launch-agent', new Date('2026-10-31T00:00:00.000Z'), 'L1');
    expect(getLastPoll('e88-launch-agent')).toEqual({ lastPollAt: '2026-10-31T00:00:00.000Z', lastLaunchId: 'L1' });
    recordAgentPoll('e88-launch-agent');
    expect(getLastPoll('e88-launch-agent')!.lastLaunchId).toBeNull();
  });

  it('E88: an agent id with no registered launch is never stale', () => {
    expect(getRegisteredLaunch('e88-unregistered')).toBeNull();
    expect(isStaleLaunch('e88-unregistered', undefined)).toBe(false);
    expect(isStaleLaunch('e88-unregistered', 'anything')).toBe(false);
  });

  it('E88: once registered, only the registered launch id is current', () => {
    registerAgentLaunch('e88-registered', 'L-current');
    expect(isStaleLaunch('e88-registered', 'L-current')).toBe(false);
    expect(isStaleLaunch('e88-registered', 'L-old')).toBe(true);
    expect(isStaleLaunch('e88-registered', undefined)).toBe(true);
    expect(isStaleLaunch('e88-registered', '')).toBe(true);
    registerAgentLaunch('e88-registered', 'L-next');
    expect(isStaleLaunch('e88-registered', 'L-current')).toBe(true);
  });
});
