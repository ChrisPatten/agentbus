import { describe, it, expect } from 'vitest';
import {
  AppConfigSchema,
  getTelegramInstances,
  getCcHeadlessInstances,
  journalingThresholdForChannel,
} from './schema.js';
import type { AppConfig, CcHeadlessAdapterConfig } from './schema.js';

function makeConfig(telegram: AppConfig['adapters']['telegram']): AppConfig {
  return {
    bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
    adapters: { telegram },
    contacts: {},
    topics: ['general'],
    memory: {
      summarizer_interval_ms: 60000,
      session_idle_threshold_ms: 1800000,
      context_window_hours: 48,
      claude_api_model: 'claude-opus-4-6',
      summary_max_tokens: 8192,
      session_close_min_messages: 0,
    },
    scheduler: { tick_interval_ms: 30000, enabled: true },
    schedules: [],
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [],
    },
  } as unknown as AppConfig;
}

describe('getTelegramInstances', () => {
  it('returns empty array when telegram is not configured', () => {
    const config = makeConfig(undefined);
    expect(getTelegramInstances(config)).toEqual([]);
  });

  it('legacy single-bot form returns one entry with name=null', () => {
    const config = makeConfig({ token: 'bot123:ABC', poll_timeout: 30 } as AppConfig['adapters']['telegram']);
    const instances = getTelegramInstances(config);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.name).toBeNull();
    expect(instances[0]!.token).toBe('bot123:ABC');
    expect(instances[0]!.poll_timeout).toBe(30);
  });

  it('legacy single-bot form preserves plugin field', () => {
    const config = makeConfig({ token: 'bot123:ABC', poll_timeout: 30, plugin: 'my-plugin' } as AppConfig['adapters']['telegram']);
    const instances = getTelegramInstances(config);
    expect(instances[0]!.plugin).toBe('my-plugin');
  });

  it('named-record form returns one entry per key with correct names', () => {
    const config = makeConfig({
      peggy: { token: 'bot-peggy:XYZ', poll_timeout: 30 },
      jarvis: { token: 'bot-jarvis:ABC', poll_timeout: 60 },
    } as AppConfig['adapters']['telegram']);
    const instances = getTelegramInstances(config);
    expect(instances).toHaveLength(2);
    const peggy = instances.find((i) => i.name === 'peggy');
    const jarvis = instances.find((i) => i.name === 'jarvis');
    expect(peggy?.token).toBe('bot-peggy:XYZ');
    expect(jarvis?.poll_timeout).toBe(60);
  });

  it('throws on duplicate tokens across instances', () => {
    const config = makeConfig({
      peggy: { token: 'shared-token:ABC', poll_timeout: 30 },
      jarvis: { token: 'shared-token:ABC', poll_timeout: 30 },
    } as AppConfig['adapters']['telegram']);
    expect(() => getTelegramInstances(config)).toThrow(/Duplicate Telegram bot token/);
    expect(() => getTelegramInstances(config)).toThrow(/"jarvis"/);
  });

  it('throws on instance name containing a colon', () => {
    const config = makeConfig({
      'my:bot': { token: 'tok:A', poll_timeout: 30 },
    } as AppConfig['adapters']['telegram']);
    expect(() => getTelegramInstances(config)).toThrow(/Invalid Telegram instance name/);
    expect(() => getTelegramInstances(config)).toThrow(/"my:bot"/);
  });

  it('throws on instance name containing a slash', () => {
    const config = makeConfig({
      'my/bot': { token: 'tok:B', poll_timeout: 30 },
    } as AppConfig['adapters']['telegram']);
    expect(() => getTelegramInstances(config)).toThrow(/Invalid Telegram instance name/);
  });

  it('throws on instance name with uppercase letters', () => {
    const config = makeConfig({
      'MyBot': { token: 'tok:C', poll_timeout: 30 },
    } as AppConfig['adapters']['telegram']);
    expect(() => getTelegramInstances(config)).toThrow(/Invalid Telegram instance name/);
  });

  it('accepts instance names with lowercase letters, digits, hyphens, and underscores', () => {
    const config = makeConfig({
      'my-bot_2': { token: 'tok:D', poll_timeout: 30 },
    } as AppConfig['adapters']['telegram']);
    const instances = getTelegramInstances(config);
    expect(instances[0]!.name).toBe('my-bot_2');
  });
});

