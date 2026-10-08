import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { OwnerDirectory, isOwner, ownerConversations } from './owners.js';

const contacts = {
  chris: { id: 'chris', displayName: 'Chris', platforms: { telegram: { userId: 1 } } },
  alice: { id: 'alice', displayName: 'Alice', platforms: { telegram: { userId: 2 } } },
};

function parse(agents: unknown) {
  return AppConfigSchema.safeParse({
    bus: { db_path: ':memory:' },
    adapters: {
      'cc-pool': { agent_id: 'peggy', tmux_session: 'peggy-pool', claude_bin: '/usr/local/bin/claude', working_dir: '/agents/peggy' },
    },
    contacts,
    memory: {},
    agents,
  });
}

function makeConfig(): AppConfig {
  const result = parse({
    'agent:baxter': { owners: [{ channel: 'telegram:baxter', contact_id: 'chris' }, { channel: 'app', contact_id: 'chris' }] },
    'agent:peggy': { owners: [{ channel: 'telegram', contact_id: 'alice' }] },
    'agent:claude': { media: { download_path: '/tmp/claude' } },
  });
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe('owners config schema (E65 S65.1)', () => {
  it('leaves owners unset when not configured', () => {
    expect(makeConfig().agents['agent:claude']!.owners).toBeUndefined();
  });

  it('rejects an owner that is not a configured contact', () => {
    const result = parse({ 'agent:baxter': { owners: [{ channel: 'telegram', contact_id: 'mallory' }] } });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/mallory.*not defined under contacts/);
    expect(result.error!.issues[0]!.path).toEqual(['agents', 'agent:baxter', 'owners', 0, 'contact_id']);
  });

  it('rejects a prefixed contact id, an empty channel and duplicates', () => {
    expect(parse({ 'agent:baxter': { owners: [{ channel: 'telegram', contact_id: 'contact:chris' }] } }).success).toBe(false);
    expect(parse({ 'agent:baxter': { owners: [{ channel: '', contact_id: 'chris' }] } }).success).toBe(false);
    const dup = parse({ 'agent:baxter': { owners: [
      { channel: 'telegram', contact_id: 'chris' }, { channel: 'telegram', contact_id: 'chris' },
    ] } });
    expect(dup.success).toBe(false);
    expect(dup.error!.issues[0]!.message).toMatch(/Duplicate owner chris on telegram/);
  });
});

describe('OwnerDirectory (E65 S65.1)', () => {
  const dir = new OwnerDirectory(makeConfig());

  it('looks owners up by bare or prefixed agent id', () => {
    expect(dir.owners('baxter')).toEqual([
      { channel: 'telegram:baxter', contactId: 'chris' },
      { channel: 'app', contactId: 'chris' },
    ]);
    expect(dir.owners('agent:baxter')).toHaveLength(2);
    expect(dir.owners('agent:claude')).toEqual([]);
    expect(dir.owners('agent:nobody')).toEqual([]);
  });

  it('maps a cc-pool pane id to its pool', () => {
    expect(dir.logicalAgentId('agent:peggy-pool-3')).toBe('agent:peggy');
    expect(dir.owners('peggy-pool-1')).toEqual([{ channel: 'telegram', contactId: 'alice' }]);
    // Not a configured pool: left alone.
    expect(dir.logicalAgentId('agent:other-pool-1')).toBe('agent:other-pool-1');
  });

  it('isOwner matches contact and exact channel', () => {
    expect(dir.isOwner('agent:baxter', 'chris', 'telegram:baxter')).toBe(true);
    expect(dir.isOwner('agent:baxter', 'contact:chris', 'app')).toBe(true);
    // Wrong channel, a group derived from the owner channel, or wrong contact.
    expect(dir.isOwner('agent:baxter', 'chris', 'telegram')).toBe(false);
    expect(dir.isOwner('agent:baxter', 'chris', 'telegram:baxter:group:-100')).toBe(false);
    expect(dir.isOwner('agent:baxter', 'alice', 'app')).toBe(false);
  });

  it('ownerConversations returns each owner\'s default (general) conversation', () => {
    expect(dir.ownerConversations('agent:baxter')).toEqual([
      { channel: 'telegram:baxter', contactId: 'chris', topic: 'general',
        conversationId: computeConversationId('chris', 'telegram:baxter', 'general') },
      { channel: 'app', contactId: 'chris', topic: 'general',
        conversationId: computeConversationId('chris', 'app', 'general') },
    ]);
  });

  it('lists agents with owners and exposes one-off helpers', () => {
    const config = makeConfig();
    expect(dir.agentsWithOwners()).toEqual(['agent:baxter', 'agent:peggy']);
    expect(isOwner(config, 'peggy', 'alice', 'telegram')).toBe(true);
    expect(ownerConversations(config, 'claude')).toEqual([]);
  });
});
