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
