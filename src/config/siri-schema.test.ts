import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from './schema.js';

describe('AppConfigSchema — siri (E42)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };
  const token = 'a-sufficiently-long-siri-token';

  it('applies the documented defaults when adapters.siri is an empty block', () => {
    const parsed = AppConfigSchema.parse({ ...base, adapters: { siri: {} } });
    expect(parsed.adapters.siri).toEqual({
      enabled: true,
      reply_timeout_ms: 25000,
      late_reply_ttl_ms: 86_400_000,
      max_body_bytes: 8192,
      rate_limit: { per_minute: 20, max_in_flight: 4 },
      debug_delay_ms: 0,
    });
  });

  it('allows adapters.siri to be omitted entirely', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.adapters.siri).toBeUndefined();
  });

  it('accepts the full E43 shape (fallback + rate_limit) with a defaulted template', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      adapters: {
        siri: {
          reply_timeout_ms: 20000,
          rate_limit: { per_minute: 5 },
          fallback: { channel: 'telegram:peggy' },
          debug_delay_ms: 15000,
        },
      },
    });
    expect(parsed.adapters.siri?.reply_timeout_ms).toBe(20000);
    expect(parsed.adapters.siri?.rate_limit).toEqual({ per_minute: 5, max_in_flight: 4 });
    expect(parsed.adapters.siri?.fallback).toEqual({
      channel: 'telegram:peggy',
      template: 'Re your Siri question "{{question}}":\n{{body}}',
    });
    expect(parsed.adapters.siri?.debug_delay_ms).toBe(15000);
  });

  it('rejects a reply_timeout_ms outside 1000..60000', () => {
    expect(() => AppConfigSchema.parse({ ...base, adapters: { siri: { reply_timeout_ms: 500 } } })).toThrow();
    expect(() => AppConfigSchema.parse({ ...base, adapters: { siri: { reply_timeout_ms: 90000 } } })).toThrow();
  });

  it('parses a contact with a siri token', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { siri: { token } } } },
    });
    expect(parsed.contacts['chris']?.platforms.siri?.token).toBe(token);
  });

  it('rejects a siri token shorter than 16 characters', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { siri: { token: 'short' } } } },
      }),
    ).toThrow();
  });

  it('rejects the same siri token on two contacts, naming the other owner', () => {
    const result = AppConfigSchema.safeParse({
      ...base,
      contacts: {
        chris: { id: 'chris', displayName: 'Chris', platforms: { siri: { token } } },
        alice: { id: 'alice', displayName: 'Alice', platforms: { siri: { token } } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.').endsWith('alice.platforms.siri.token'));
      expect(issue?.message).toBe('Duplicate siri token — also used by contact "chris"');
    }
  });

  it('still rejects duplicate pebble tokens (shared check)', () => {
    const result = AppConfigSchema.safeParse({
      ...base,
      contacts: {
        chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: 'tok' } } },
        alice: { id: 'alice', displayName: 'Alice', platforms: { pebble: { token: 'tok' } } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.startsWith('Duplicate pebble token'))).toBe(true);
    }
  });

  it('allows the same string as a pebble token and a siri token on one contact', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token }, siri: { token } } } },
    });
    expect(parsed.contacts['chris']?.platforms.siri?.token).toBe(token);
  });
});
