import { describe, it, expect } from 'vitest';
import { AppConfigSchema, getEmailInstances } from './schema.js';
import type { AppConfig } from './schema.js';

/** Parse a partial config through the real schema so adapter defaults apply. */
function parse(adaptersEmail: unknown, contacts: unknown = {}): AppConfig {
  return AppConfigSchema.parse({
    bus: { db_path: ':memory:' },
    adapters: { email: adaptersEmail },
    contacts,
    memory: {},
  });
}

describe('getEmailInstances', () => {
  it('returns [] when email is not configured', () => {
    const config = AppConfigSchema.parse({ bus: { db_path: ':memory:' }, adapters: {}, memory: {} });
    expect(getEmailInstances(config)).toEqual([]);
  });

  it('single-account form returns one entry with name=null and iCloud defaults', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } });
    const inst = getEmailInstances(config);
    expect(inst).toHaveLength(1);
    expect(inst[0]!.name).toBeNull();
    expect(inst[0]!.imap.host).toBe('imap.mail.me.com');
    expect(inst[0]!.imap.port).toBe(993);
    expect(inst[0]!.imap.mailbox).toBe('INBOX');
    expect(inst[0]!.smtp.host).toBe('smtp.mail.me.com');
    expect(inst[0]!.require_auth).toBe(true);
  });

  it('named-record form returns one entry per account', () => {
    const config = parse({
      peggy: { imap: { user: 'peggy@icloud.com', password: 'pw1' } },
      work: { imap: { host: 'imap.fastmail.com', user: 'me@work.com', password: 'pw2' } },
    });
    const inst = getEmailInstances(config);
    expect(inst.map((i) => i.name).sort()).toEqual(['peggy', 'work']);
    expect(inst.find((i) => i.name === 'work')!.imap.host).toBe('imap.fastmail.com');
  });

  it('throws on duplicate mailbox across instances', () => {
    const config = parse({
      a: { imap: { user: 'same@icloud.com', password: 'x' } },
      b: { imap: { user: 'same@icloud.com', password: 'y' } },
    });
    expect(() => getEmailInstances(config)).toThrow(/Duplicate email account/);
  });

  it('throws on an invalid instance name', () => {
    const config = parse({ 'Bad Name': { imap: { user: 'a@icloud.com', password: 'x' } } });
    expect(() => getEmailInstances(config)).toThrow(/Invalid email instance name/);
  });

  it('smtp credentials default to the imap account', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } });
    const inst = getEmailInstances(config)[0]!;
    expect(inst.smtp.user).toBeUndefined(); // resolved at adapter construction
    expect(inst.smtp.from).toBeUndefined();
    expect(inst.imap.user).toBe('a@icloud.com');
  });
});

describe('contact email platform schema', () => {
  it('accepts a single address string', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } }, {
      chris: { id: 'chris', displayName: 'Chris', platforms: { email: { address: 'chris@example.com' } } },
    });
    expect(config.contacts['chris']!.platforms.email!.address).toBe('chris@example.com');
  });

  it('accepts a list of addresses', () => {
    const config = parse({ imap: { user: 'a@icloud.com', password: 'pw' } }, {
      chris: {
        id: 'chris',
        displayName: 'Chris',
        platforms: { email: { address: ['chris@example.com', 'chris@work.com'] } },
      },
    });
    expect(config.contacts['chris']!.platforms.email!.address).toEqual([
      'chris@example.com',
      'chris@work.com',
    ]);
  });
});