describe('getCcHeadlessInstances', () => {
  function configWith(headless: unknown): AppConfig {
    const base = makeConfig(undefined);
    return { ...base, adapters: { ...base.adapters, 'cc-headless': headless } } as unknown as AppConfig;
  }

  it('returns empty array when cc-headless is not configured', () => {
    expect(getCcHeadlessInstances(configWith(undefined))).toEqual([]);
  });

  it('legacy single-instance form returns one entry with name=null', () => {
    const config = AppConfigSchema.parse({
      bus: { db_path: ':memory:' },
      adapters: { 'cc-headless': { agent_id: 'peggy', system_prompt: 'You are Peggy.' } },
      memory: {},
    });
    const instances = getCcHeadlessInstances(config);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.name).toBeNull();
    expect(instances[0]!.agent_id).toBe('peggy');
    expect(instances[0]!.system_prompt).toBe('You are Peggy.');
  });

  it('named-record form returns one entry per key with correct names', () => {
    const config = AppConfigSchema.parse({
      bus: { db_path: ':memory:' },
      adapters: {
        'cc-headless': {
          peggy: { agent_id: 'peggy', system_prompt: 'You are Peggy.' },
          pokeclaude: { agent_id: 'pokeclaude', system_prompt: 'You are pokeclaude.' },
        },
      },
      memory: {},
    });
    const instances = getCcHeadlessInstances(config);
    expect(instances).toHaveLength(2);
    const peggy = instances.find((i) => i.name === 'peggy');
    const pokeclaude = instances.find((i) => i.name === 'pokeclaude');
    expect(peggy?.agent_id).toBe('peggy');
    expect(pokeclaude?.agent_id).toBe('pokeclaude');
  });

  it('throws on duplicate agent_id across instances', () => {
    const config = AppConfigSchema.parse({
      bus: { db_path: ':memory:' },
      adapters: {
        'cc-headless': {
          peggy: { agent_id: 'shared', system_prompt: 'A' },
          pokeclaude: { agent_id: 'shared', system_prompt: 'B' },
        },
      },
      memory: {},
    });
    expect(() => getCcHeadlessInstances(config)).toThrow(/Duplicate cc-headless agent_id/);
    expect(() => getCcHeadlessInstances(config)).toThrow(/"pokeclaude"/);
  });

  it('throws on invalid instance name', () => {
    const config = AppConfigSchema.parse({
      bus: { db_path: ':memory:' },
      adapters: {
        'cc-headless': {
          'My Agent': { agent_id: 'a', system_prompt: 'A' },
        },
      },
      memory: {},
    });
    expect(() => getCcHeadlessInstances(config)).toThrow(/Invalid cc-headless instance name/);
  });
});

describe('AppConfigSchema — agents (E17)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };

  it('defaults agents to empty object when omitted', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.agents).toEqual({});
  });

  it('parses a full agent media block', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      agents: {
        'agent:claude': {
          media: { download_path: '/tmp/agentbus/claude', ttl_seconds: 7200 },
        },
      },
    });
    expect(parsed.agents['agent:claude']?.media?.download_path).toBe('/tmp/agentbus/claude');
    expect(parsed.agents['agent:claude']?.media?.ttl_seconds).toBe(7200);
  });

  it('defaults ttl_seconds to 3600 when omitted', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      agents: {
        'agent:claude': {
          media: { download_path: '/tmp/agentbus/claude' },
        },
      },
    });
    expect(parsed.agents['agent:claude']?.media?.ttl_seconds).toBe(3600);
  });

  it('allows an agent entry with no media block', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      agents: {
        'agent:claude': {},
      },
    });
    expect(parsed.agents['agent:claude']?.media).toBeUndefined();
  });

  it('rejects negative or zero ttl_seconds', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        agents: {
          'agent:claude': { media: { download_path: '/tmp', ttl_seconds: -1 } },
        },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        agents: {
          'agent:claude': { media: { download_path: '/tmp', ttl_seconds: 0 } },
        },
      }),
    ).toThrow();
  });

  it('rejects empty download_path', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        agents: {
          'agent:claude': { media: { download_path: '' } },
        },
      }),
    ).toThrow();
  });

  it('rejects relative download_path', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        agents: {
          'agent:claude': { media: { download_path: './media' } },
        },
      }),
    ).toThrow();
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        agents: {
          'agent:claude': { media: { download_path: 'media/downloads' } },
        },
      }),
    ).toThrow();
  });
});

describe('AppConfigSchema — bus.host', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };

  it('defaults bus.host to 127.0.0.1 (loopback only)', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.bus.host).toBe('127.0.0.1');
  });

  it('accepts an explicit host override', () => {
    const parsed = AppConfigSchema.parse({ ...base, bus: { ...base.bus, host: '0.0.0.0' } });
    expect(parsed.bus.host).toBe('0.0.0.0');
  });
});

describe('AppConfigSchema — pebble (E25)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };

  it('defaults adapters.pebble.enabled to true and max_body_bytes to 65536 when the block is present', () => {
    const parsed = AppConfigSchema.parse({ ...base, adapters: { pebble: {} } });
    expect(parsed.adapters.pebble?.enabled).toBe(true);
    expect(parsed.adapters.pebble?.max_body_bytes).toBe(65536);
  });

  it('allows adapters.pebble to be omitted entirely', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.adapters.pebble).toBeUndefined();
  });

  it('parses a contact with a pebble token', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      contacts: {
        chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: 'tok-chris' } } },
      },
    });
    expect(parsed.contacts['chris']?.platforms.pebble?.token).toBe('tok-chris');
  });

  it('rejects an empty pebble token', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        contacts: {
          chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: '' } } },
        },
      }),
    ).toThrow();
  });

  it('rejects two contacts sharing the same pebble token', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        contacts: {
          chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: 'shared' } } },
          alice: { id: 'alice', displayName: 'Alice', platforms: { pebble: { token: 'shared' } } },
        },
      }),
    ).toThrow(/Duplicate pebble token/);
  });

  it('allows distinct contacts with distinct pebble tokens', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      contacts: {
        chris: { id: 'chris', displayName: 'Chris', platforms: { pebble: { token: 'tok-chris' } } },
        alice: { id: 'alice', displayName: 'Alice', platforms: { pebble: { token: 'tok-alice' } } },
      },
    });
    expect(parsed.contacts['chris']?.platforms.pebble?.token).toBe('tok-chris');
    expect(parsed.contacts['alice']?.platforms.pebble?.token).toBe('tok-alice');
  });
});

