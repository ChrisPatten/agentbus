import { describe, expect, it } from 'vitest';
import { IntercomAdapterSchema } from './schema.js';

describe('adapters.intercom schema', () => {
  it('applies the documented defaults', () => {
    const cfg = IntercomAdapterSchema.parse({ surfaces: [{ id: 'iphone-proto', token_env: 'INTERCOM_IPHONE_TOKEN', follow: { contact: 'contact:chris', channel: 'telegram:peggy' } }] });
    expect(cfg).toMatchObject({ enabled: true, interaction_grace_s: 120, echo_to_followed: true, event_retention_days: 7, hello_timeout_ms: 5000,
      calendar: { calendars: [], cache_s: 300, calctl_path: 'calctl', timezone: 'America/New_York' } });
    expect(cfg.surfaces[0]).toMatchObject({ profile: 'round466', follow: { contact: 'chris', channel: 'telegram:peggy' } });
    expect(cfg.surfaces[0]!.follow.topic).toBeUndefined();
  });
  it('rejects duplicate surface ids, bad ids and bad env names', () => {
    const s = { token_env: 'T', follow: { contact: 'chris', channel: 'telegram:peggy' } };
    expect(() => IntercomAdapterSchema.parse({ surfaces: [{ id: 'a', ...s }, { id: 'a', ...s }] })).toThrow(/Duplicate/);
    expect(() => IntercomAdapterSchema.parse({ surfaces: [{ id: 'Bad Id', ...s }] })).toThrow();
    expect(() => IntercomAdapterSchema.parse({ surfaces: [{ id: 'a', ...s, token_env: 'not valid!' }] })).toThrow();
  });
});
