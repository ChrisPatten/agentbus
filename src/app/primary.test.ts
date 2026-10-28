import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { isMainConversation, isPrimaryConversation, pendingContextAgent, primaryAgentForChannel, primaryChannels, primaryConversationChannel } from './main.js';
import { pendingContextLimits } from './pending-context.js';

// E83 S83.2 — primary conversations and the agent-level pending_context block.

const parse = (agents: Record<string, unknown>, app?: Record<string, unknown>) => AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: app ? { app } : {}, memory: {}, agents,
}) as AppConfig;

const config = parse({ 'agent:peggy': { pending_context: { channels: ['telegram:peggy'] } } });

function fixture() {
  const db = new Database(':memory:');
  runMigrations(db);
  const conv = (contact: string, channel: string, topic: string) => {
    const id = computeConversationId(contact, channel, topic);
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,'x','x')`)
      .run(id, contact, channel, topic);
    return id;
  };
  return { db, conv };
}

describe('isPrimaryConversation (E83)', () => {
  it('is true for Main, a listed DM and another contact\'s listed DM or Main', () => {
    const f = fixture();
    try {
      expect(isPrimaryConversation(f.db, f.conv('alice', 'app', 'general'), config)).toBe(true);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'telegram:peggy', 'general'), config)).toBe(true);
      expect(isPrimaryConversation(f.db, f.conv('bob', 'telegram:peggy', 'general'), config)).toBe(true);
      expect(isPrimaryConversation(f.db, f.conv('bob', 'app', 'general'), config)).toBe(true);
    } finally { f.db.close(); }
  });

  it('is false for an unlisted DM, a group, a forum thread, other topics, other channels and unknown ids', () => {
    const f = fixture();
    try {
      // The same bus carries another agent's bot and Peggy's other channels: none change unasked.
      expect(isPrimaryConversation(f.db, f.conv('alice', 'telegram:pokeclaude', 'general'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'telegram:peggy:group:-1001', 'general'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'telegram:peggy', 'thread:0123456789abcdef'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'app', 'thread:0123456789abcdef'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'email:peggy', 'general'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'system:peggy', 'general'), config)).toBe(false);
      expect(isPrimaryConversation(f.db, 'no-such-conversation', config)).toBe(false);
    } finally { f.db.close(); }
  });

  it('is opt-in: an unlisted config makes only Main primary, and Main rotation stays app-only', () => {
    const f = fixture();
    try {
      const bare = parse({});
      const dm = f.conv('alice', 'telegram:peggy', 'general');
      expect(isPrimaryConversation(f.db, dm, bare)).toBe(false);
      expect(isPrimaryConversation(f.db, f.conv('alice', 'app', 'general'), bare)).toBe(true);
      // The listed DM is primary but still not Main: rotation and teardown (isMainConversation) don't apply.
      expect(isPrimaryConversation(f.db, dm, config)).toBe(true);
      expect(isMainConversation(f.db, dm)).toBe(false);
    } finally { f.db.close(); }
  });

  it('reports the channel and the listing agent', () => {
    const f = fixture();
    try {
      expect(primaryConversationChannel(f.db, f.conv('alice', 'telegram:peggy', 'general'), config)).toBe('telegram:peggy');
      expect(primaryConversationChannel(f.db, f.conv('alice', 'app', 'general'), config)).toBe('app');
      expect(primaryConversationChannel(f.db, f.conv('alice', 'telegram:other', 'general'), config)).toBeNull();
      expect(primaryChannels(config)).toEqual(['telegram:peggy']);
      expect(primaryAgentForChannel(config, 'telegram:peggy')).toBe('agent:peggy');
      expect(primaryAgentForChannel(config, 'telegram:pokeclaude')).toBeNull();
      expect(pendingContextAgent(config, 'telegram:peggy')).toBe('agent:peggy');
      expect(pendingContextAgent(config, 'app')).toBeUndefined();
    } finally { f.db.close(); }
  });
});

describe('agents.<id>.pending_context (E83)', () => {
  it('defaults channels to [] and leaves the limits to fall back', () => {
    const c = parse({ 'agent:peggy': { pending_context: {} } });
    expect(c.agents['agent:peggy']!.pending_context).toEqual({ channels: [] });
    expect(primaryChannels(c)).toEqual([]);
  });

  it('falls back to adapters.app.pending_context field by field, then the schema defaults', () => {
    const peggy = { channels: ['telegram:peggy'] };
    expect(pendingContextLimits(parse({ 'agent:peggy': { pending_context: peggy } }), 'agent:peggy'))
      .toEqual({ max_items: 10, max_chars: 4000, context_ttl_ms: 86_400_000 });
    const app = { pending_context: { max_items: 3, max_chars: 900, context_ttl_ms: 1000 } };
    expect(pendingContextLimits(parse({ 'agent:peggy': { pending_context: peggy } }, app), 'agent:peggy'))
      .toEqual({ max_items: 3, max_chars: 900, context_ttl_ms: 1000 });
    // An agent's own value overrides the app's, only for the fields it sets.
    const override = parse({ 'agent:peggy': { pending_context: { ...peggy, max_chars: 200, context_ttl_ms: 0 } } }, app);
    expect(pendingContextLimits(override, 'agent:peggy')).toEqual({ max_items: 3, max_chars: 200, context_ttl_ms: 0 });
    // The app's Main (no agent) is untouched by the agent's block.
    expect(pendingContextLimits(override)).toEqual({ max_items: 3, max_chars: 900, context_ttl_ms: 1000 });
  });

  it('resolves the bare and the prefixed agent key, for the lookup id in either form', () => {
    for (const key of ['peggy', 'agent:peggy']) {
      const c = parse({ [key]: { pending_context: { channels: ['telegram:peggy'], max_items: 2 } } });
      expect(pendingContextLimits(c, 'agent:peggy').max_items).toBe(2);
      expect(pendingContextLimits(c, 'peggy').max_items).toBe(2);
      expect(pendingContextLimits(c, 'agent:other').max_items).toBe(10);
      expect(primaryAgentForChannel(c, 'telegram:peggy')).toBe('agent:peggy');
    }
  });
});
