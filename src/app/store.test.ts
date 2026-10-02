import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ensureOutboundAppSession } from './outbound.js';
import { createAppSession, eventBounds, history, listSessions, readEvents, recordSessionEvent, sessionInfo, visibleSession } from './store.js';
import { upsertThread } from '../pipeline/thread-store.js';

const when = '2026-09-30T12:00:00.000Z';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  let messageClock = 0;
  const addSession = (contact: string, agent: string, channel: string, topic: string, id: string) => {
    const conversation = `conv:${contact}:${channel}:${topic}`;
    db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen)
      VALUES (?,?,?,?,?,?)`).run(conversation, contact, channel, topic, when, when);
    db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
      VALUES (?,?,?,?,?,?,?)`).run(id, conversation, channel, contact, when, when, agent);
    return conversation;
  };
  const addMessage = (contact: string, session: string, conversation: string, id: string,
    direction: 'inbound' | 'outbound', body: string, metadata: Record<string, unknown> = {}) => {
    const channel = (db.prepare('SELECT channel FROM sessions WHERE id = ?').get(session) as { channel: string }).channel;
    db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`row:${id}`, id, conversation, session,
        new Date(Date.parse(when) + messageClock++ * 1000).toISOString(), channel, contact, direction, body, JSON.stringify(metadata));
  };
  return { db, addSession, addMessage };
}

describe('app topic titles', () => {
  it('names an untitled topic from its first message', () => {
    const f = fixture();
    try {
      const { sessionId } = createAppSession(f.db, 'alice', 'agent:work');
      const title = () => sessionInfo(f.db, visibleSession(f.db, 'alice', 'agent:work', sessionId)!, 'alice')['title'];
      expect(title()).toBe('New Conversation');
      const conversation = (f.db.prepare('SELECT conversation_id FROM sessions WHERE id = ?').get(sessionId) as { conversation_id: string }).conversation_id;
      f.addMessage('alice', sessionId, conversation, 'first', 'inbound', 'Plan the Salesforce change');
      expect(title()).toBe('Plan the Salesforce change');
      const named = createAppSession(f.db, 'alice', 'agent:work', 'Travel');
      expect(sessionInfo(f.db, visibleSession(f.db, 'alice', 'agent:work', named.sessionId)!, 'alice')['title']).toBe('Travel');
    } finally { f.db.close(); }
  });
});

