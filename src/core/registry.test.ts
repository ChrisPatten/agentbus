import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from './registry.js';
import type { AdapterInstance } from './registry.js';

function makeAdapter(opts: { id: string; channels: string[]; ownsChannel?: (channel: string) => boolean }): AdapterInstance {
  return {
    id: opts.id,
    name: opts.id,
    capabilities: { send: true, channels: opts.channels },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: async () => ({ success: true }),
    ownsChannel: opts.ownsChannel,
  };
}

describe('AdapterRegistry channel lookup', () => {
  it('lookupByChannel matches capabilities.channels as before', () => {
    const registry = new AdapterRegistry();
    const adapter = makeAdapter({ id: 'telegram', channels: ['telegram'] });
    registry.register(adapter);

    expect(registry.lookupByChannel('telegram')).toEqual([adapter]);
    expect(registry.lookupPrimaryByChannel('telegram')).toBe(adapter);
    expect(registry.lookupByChannel('telegram:group:-100123')).toEqual([]);
  });

  it('lookupByChannel also matches via ownsChannel (E28 dynamic group channel)', () => {
    const registry = new AdapterRegistry();
    const adapter = makeAdapter({
      id: 'telegram',
      channels: ['telegram'],
      ownsChannel: (channel) => channel === 'telegram' || channel.startsWith('telegram:group:'),
    });
    registry.register(adapter);

    expect(registry.lookupPrimaryByChannel('telegram:group:-100123')).toBe(adapter);
    expect(registry.lookupPrimaryByChannel('telegram:group:-999')).toBe(adapter);
    expect(registry.lookupPrimaryByChannel('bluebubbles')).toBeUndefined();
  });

  it('does not match an unrelated channel just because ownsChannel exists on another adapter', () => {
    const registry = new AdapterRegistry();
    const telegram = makeAdapter({
      id: 'telegram',
      channels: ['telegram'],
      ownsChannel: (channel) => channel === 'telegram' || channel.startsWith('telegram:group:'),
    });
    const email = makeAdapter({ id: 'email', channels: ['email'] });
    registry.register(telegram);
    registry.register(email);

    expect(registry.lookupPrimaryByChannel('email')).toBe(email);
    expect(registry.lookupPrimaryByChannel('telegram:group:-1')).toBe(telegram);
  });
});
