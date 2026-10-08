import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from './schema.js';

const base = {
  bus: { http_port: 3000, db_path: ':memory:', log_level: 'info' },
  adapters: { app: { enabled: true } },
  memory: {}, pipeline: {}, scheduler: {},
};

describe('app credential configuration', () => {
  it('rejects short and duplicate contact tokens', () => {
    const contacts = {
      alice: { id: 'alice', displayName: 'Alice', platforms: { app: { token: 'shared-token-12345' } } },
      bob: { id: 'bob', displayName: 'Bob', platforms: { app: { token: 'shared-token-12345' } } },
    };
    expect(AppConfigSchema.safeParse({ ...base, contacts }).success).toBe(false);
    expect(AppConfigSchema.safeParse({ ...base, contacts: { alice: {
      ...contacts.alice, platforms: { app: { token: 'short' } },
    } } }).success).toBe(false);
  });

  it('defaults the local adapter limits', () => {
    const result = AppConfigSchema.parse({ ...base, contacts: {} });
    expect(result.adapters.app).toMatchObject({ enabled: true, event_retention_days: 30,
      max_upload_bytes: 25 * 1024 * 1024, ping_interval_ms: 30_000 });
  });
});
