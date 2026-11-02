import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../config/schema.js';
import { computeConversationId } from '../pipeline/conversation-id.js';
import { topicForThreadKey } from '../pipeline/types.js';
import { upsertThread } from '../pipeline/thread-store.js';
import { shareContext, resolveTelegramTopic } from './context-share.js';
import { primaryConversationChannel } from './main.js';
import { buildPendingContext, pendingContextLimits } from './pending-context.js';

// share_context `topic`: deliver a hidden note to a Telegram forum topic's conversation.

const DM = 'telegram:peggy';
const CHAT = -1001234567890;
const THREAD = 77;
const GROUP = `${DM}:group:${CHAT}`;
const TOPIC = topicForThreadKey(`${CHAT}:${THREAD}`); // what the adapter derives for an inbound topic message

const config = AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: { telegram: { peggy: { token: 't' } } }, memory: {},
  contacts: { alice: { id: 'alice', displayName: 'Alice', platforms: { telegram: { userId: 1001 } } } },
  agents: { 'agent:peggy': { pending_context: { channels: [DM] } } },
  pipeline: { routes: [
    { match: { channel: DM }, target: { adapterId: 'cc-pool', recipientId: 'agent:peggy' } },
    { match: { channel: 'app' }, target: { adapterId: 'cc-headless', recipientId: 'agent:work' } },
  ] },
}) as AppConfig;

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

function fixture() {
  const db = new Database(':memory:'); runMigrations(db); dbs.push(db);
  // The adapter records a topic like this when it creates it or sees a message/service message in it.
  upsertThread(db, { channel: GROUP, topic: TOPIC, threadKey: `${CHAT}:${THREAD}`, metadata: { chatId: CHAT, messageThreadId: THREAD, topicName: 'Highlander Replacement' } });
  const share = (over: Record<string, unknown> = {}) =>
    shareContext(db, config, { contactId: 'alice', body: 'Decided on the hybrid', source: 'Claude Code: baxter', channel: DM, ...over });
  return { db, share };
}

describe('shareContext with topic', () => {
  it('stores the note under the conversation key an inbound message from that topic uses', () => {
    const { db, share } = fixture();
    const res = share({ topic: TOPIC });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // route-resolve: computeConversationId(contactId, e.channel, e.topic) with channel = <bot>:group:<chatId>, topic = thread:<hash>
    const inboundKey = computeConversationId('alice', GROUP, topicForThreadKey(`${CHAT}:${THREAD}`));
    expect(res.conversationId).toBe(inboundKey);
    expect(res.topic).toBe(TOPIC);
    const row = db.prepare(`SELECT conversation_id, channel, direction, metadata FROM transcripts WHERE message_id = ?`).get(res.messageId) as
      { conversation_id: string; channel: string; direction: string; metadata: string };
    expect(row).toMatchObject({ conversation_id: inboundKey, channel: GROUP, direction: 'outbound' });
    expect(JSON.parse(row.metadata)).toMatchObject({ context_only: true, origin: { kind: 'external', label: 'Claude Code: baxter' } });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE conversation_id = ?`).get(computeConversationId('alice', DM, 'general'))).toEqual({ n: 0 });
  });

  it('accepts the topic name, case-insensitively, and resolves to the same conversation', () => {
    const { share } = fixture();
    const byId = share({ topic: TOPIC });
    const byName = share({ topic: 'highlander replacement' });
    expect(byName.ok && byId.ok && byName.conversationId === byId.conversationId).toBe(true);
  });

  it('creates a placeholder session for a topic with no session, then reuses it', () => {
    const { db, share } = fixture();
    const a = share({ topic: TOPIC }); const b = share({ topic: TOPIC });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(b.sessionId).toBe(a.sessionId);
    expect(db.prepare(`SELECT channel, agent_id, message_count FROM sessions WHERE id = ?`).get(a.sessionId))
      .toEqual({ channel: GROUP, agent_id: 'agent:peggy', message_count: 0 });
  });

  it('is read by the topic on its next turn, and only once it holds a note', () => {
    const { db, share } = fixture();
    const conv = computeConversationId('alice', GROUP, TOPIC);
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,'x','x')`).run(conv, 'alice', GROUP, TOPIC);
    expect(primaryConversationChannel(db, conv, config)).toBeNull();
    share({ topic: TOPIC });
    expect(primaryConversationChannel(db, conv, config)).toBe(GROUP);
    expect(buildPendingContext(db, conv, { limits: pendingContextLimits(config, 'agent:peggy') })!.block).toContain('Decided on the hybrid');
  });

  it('rejects topic with the app channel', () => {
    const { share } = fixture();
    const res = share({ channel: 'app', topic: TOPIC });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(!res.ok && res.error).toMatch(/only valid with a Telegram channel/);
  });

  it('rejects a call from a turn inside the targeted topic, but allows other conversations', () => {
    const { share } = fixture();
    const self = share({ topic: TOPIC, origin: { kind: 'turn', agent_id: 'agent:peggy', conversation_id: computeConversationId('alice', GROUP, TOPIC) } });
    expect(self).toMatchObject({ ok: false, status: 409 });
    expect(!self.ok && self.error).toMatch(/topic it targets/);
    const fromDm = share({ topic: TOPIC, origin: { kind: 'turn', agent_id: 'agent:peggy', conversation_id: computeConversationId('alice', DM, 'general') } });
    expect(fromDm.ok).toBe(true);
    // And the DM-targeting guard is unchanged: a turn in the topic may write to the DM.
    expect(share({ origin: { kind: 'turn', agent_id: 'agent:peggy', conversation_id: computeConversationId('alice', GROUP, TOPIC) } }).ok).toBe(true);
  });

  it('gives clear errors for unknown, malformed and ambiguous topics', () => {
    const { db, share } = fixture();
    expect(share({ topic: 'thread:ffffffffffffffff' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Unknown topic/) });
    expect(share({ topic: 'thread:xyz' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Malformed topic id/) });
    expect(share({ topic: 'No Such Topic' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Unknown topic/) });
    const other = topicForThreadKey(`${CHAT}:78`);
    upsertThread(db, { channel: GROUP, topic: other, threadKey: `${CHAT}:78`, metadata: { chatId: CHAT, messageThreadId: 78, topicName: 'highlander replacement' } });
    expect(share({ topic: 'Highlander Replacement' })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/ambiguous/) });
    expect(share({ topic: other }).ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transcripts`).get()).toEqual({ n: 1 });
  });

  it('does not resolve another bot\'s topics', () => {
    const { db } = fixture();
    expect(resolveTelegramTopic(db, 'telegram:pokeclaude', TOPIC)).toMatchObject({ ok: false });
  });

  it('leaves the default path unchanged: no topic still writes to the DM\'s general conversation', () => {
    const { db, share } = fixture();
    const res = share();
    if (!res.ok) throw new Error('expected ok');
    expect(res.conversationId).toBe(computeConversationId('alice', DM, 'general'));
    expect(res).not.toHaveProperty('topic');
    expect(db.prepare(`SELECT channel FROM transcripts WHERE message_id = ?`).get(res.messageId)).toEqual({ channel: DM });
  });
});
