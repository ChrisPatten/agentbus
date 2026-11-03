import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ChoiceStore } from '../choices/store.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { setAnswerNeeded } from './flags.js';
import { pipelineConversationId } from './answer-needed.js';
import { clipText, conversationIdForEnvelope, getConversationPage, MAX_MESSAGE_TEXT, messageForLiveAppend } from './conversations.js';

const CONV = pipelineConversationId('chris', 'telegram:peggy', 'thread:abc');
const T = (i: number): string => new Date(Date.parse('2026-11-03T10:00:00Z') + i * 60_000).toISOString();

let n = 0;
function row(db: Database.Database, o: { id: string; dir?: 'inbound' | 'outbound'; body?: string; at?: string; meta?: Record<string, unknown> }): void {
  db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`t${++n}`, o.id, CONV, 's1', o.at ?? T(n), 'telegram:peggy', 'chris', o.dir ?? 'inbound', o.body ?? `body ${o.id}`, JSON.stringify(o.meta ?? {}));
}

describe('getConversationPage', () => {
  let db: Database.Database;
  beforeEach(() => {
    n = 0;
    db = new Database(':memory:'); runMigrations(db);
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(CONV, 'chris', 'telegram:peggy', 'thread:abc', T(0), T(0));
    db.prepare(`INSERT INTO threads(channel,topic,thread_key,metadata,updated_at) VALUES ('telegram:peggy','thread:abc','k','{"topicName":"Intercom Build"}','x')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count) VALUES ('s1',?,?,?,?,?,0)`).run(CONV, 'telegram:peggy', 'chris', T(0), T(0));
  });

  it('returns null for an unknown conversation', () => {
    expect(getConversationPage(db, { conversationId: 'nope' })).toBeNull();
  });

  it('pages with before: newest page first, chronological within a page, stable on equal timestamps (S96.7 acceptance)', () => {
    // m4, m5, m6 share a timestamp; insertion order breaks the tie.
    for (let i = 1; i <= 7; i++) row(db, { id: `m${i}`, dir: i % 2 ? 'inbound' : 'outbound', at: i >= 4 && i <= 6 ? T(50) : T(i * 10) });
    const p1 = getConversationPage(db, { conversationId: CONV, limit: 3 })!;
    expect(p1.title).toBe('Intercom Build');
    expect(p1.messages.map((m) => m.id)).toEqual(['m5', 'm6', 'm7']);
    expect(p1.next_before).toBe('m5');
    const p2 = getConversationPage(db, { conversationId: CONV, limit: 3, before: p1.next_before })!;
    expect(p2.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    const p3 = getConversationPage(db, { conversationId: CONV, limit: 3, before: p2.next_before })!;
    expect(p3.messages.map((m) => m.id)).toEqual(['m1']);
    expect(p3.next_before).toBeNull();
    expect(p1.messages[0]).toMatchObject({ role: 'user', text: 'body m5' });
    expect(p1.messages[1]).toMatchObject({ role: 'agent' });
  });

  it('an exact final page has no next_before; an unknown cursor gives an empty page', () => {
    for (let i = 1; i <= 3; i++) row(db, { id: `m${i}` });
    expect(getConversationPage(db, { conversationId: CONV, limit: 3 })!.next_before).toBeNull();
    expect(getConversationPage(db, { conversationId: CONV, before: 'zzz' })).toMatchObject({ messages: [], next_before: null });
  });

  it('clamps limit to 1..100 (default 30)', () => {
    for (let i = 1; i <= 120; i++) row(db, { id: `m${i}` });
    expect(getConversationPage(db, { conversationId: CONV })!.messages).toHaveLength(30);
    expect(getConversationPage(db, { conversationId: CONV, limit: 500 })!.messages).toHaveLength(100);
    expect(getConversationPage(db, { conversationId: CONV, limit: 0 })!.messages).toHaveLength(1);
  });

  it('shows text only: hides system, context-only, notices, echoes, scheduled fires and reactions', () => {
    row(db, { id: 'keep1' });
    row(db, { id: 'sys', meta: { system_only: true } });
    row(db, { id: 'ctx', dir: 'outbound', meta: { context_only: true } });
    row(db, { id: 'notice', dir: 'outbound', meta: { bus_notice: true } });
    row(db, { id: 'echo', dir: 'outbound', meta: { intercom_echo: true } });
    row(db, { id: 'sched', meta: { scheduled: true } });
    row(db, { id: 'react', body: '[reaction:added 👍 → x]' });
    row(db, { id: 'keep2', dir: 'outbound' });
    expect(getConversationPage(db, { conversationId: CONV })!.messages.map((m) => m.id)).toEqual(['keep1', 'keep2']);
  });

  it('carries open choice buttons and the answer_needed mark on the question', () => {
    row(db, { id: 'q', dir: 'outbound', body: 'Ship it?' });
    row(db, { id: 'old', dir: 'outbound', body: 'Earlier?' });
    const store = new ChoiceStore(db);
    store.create({ id: 'p1', channel: 'telegram:peggy', topic: 'thread:abc', contactId: 'chris', labels: ['Yes', 'Copy', 'No'],
      buttons: [null, { copy_text: 'x' }, { style: 'danger' }], platformMessageId: null, busMessageId: 'q' }, 3600_000);
    store.create({ id: 'p0', channel: 'telegram:peggy', topic: 'thread:abc', contactId: 'chris', labels: ['A'], platformMessageId: null, busMessageId: 'old' }, 3600_000);
    store.answer('p0', 0, 'contact:chris');
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'q' });
    const [q, old] = getConversationPage(db, { conversationId: CONV })!.messages;
    expect(q).toMatchObject({ id: 'q', buttons: [{ index: 0, label: 'Yes' }, { index: 2, label: 'No' }], answer_needed: true });
    expect(old!.buttons).toBeUndefined();
    expect(old!.answer_needed).toBeUndefined();
  });

  it('cuts long text', () => {
    const long = 'x'.repeat(MAX_MESSAGE_TEXT + 10);
    expect(Array.from(clipText(long))).toHaveLength(MAX_MESSAGE_TEXT);
    expect(clipText(long).endsWith('…')).toBe(true);
    expect(clipText('short')).toBe('short');
  });
});

