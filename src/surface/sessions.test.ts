import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { collectDeskSessionDetails, collectDeskSessions, type DeskSessionDetail } from '../intercom/desk.js';
import { ChoiceStore } from '../choices/store.js';
import { resolveChoiceTap } from '../choices/tap.js';
import { clearAnswerNeeded, setAnswerNeeded, setSubject } from './flags.js';
import { buildSurfaceSessions, diffItems, sessionIdForPane, sessionsAsItems } from './sessions.js';
import { clearAnswerNeededOnInbound, onAnswerNeededCleared, pipelineConversationId } from './answer-needed.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60_000;
const iso = (offsetMin: number): string => new Date(NOW + offsetMin * MIN).toISOString();

const CONV = pipelineConversationId('chris', 'telegram:peggy', 'thread:abc');
const SCHED = pipelineConversationId('chris', 'telegram:peggy', 'sched:morning');

function register(db: Database.Database, id: string, topic: string, contact = 'chris', channel = 'telegram:peggy', lastSeen = iso(-5)): void {
  db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(id, contact, channel, topic, iso(-60), lastSeen);
}

const detail = (o: Partial<DeskSessionDetail>): DeskSessionDetail => ({
  id: 'agent:peggy-pool-1', agent_id: 'agent:peggy-pool-1', title: 'Intercom Build', state: 'idle', channel: 'telegram:peggy',
  since: iso(-10), conversation_id: CONV, topic: 'thread:abc', last_activity_at: iso(-10), ...o,
});

const build = (db: Database.Database, desk: DeskSessionDetail[], o: { timeout?: number; system?: boolean } = {}) =>
  buildSurfaceSessions({ db, desk, now: NOW, activityTimeoutMin: o.timeout ?? 30, includeSystem: o.system ?? false });

describe('buildSurfaceSessions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:'); runMigrations(db);
    register(db, CONV, 'thread:abc');
    register(db, SCHED, 'sched:morning');
  });

  it('maps a desk session, keyed by conversation id, with subject and no needs_you by default', () => {
    setSubject(db, CONV, 'Fixing the dial');
    const [s] = build(db, [detail({ state: 'working' })]);
    expect(s).toEqual({
      id: CONV, title: 'Intercom Build', subject: 'Fixing the dial', state: 'working', channel: 'telegram:peggy', conversation_id: CONV,
      since: iso(-10), last_activity_at: iso(-10), needs_you: false, needs_you_message_id: null, system: false,
    });
  });

  it('needs_you comes only from the answer_needed flag, never from a waiting desk state', () => {
    expect(build(db, [detail({ state: 'waiting' })])[0]).toMatchObject({ state: 'waiting', needs_you: false });
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'm1', agentId: 'agent:peggy-pool-1' }, NOW - MIN);
    expect(build(db, [detail({ state: 'idle' })])[0]).toMatchObject({ needs_you: true, needs_you_message_id: 'm1', last_activity_at: iso(-1) });
    clearAnswerNeeded(db, CONV);
    expect(build(db, [detail({ state: 'idle' })])[0]).toMatchObject({ needs_you: false, needs_you_message_id: null });
  });

  it('drops idle sessions past the activity timeout unless they need you; active states stay', () => {
    const old = detail({ last_activity_at: iso(-45), since: iso(-45) });
    expect(build(db, [old])).toHaveLength(0);
    expect(build(db, [old], { timeout: 60 })).toHaveLength(1);
    expect(build(db, [{ ...old, state: 'working' }])).toHaveLength(1);
    expect(build(db, [{ ...old, state: 'stuck' }])).toHaveLength(1);
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'm1' }, NOW - 50 * MIN);
    expect(build(db, [old])[0]).toMatchObject({ needs_you: true });
  });

  it('excludes system sessions by default (scheduled routine, system channel, agent contact)', () => {
    const agentConv = pipelineConversationId('agent:baxter', 'app', 'general');
    register(db, agentConv, 'general', 'agent:baxter', 'app');
    const desk = [
      detail({ id: 'agent:peggy-pool-2', agent_id: 'agent:peggy-pool-2', conversation_id: SCHED, topic: 'sched:morning', state: 'working' }),
      detail({ id: 'agent:peggy-pool-3', agent_id: 'agent:peggy-pool-3', conversation_id: agentConv, topic: 'general', state: 'working' }),
      detail({ state: 'working' }),
    ];
    expect(build(db, desk).map((s) => s.id)).toEqual([CONV]);
    const all = build(db, desk, { system: true });
    expect(all).toHaveLength(3);
    expect(all.filter((s) => s.system).map((s) => s.conversation_id).sort()).toEqual([SCHED, agentConv].sort());
    // A question in a system conversation is never hidden.
    setAnswerNeeded(db, { conversationId: SCHED, messageId: 'q' }, NOW);
    expect(build(db, desk).map((s) => s.id)).toEqual([SCHED, CONV]);
  });

  it('treats the channel+topic of an active cron schedule as system', () => {
    const conv = pipelineConversationId('chris', 'telegram:peggy', 'digest');
    register(db, conv, 'digest');
    db.prepare(`INSERT INTO scheduled_items(id,type,cron_expr,timezone,fire_at,channel,sender,payload_body,topic,priority,created_at,created_by,fire_count,status)
      VALUES ('s1','cron','0 7 * * *','UTC',?,'telegram:peggy','contact:chris','go','digest','normal',?, 'config', 0, 'active')`).run(iso(600), iso(-100));
    expect(build(db, [detail({ conversation_id: conv, topic: 'digest', state: 'working' })])).toHaveLength(0);
  });

  it('keeps an open question whose pane was released', () => {
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'm9', agentId: 'agent:peggy-pool-1' }, NOW - 120 * MIN);
    const out = build(db, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: CONV, state: 'idle', needs_you: true, needs_you_message_id: 'm9', channel: 'telegram:peggy', title: 'peggy topic' });
  });

  it('orders needs_you first, then the desk order, and is stable', () => {
    const c2 = pipelineConversationId('chris', 'app', 'thread:x');
    register(db, c2, 'thread:x', 'chris', 'app');
    const desk = [
      detail({ state: 'stuck', id: 'agent:p-1', agent_id: 'agent:p-1' }),
      detail({ state: 'idle', id: 'agent:p-2', agent_id: 'agent:p-2', conversation_id: c2, topic: 'thread:x' }),
      detail({ state: 'working', id: 'agent:p-3', agent_id: 'agent:p-3', conversation_id: null, topic: null }),
    ];
    setAnswerNeeded(db, { conversationId: c2, messageId: 'q' }, NOW);
    const ids = build(db, desk).map((s) => s.id);
    expect(ids).toEqual([c2, CONV, 'p-3']);
    expect(build(db, desk.slice().reverse()).map((s) => s.id)).toEqual(ids);
  });

  it('ids are ID_RE-safe for panes without a conversation', () => {
    expect(sessionIdForPane('agent:Peggy.Pool:2')).toBe('peggy-pool-2');
  });

  it('sessionsAsItems keys by id and diffItems emits only changes', () => {
    const items = sessionsAsItems(build(db, [detail({ state: 'working' })]));
    expect(Object.keys(items)).toEqual([CONV]);
    expect(diffItems(items, items)).toEqual([]);
    expect(diffItems({}, items)).toEqual([{ op: 'set', id: CONV, value: items[CONV] }]);
    expect(diffItems(items, {})).toEqual([{ op: 'remove', id: CONV }]);
  });
});

