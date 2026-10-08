import { describe, it, expect } from 'vitest';
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_KINDS,
  RUNTIME_CAPABILITY_NAMES,
  LIVE_CAPABILITIES,
  HOOK_EVENTS,
  runtimeCapabilities,
  hasCapability,
  missingCapabilities,
  formatCapabilities,
} from './runtime-capabilities.js';

describe('runtime capability matrix (E64 S64.1)', () => {
  // Pins the full matrix. A change here is a behavior change for every
  // consumer (advisories, journaling, memory loading) — update
  // docs/RUNTIME_CAPABILITIES.md alongside it.
  it('declares the verified static capabilities for every runtime', () => {
    expect(RUNTIME_CAPABILITIES).toEqual({
      'cc-headless': {
        systemMessages: true, schedules: true, sessionResume: true, sessionFork: true,
        exclusiveSession: true, liveAgent: false, nativeMemory: true, contextInjection: true,
        hookEvents: ['pre-compact'],
      },
      'cc-pool': {
        systemMessages: true, schedules: true, sessionResume: true, sessionFork: false,
        exclusiveSession: true, liveAgent: true, nativeMemory: true, contextInjection: true,
        hookEvents: ['turn-ended', 'pre-compact', 'session-end', 'clear'],
      },
      'claude-code': {
        systemMessages: false, schedules: false, sessionResume: false, sessionFork: false,
        exclusiveSession: false, liveAgent: true, nativeMemory: true, contextInjection: true,
        hookEvents: ['turn-ended', 'pre-compact', 'session-end', 'clear'],
      },
      'mcp-polled': {
        systemMessages: false, schedules: false, sessionResume: false, sessionFork: false,
        exclusiveSession: false, liveAgent: true, nativeMemory: false, contextInjection: false,
        hookEvents: [],
      },
    });
  });

  it('covers every runtime kind and every capability name', () => {
    expect(Object.keys(RUNTIME_CAPABILITIES).sort()).toEqual([...RUNTIME_KINDS].sort());
    for (const kind of RUNTIME_KINDS) {
      const keys = Object.keys(runtimeCapabilities(kind)).filter((k) => k !== 'hookEvents');
      expect(keys.sort()).toEqual([...RUNTIME_CAPABILITY_NAMES].sort());
      for (const event of runtimeCapabilities(kind).hookEvents) expect(HOOK_EVENTS).toContain(event);
    }
  });

  it('is frozen so no consumer can mutate the shared matrix', () => {
    expect(Object.isFrozen(RUNTIME_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(RUNTIME_CAPABILITIES['cc-pool'])).toBe(true);
    expect(Object.isFrozen(RUNTIME_CAPABILITIES['cc-pool'].hookEvents)).toBe(true);
  });

  it('marks exactly the session-state-dependent capabilities as live', () => {
    expect([...LIVE_CAPABILITIES].sort()).toEqual(['exclusiveSession', 'liveAgent', 'sessionFork', 'sessionResume']);
  });
});

describe('capability helpers', () => {
  const headless = runtimeCapabilities('cc-headless');
  const claudeCode = runtimeCapabilities('claude-code');

  it('checks flags and hook events', () => {
    expect(hasCapability(headless, 'systemMessages')).toBe(true);
    expect(hasCapability(headless, 'liveAgent')).toBe(false);
    expect(hasCapability(headless, 'hookEvents:pre-compact')).toBe(true);
    expect(hasCapability(headless, 'hookEvents:turn-ended')).toBe(false);
  });

  it('lists missing requirements in the order they were declared', () => {
    expect(missingCapabilities(claudeCode, ['liveAgent', 'systemMessages', 'exclusiveSession'])).toEqual([
      'systemMessages',
      'exclusiveSession',
    ]);
    expect(missingCapabilities(headless, [])).toEqual([]);
  });

  it('formats a one-line summary', () => {
    expect(formatCapabilities(headless)).toBe(
      'systemMessages, schedules, sessionResume, sessionFork, exclusiveSession, nativeMemory, contextInjection; hooks: pre-compact',
    );
    expect(formatCapabilities(runtimeCapabilities('mcp-polled'))).toBe('liveAgent; hooks: none');
  });
});