describe('messageForLiveAppend', () => {
  const env = (o: Partial<MessageEnvelope>): MessageEnvelope => ({
    id: 'e1', timestamp: '2026-11-03T12:00:00.000Z', channel: 'telegram:peggy', topic: 'thread:abc', sender: 'agent:peggy-pool-1',
    recipient: 'contact:chris', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'Done.' }, metadata: {}, ...o,
  });

  it('maps agent and contact text, and finds the conversation the pipeline way', () => {
    expect(messageForLiveAppend(env({}))).toEqual({ id: 'e1', role: 'agent', text: 'Done.', created_at: '2026-11-03T12:00:00.000Z' });
    const inbound = env({ sender: 'contact:chris', recipient: 'agent:peggy' });
    expect(messageForLiveAppend(inbound)!.role).toBe('user');
    expect(conversationIdForEnvelope(env({}))).toBe(CONV);
    expect(conversationIdForEnvelope(inbound)).toBe(CONV);
    expect(conversationIdForEnvelope(env({ recipient: 'agent:other' }))).toBeNull();
  });

  it('skips what the page hides', () => {
    expect(messageForLiveAppend(env({ metadata: { bus_notice: true } }))).toBeNull();
    expect(messageForLiveAppend(env({ metadata: { system_only: true } }))).toBeNull();
    expect(messageForLiveAppend(env({ sender: 'system:bus' }))).toBeNull();
    expect(messageForLiveAppend(env({ payload: { type: 'reaction', emoji: '👍', removed: false, target_message_id: 'x' } }))).toBeNull();
  });

  it('adds buttons and answer_needed from the db', () => {
    const db = new Database(':memory:'); runMigrations(db);
    new ChoiceStore(db).create({ id: 'p1', channel: 'telegram:peggy', topic: 'thread:abc', contactId: 'chris', labels: ['Yes'], platformMessageId: null, busMessageId: 'e1' }, 3600_000);
    setAnswerNeeded(db, { conversationId: CONV, messageId: 'e1' });
    expect(messageForLiveAppend(env({}), db)).toMatchObject({ buttons: [{ index: 0, label: 'Yes' }], answer_needed: true });
  });
});