describe('app store visibility and projection', () => {
  it('lists only the authenticated contact and routed agent, excluding scheduler-only sessions', () => {
    const f = fixture();
    try {
      const own = f.addSession('alice', 'agent:work', 'telegram', 'general', 'own');
      f.addMessage('alice', 'own', own, 'own-in', 'inbound', 'Hi');
      const otherAgent = f.addSession('alice', 'agent:other', 'telegram', 'other', 'other-agent');
      f.addMessage('alice', 'other-agent', otherAgent, 'other-in', 'inbound', 'Hidden');
      const otherContact = f.addSession('bob', 'agent:work', 'telegram', 'general', 'other-contact');
      f.addMessage('bob', 'other-contact', otherContact, 'bob-in', 'inbound', 'Hidden');
      const scheduled = f.addSession('alice', 'agent:work', 'app', 'sched:nightly', 'scheduled');
      f.addMessage('alice', 'scheduled', scheduled, 'sched-in', 'inbound', 'Job', { scheduled: true });
      const sessions = listSessions(f.db, 'alice', 'agent:work', 'all', 50);
      expect(sessions.map((s) => s['session_id'])).toEqual(['own']);
      expect(visibleSession(f.db, 'alice', 'agent:work', 'other-agent')).toBeNull();
      expect(visibleSession(f.db, 'alice', 'agent:work', 'other-contact')).toBeNull();
      expect(visibleSession(f.db, 'alice', 'agent:work', 'scheduled')).toBeNull();
      expect(history(f.db, 'alice', 'agent:work', 'other-contact', 50)).toBeNull();
      expect(readEvents(f.db, 'alice', 'agent:work', 0, eventBounds(f.db, 'alice').latest)
        .every((e) => e.data['session_id'] === 'own')).toBe(true);
    } finally { f.db.close(); }
  });

  it('projects the exact transcript for each event and keeps history oldest first', () => {
    const f = fixture();
    try {
      const conv = f.addSession('alice', 'agent:work', 'telegram', 'general', 's1');
      f.addMessage('alice', 's1', conv, 'first', 'inbound', 'First');
      f.addMessage('alice', 's1', conv, 'second', 'outbound', 'Second');
      const events = readEvents(f.db, 'alice', 'agent:work', 0, eventBounds(f.db, 'alice').latest)
        .filter((e) => e.event === 'message');
      expect(events.map((e) => [e.data['message_id'], e.data['body']]))
        .toEqual([['first', 'First'], ['second', 'Second']]);
      expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
      const page = history(f.db, 'alice', 'agent:work', 's1', 50)!;
      expect(page.map((m) => m['message_id'])).toEqual(['first', 'second']);
      expect(page[1]!['arrival_channel']).toBe('telegram');
    } finally { f.db.close(); }
  });

  it('uses Main and thread titles and updates unread count after a read marker', () => {
    const f = fixture();
    try {
      const main = ensureOutboundAppSession(f.db, 'alice', 'agent:work', 'general');
      const topic = f.addSession('alice', 'agent:work', 'app', 'thread:trip', 'trip');
      upsertThread(f.db, { channel: 'app', topic: 'thread:trip', threadKey: 'trip', metadata: { title: 'Travel' } });
      f.addMessage('alice', 'trip', topic, 'reply', 'outbound', 'Welcome');
      const first = listSessions(f.db, 'alice', 'agent:work', 'all', 50);
      expect(first.find((s) => s['session_id'] === main.sessionId)).toMatchObject({ title: 'Main', is_main: true });
      expect(first.find((s) => s['session_id'] === 'trip')).toMatchObject({ title: 'Travel', unread_count: 1 });
      const replySeq = (readEvents(f.db, 'alice', 'agent:work', 0, eventBounds(f.db, 'alice').latest)
        .find((e) => e.event === 'message' && e.data['message_id'] === 'reply'))!.seq;
      f.db.prepare(`INSERT INTO app_read_markers(contact_id,session_id,seq) VALUES (?,?,?)`).run('alice', 'trip', replySeq);
      recordSessionEvent(f.db, 'alice', 'trip');
      expect(listSessions(f.db, 'alice', 'agent:work', 'all', 50)
        .find((s) => s['session_id'] === 'trip')).toMatchObject({ unread_count: 0 });
    } finally { f.db.close(); }
  });

  it('reports retention bounds for replay reset decisions', () => {
    const f = fixture();
    try {
      const conv = f.addSession('alice', 'agent:work', 'app', 'general', 's1');
      f.addMessage('alice', 's1', conv, 'm1', 'inbound', 'One');
      f.addMessage('alice', 's1', conv, 'm2', 'outbound', 'Two');
      const before = eventBounds(f.db, 'alice');
      expect(before).toEqual({ first: 1, latest: 3 });
      f.db.prepare('DELETE FROM app_events WHERE contact_id = ? AND seq < ?').run('alice', 3);
      const after = eventBounds(f.db, 'alice');
      expect(after).toEqual({ first: 3, latest: 3 });
      expect(readEvents(f.db, 'alice', 'agent:work', 2, after.latest).map((e) => e.seq)).toEqual([3]);
      expect(1 < after.first - 1).toBe(true); // hello cursor 1 must reset
    } finally { f.db.close(); }
  });

  it('pages tied session and message timestamps without omissions', () => {
    const f = fixture();
    try {
      const conversation = f.addSession('alice', 'agent:work', 'app', 'one', 's-a');
      f.addSession('alice', 'agent:work', 'app', 'two', 's-b');
      f.addSession('alice', 'agent:work', 'app', 'three', 's-c');
      const firstSessions = listSessions(f.db, 'alice', 'agent:work', 'all', 2);
      const secondSessions = listSessions(f.db, 'alice', 'agent:work', 'all', 2,
        String(firstSessions[firstSessions.length - 1]!['session_id']));
      expect([...firstSessions, ...secondSessions].map((s) => s['session_id'])).toEqual(['s-c', 's-b', 's-a']);

      f.addMessage('alice', 's-a', conversation, 'm1', 'inbound', 'One');
      f.addMessage('alice', 's-a', conversation, 'm2', 'inbound', 'Two');
      f.addMessage('alice', 's-a', conversation, 'm3', 'inbound', 'Three');
      f.db.prepare('UPDATE transcripts SET created_at = ? WHERE session_id = ?').run(when, 's-a');
      const newest = history(f.db, 'alice', 'agent:work', 's-a', 2)!;
      const older = history(f.db, 'alice', 'agent:work', 's-a', 2,
        String(newest[0]!['cursor']))!;
      expect([...older, ...newest].map((m) => m['message_id'])).toEqual(['m1', 'm2', 'm3']);
    } finally { f.db.close(); }
  });
});
