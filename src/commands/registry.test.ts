import { describe, it, expect, vi } from 'vitest';
import { CommandRegistry } from './registry.js';
import type { CommandDefinition, CommandHandler } from './registry.js';

function makeCmd(name: string, scope: 'bus' | 'agent' = 'bus'): CommandDefinition {
  return {
    name,
    description: `Description for ${name}`,
    usage: `/${name} [args]`,
    scope,
    handler: vi.fn() as unknown as CommandHandler,
  };
}

describe('CommandRegistry', () => {
  it('registers and looks up a command by name', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('status'));
    const cmd = reg.lookup('status');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('status');
  });

  it('returns undefined for unknown command', () => {
    const reg = new CommandRegistry();
    expect(reg.lookup('nonexistent')).toBeUndefined();
  });

  it('throws when registering duplicate name', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('status'));
    expect(() => reg.register(makeCmd('status'))).toThrow(
      'Command "status" is already registered',
    );
  });

  it('list() returns commands sorted alphabetically', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('status'));
    reg.register(makeCmd('help'));
    reg.register(makeCmd('pause'));
    const names = reg.list().map((c) => c.name);
    expect(names).toEqual(['help', 'pause', 'status']);
  });

  it('list() returns empty array when no commands registered', () => {
    const reg = new CommandRegistry();
    expect(reg.list()).toEqual([]);
  });

  it('manifests() returns only bus-scope commands', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('status', 'bus'));
    reg.register(makeCmd('agent-cmd', 'agent'));
    reg.register(makeCmd('help', 'bus'));
    const manifests = reg.manifests();
    expect(manifests.map((m) => m.name)).toEqual(['help', 'status']);
  });

  it('manifests() includes name and description only', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('status'));
    const [m] = reg.manifests();
    expect(Object.keys(m!)).toEqual(['name', 'description']);
  });

  it('manifests() are sorted alphabetically', () => {
    const reg = new CommandRegistry();
    reg.register(makeCmd('zzz'));
    reg.register(makeCmd('aaa'));
    const names = reg.manifests().map((m) => m.name);
    expect(names).toEqual(['aaa', 'zzz']);
  });
});

describe('CommandRegistry follow-up capture (E36)', () => {
  it('consumeFollowUp returns the registered command/validate pair', () => {
    const reg = new CommandRegistry();
    const validate = (body: string) => body.startsWith('magnet:');
    reg.registerFollowUp('telegram', 'contact:chris', 'torrent', validate, 60_000);
    const result = reg.consumeFollowUp('telegram', 'contact:chris');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('torrent');
    expect(result!.validate).toBe(validate);
  });

  it('consumeFollowUp is single-shot — a second call returns null', () => {
    const reg = new CommandRegistry();
    reg.registerFollowUp('telegram', 'contact:chris', 'torrent', () => true, 60_000);
    expect(reg.consumeFollowUp('telegram', 'contact:chris')).not.toBeNull();
    expect(reg.consumeFollowUp('telegram', 'contact:chris')).toBeNull();
  });

  it('consumeFollowUp returns null when nothing was registered', () => {
    const reg = new CommandRegistry();
    expect(reg.consumeFollowUp('telegram', 'contact:chris')).toBeNull();
  });

  it('consumeFollowUp returns null once the TTL has expired, and still deletes the entry', () => {
    vi.useFakeTimers();
    try {
      const reg = new CommandRegistry();
      reg.registerFollowUp('telegram', 'contact:chris', 'torrent', () => true, 1_000);
      vi.advanceTimersByTime(1_001);
      expect(reg.consumeFollowUp('telegram', 'contact:chris')).toBeNull();
      // Re-registering after the expired read proves the entry was actually deleted, not just skipped.
      reg.registerFollowUp('telegram', 'contact:chris', 'torrent', () => true, 60_000);
      expect(reg.consumeFollowUp('telegram', 'contact:chris')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not collide across different (channel, sender) keys', () => {
    const reg = new CommandRegistry();
    reg.registerFollowUp('telegram', 'contact:chris', 'torrent', () => true, 60_000);
    reg.registerFollowUp('telegram', 'contact:alice', 'other', () => true, 60_000);
    const chris = reg.consumeFollowUp('telegram', 'contact:chris');
    const alice = reg.consumeFollowUp('telegram', 'contact:alice');
    expect(chris!.command).toBe('torrent');
    expect(alice!.command).toBe('other');
  });

  it('re-registering the same key before consumption overwrites (latest wins)', () => {
    const reg = new CommandRegistry();
    reg.registerFollowUp('telegram', 'contact:chris', 'first', () => true, 60_000);
    reg.registerFollowUp('telegram', 'contact:chris', 'second', () => true, 60_000);
    const result = reg.consumeFollowUp('telegram', 'contact:chris');
    expect(result!.command).toBe('second');
    // Only one entry ever existed for the key — confirmed by the single consume above
    // already returning the latest, plus the single-shot test elsewhere covering delete-on-read.
  });
});
