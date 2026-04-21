import { describe, it, expect } from 'vitest';
import { AppConfigSchema, getTelegramInstances } from './schema.js';
import type { AppConfig } from './schema.js';

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