describe('AppConfigSchema — pipeline.relays (E26)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };

  it('defaults pipeline.relays to an empty array', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.pipeline.relays).toEqual([]);
  });

  it('parses a relay rule and defaults target.template to {{body}}', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      pipeline: {
        relays: [{ match: { channel: 'pebble' }, target: { channel: 'telegram:peggy' } }],
      },
    });
    expect(parsed.pipeline.relays).toEqual([
      { match: { channel: 'pebble' }, target: { channel: 'telegram:peggy', template: '{{body}}' } },
    ]);
  });

  it('parses an explicit template', () => {
    const parsed = AppConfigSchema.parse({
      ...base,
      pipeline: {
        relays: [
          {
            match: { channel: 'pebble', sender: 'contact:chris' },
            target: { channel: 'telegram:peggy', template: 'Pebble ring voice note:\n{{body}}' },
          },
        ],
      },
    });
    expect(parsed.pipeline.relays[0]?.target.template).toBe('Pebble ring voice note:\n{{body}}');
  });

  it('rejects a relay rule with no target.channel', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        pipeline: { relays: [{ match: {}, target: {} }] },
      }),
    ).toThrow();
  });
});

describe('AppConfigSchema — cc-headless memory + journaling (E20)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };

  function parseHeadless(overrides: Record<string, unknown> = {}) {
    const parsed = AppConfigSchema.parse({
      ...base,
      adapters: {
        'cc-headless': { system_prompt: 'You are an assistant.', ...overrides },
      },
    });
    return parsed.adapters['cc-headless'] as CcHeadlessAdapterConfig;
  }

  it('memory + journaling defaults parse', () => {
    const h = parseHeadless();
    expect(h.memory).toEqual({
      dir: 'memory',
      index_file: 'MEMORY.md',
      daily_subdir: 'daily',
      journal_lookback_days: 3,
    });
    expect(h.journaling.enabled).toBe(true);
    expect(h.journaling.threshold_ms).toEqual({ default: 1_800_000 });
    expect(h.journaling.prompt).toMatch(/journaling turn/);
  });

  it('accepts a flat-number threshold_ms', () => {
    const h = parseHeadless({ journaling: { threshold_ms: 60_000 } });
    expect(h.journaling.threshold_ms).toBe(60_000);
  });

  it('accepts a per-channel threshold_ms record with default', () => {
    const h = parseHeadless({
      journaling: { threshold_ms: { telegram: 1_800_000, email: 86_400_000, default: 1_800_000 } },
    });
    expect(h.journaling.threshold_ms).toEqual({
      telegram: 1_800_000,
      email: 86_400_000,
      default: 1_800_000,
    });
  });

  it('rejects a per-channel threshold_ms without a default key', () => {
    expect(() => parseHeadless({ journaling: { threshold_ms: { telegram: 1_800_000 } } })).toThrow();
  });

  it('rejects a negative / zero threshold_ms', () => {
    expect(() => parseHeadless({ journaling: { threshold_ms: -1 } })).toThrow();
    expect(() => parseHeadless({ journaling: { threshold_ms: 0 } })).toThrow();
  });

  it('rejects a negative journal_lookback_days', () => {
    expect(() => parseHeadless({ memory: { journal_lookback_days: -1 } })).toThrow();
  });

  it('allows journal_lookback_days of 0', () => {
    const h = parseHeadless({ memory: { journal_lookback_days: 0 } });
    expect(h.memory.journal_lookback_days).toBe(0);
  });

  it('defaults memory.structured_extraction to false', () => {
    const parsed = AppConfigSchema.parse(base);
    expect(parsed.memory.structured_extraction).toBe(false);
  });
});

describe('journalingThresholdForChannel (E20)', () => {
  it('flat number applies to any channel', () => {
    expect(journalingThresholdForChannel(60_000, 'telegram')).toBe(60_000);
    expect(journalingThresholdForChannel(60_000, 'email')).toBe(60_000);
  });

  it('record resolves the channel-specific value', () => {
    const t = { telegram: 1_800_000, email: 86_400_000, default: 900_000 };
    expect(journalingThresholdForChannel(t, 'telegram')).toBe(1_800_000);
    expect(journalingThresholdForChannel(t, 'email')).toBe(86_400_000);
  });

  it('record falls back to default for an unlisted channel', () => {
    const t = { telegram: 1_800_000, default: 900_000 };
    expect(journalingThresholdForChannel(t, 'sms')).toBe(900_000);
  });
});