describe('answer_needed clearing', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); register(db, CONV, 'thread:abc'); });

  it('a button tap clears the flag (S96.6 acceptance)', () => {
    const store = new ChoiceStore(db);
    store.create({ id: 'p1', channel: 'telegram:peggy', topic: 'thread:abc', contactId: 'chris', labels: ['Yes', 'No'], platformMessageId: null, busMessageId: 'm1' }, 3600_000, new Date(NOW - MIN));
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'm1' }, NOW - MIN);
    expect(build(db, [detail({})])[0]!.needs_you).toBe(true);
    const seen: string[][] = [];
    const off = onAnswerNeededCleared((ids) => seen.push(ids));
    const tap = resolveChoiceTap(store, 'p1', 0, 'chris', 'contact:chris', new Date(NOW));
    off();
    expect(tap).toMatchObject({ outcome: 'answered', answer_needed_cleared: true });
    expect(seen).toEqual([[CONV]]);
    expect(build(db, [detail({})])[0]!.needs_you).toBe(false);
  });

  it('a tap with no flag reports nothing cleared', () => {
    const store = new ChoiceStore(db);
    store.create({ id: 'p2', channel: 'telegram:peggy', topic: 'thread:abc', contactId: null, labels: ['A'], platformMessageId: null, busMessageId: 'mx' }, 3600_000, new Date(NOW));
    expect(resolveChoiceTap(store, 'p2', 0, 'chris', 'contact:chris', new Date(NOW))).toMatchObject({ outcome: 'answered', answer_needed_cleared: false });
  });

  it('a reply from the contact clears it; scheduled fires and agents do not', () => {
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'm1' }, NOW);
    expect(clearAnswerNeededOnInbound(db, { channel: 'telegram:peggy', contactId: 'contact:chris', topic: 'thread:abc', metadata: { scheduled: true } })).toBe(false);
    expect(clearAnswerNeededOnInbound(db, { channel: 'telegram:peggy', contactId: 'agent:baxter', topic: 'thread:abc' })).toBe(false);
    expect(clearAnswerNeededOnInbound(db, { channel: 'telegram:peggy', contactId: 'contact:chris', topic: 'general' })).toBe(false);
    expect(clearAnswerNeededOnInbound(db, { channel: 'telegram:peggy', contactId: 'contact:chris', topic: 'thread:abc' })).toBe(true);
    expect(clearAnswerNeededOnInbound(db, { channel: 'telegram:peggy', contactId: 'chris', topic: 'thread:abc' })).toBe(false);
  });
});

describe('collectDeskSessionDetails', () => {
  it('adds conversation, topic and last activity without changing the /desk payload', () => {
    const db = new Database(':memory:'); runMigrations(db);
    register(db, 'conv1', 'thread:abc', 'chris', 'telegram:peggy', '2026-11-03T11:00:00Z');
    const lease = {
      pool_id: 'agent:peggy', pane_id: 'p:1', agent_id: 'agent:peggy-pool-1', conversation_id: 'conv1', claude_session_id: null, state: 'leased',
      leased_at: '2026-11-03T09:00:00Z', last_activity_at: '2026-11-03T10:00:00Z', last_turn_ended_at: null, model: null,
    };
    const pools = [{ poolId: 'agent:peggy', leaseStore: { list: () => [lease] as never } }];
    expect(collectDeskSessionDetails(db, pools, NOW)[0]).toMatchObject({ conversation_id: 'conv1', topic: 'thread:abc', last_activity_at: '2026-11-03T11:00:00Z', agent_id: 'agent:peggy-pool-1' });
    expect(Object.keys(collectDeskSessions(db, pools, NOW)[0]!).sort()).toEqual(['channel', 'id', 'since', 'state', 'title']);
  });
});
