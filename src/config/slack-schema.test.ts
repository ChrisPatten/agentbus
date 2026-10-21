import { describe, it, expect } from 'vitest';
import { AppConfigSchema } from './schema.js';

describe('AppConfigSchema — slack (E76)', () => {
  const base = {
    bus: { db_path: ':memory:' },
    adapters: {},
    memory: {},
  };
  const slack = {
    webhook_url: 'https://n8n.example.com/webhook/agentbus/slack-dm',
    jwt_secret: 'a-shared-n8n-passphrase-of-32-chars!',
  };

  it('applies defaults', () => {
    const parsed = AppConfigSchema.parse({ ...base, adapters: { slack } });
    expect(parsed.adapters.slack).toEqual({
      enabled: true,
      ...slack,
      jwt_ttl_seconds: 60,
      request_timeout_ms: 10000,
    });
  });

  it('allows adapters.slack to be omitted', () => {
    expect(AppConfigSchema.parse(base).adapters.slack).toBeUndefined();
  });

  it('requires webhook_url and jwt_secret', () => {
    expect(() => AppConfigSchema.parse({ ...base, adapters: { slack: { jwt_secret: slack.jwt_secret } } })).toThrow();
    expect(() => AppConfigSchema.parse({ ...base, adapters: { slack: { webhook_url: slack.webhook_url } } })).toThrow();
  });

  it('rejects a non-http webhook_url and a short secret', () => {
    expect(() =>
      AppConfigSchema.parse({ ...base, adapters: { slack: { ...slack, webhook_url: 'ftp://n8n.example.com/x' } } }),
    ).toThrow(/http\(s\)/);
    expect(() => AppConfigSchema.parse({ ...base, adapters: { slack: { ...slack, jwt_secret: 'short' } } })).toThrow();
  });

  it('accepts a Slack member id on a contact and rejects a malformed one', () => {
    const contact = (user_id: string) => ({
      ...base,
      contacts: { chris: { id: 'chris', displayName: 'Chris', platforms: { slack: { user_id } } } },
    });
    expect(AppConfigSchema.parse(contact('U012ABCDEF')).contacts['chris']?.platforms.slack?.user_id).toBe('U012ABCDEF');
    expect(AppConfigSchema.parse(contact('W012ABCDEF')).contacts['chris']?.platforms.slack?.user_id).toBe('W012ABCDEF');
    expect(() => AppConfigSchema.parse(contact('chris'))).toThrow(/Slack member id/);
    expect(() => AppConfigSchema.parse(contact('C012ABCDEF'))).toThrow(/Slack member id/);
  });

  it('rejects two contacts with the same Slack user id', () => {
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        contacts: {
          chris: { id: 'chris', displayName: 'Chris', platforms: { slack: { user_id: 'U012ABCDEF' } } },
          alice: { id: 'alice', displayName: 'Alice', platforms: { slack: { user_id: 'U012ABCDEF' } } },
        },
      }),
    ).toThrow(/Duplicate slack user_id — also used by contact/);
  });
});
