import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { ensureOutboundAppSession } from './outbound.js';
import { createAppSession, eventBounds, history, listSessions, quotableMessage, readEvents, recordSessionEvent, sessionInfo, visibleSession } from './store.js';
import { upsertThread } from '../pipeline/thread-store.js';
import { rotateMainSession } from './main.js';

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
      const page = history(f.db, 'alice', 'agent:work', 's1', 50)!.messages;
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
      const newest = history(f.db, 'alice', 'agent:work', 's-a', 2)!.messages;
      const older = history(f.db, 'alice', 'agent:work', 's-a', 2,
        String(newest[0]!['cursor']))!.messages;
      expect([...older, ...newest].map((m) => m['message_id'])).toEqual(['m1', 'm2', 'm3']);
    } finally { f.db.close(); }
  });
});

describe('bus-originated turns are hidden (E65/E66)', () => {
  it('keeps system-only inbound rows out of history, replay, titles and session visibility', () => {
    const f = fixture();
    try {
      // A Telegram session that only ever had a bus advisory turn is not shown.
      const tg = f.addSession('alice', 'agent:work', 'telegram', 'general', 'tg');
      f.addMessage('alice', 'tg', tg, 'adv', 'inbound', '[AgentBus advisory turn a1]', { system_only: true, bus_advisory: true });
      expect(visibleSession(f.db, 'alice', 'agent:work', 'tg')).toBeNull();

      const { sessionId } = createAppSession(f.db, 'alice', 'agent:work');
      const conversation = (f.db.prepare('SELECT conversation_id FROM sessions WHERE id = ?').get(sessionId) as { conversation_id: string }).conversation_id;
      f.addMessage('alice', sessionId, conversation, 'journal', 'inbound', '[AgentBus journal run r1]', { system_only: true, journal_run_id: 'r1' });
      f.addMessage('alice', sessionId, conversation, 'hello', 'inbound', 'Hello there');
      f.addMessage('alice', sessionId, conversation, 'reply', 'outbound', 'Hi!');

      const rows = history(f.db, 'alice', 'agent:work', sessionId, 50)!.messages;
      expect(rows.map((r) => r['message_id'])).toEqual(['hello', 'reply']);
      const title = sessionInfo(f.db, visibleSession(f.db, 'alice', 'agent:work', sessionId)!, 'alice')['title'];
      expect(title).toBe('Hello there');
      const { latest } = eventBounds(f.db, 'alice');
      const messages = readEvents(f.db, 'alice', 'agent:work', 0, latest).filter((e) => e.event === 'message');
      expect(messages.map((e) => e.data['message_id'])).toEqual(['hello', 'reply']);
      // Still in the DB for debugging.
      expect(f.db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE json_extract(metadata,'$.system_only') = 1`).get()).toEqual({ n: 2 });
    } finally { f.db.close(); }
  });
});

describe('app reply references (E72)', () => {
  it('resolves quotable messages by contact and agent, newest row first, and truncates', () => {
    const f = fixture();
    try {
      const own = f.addSession('alice', 'agent:work', 'app', 'general', 'own');
      f.addMessage('alice', 'own', own, 'dup', 'inbound', 'old copy');
      // message_id is not unique in transcripts; the newest row (by rowid) wins.
      f.db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES ('row:dup2','dup',?,?,?,'app','alice','outbound','newest copy','{}')`).run(own, 'own', when);
      f.addMessage('alice', 'own', own, 'long', 'outbound', 'y'.repeat(250));
      f.addMessage('alice', 'own', own, 'hidden', 'outbound', 'internal', { system_only: true });
      const other = f.addSession('bob', 'agent:work', 'app', 'general', 'bobs');
      f.addMessage('bob', 'bobs', other, 'bob-msg', 'outbound', 'private');
      const otherAgent = f.addSession('alice', 'agent:other', 'app', 'other-topic', 'others');
      f.addMessage('alice', 'others', otherAgent, 'agent-msg', 'outbound', 'private');
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'dup')).toEqual({ message_id: 'dup', sender_name: 'agent', text: 'newest copy',
        created_at: when, source: 'agent' });
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'long')!.text).toHaveLength(200);
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'hidden')).toBeNull();
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'bob-msg')).toBeNull();
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'agent-msg')).toBeNull();
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'nope')).toBeNull();
    } finally { f.db.close(); }
  });

  it('names an inbound target "you"', () => {
    const f = fixture();
    try {
      const own = f.addSession('alice', 'agent:work', 'telegram', 'general', 'own');
      f.addMessage('alice', 'own', own, 'mine', 'inbound', 'hello');
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'mine')).toMatchObject({ sender_name: 'you', text: 'hello' });
    } finally { f.db.close(); }
  });

  it('emits reply_to on history and message events only for app-style quotes', () => {
    const f = fixture();
    try {
      const conv = f.addSession('alice', 'agent:work', 'app', 'general', 's1');
      f.addMessage('alice', 's1', conv, 'plain', 'inbound', 'No quote');
      f.addMessage('alice', 's1', conv, 'app-reply', 'inbound', 'About that',
        { quoted_message: { message_id: 'plain', sender_name: 'you', text: 'No quote' } });
      f.addMessage('alice', 's1', conv, 'tg-reply', 'inbound', 'Telegram style',
        { quoted_message: { platform_message_id: '555:1', sender_name: 'Peggy', text: 'Original' } });
      const page = history(f.db, 'alice', 'agent:work', 's1', 50)!.messages;
      const byId = (id: string) => page.find((m) => m['message_id'] === id)!;
      expect(byId('app-reply')['reply_to']).toEqual({ message_id: 'plain', sender_name: 'you', text: 'No quote' });
      expect('reply_to' in byId('plain')).toBe(false);
      expect('reply_to' in byId('tg-reply')).toBe(false);
      const events = readEvents(f.db, 'alice', 'agent:work', 0, eventBounds(f.db, 'alice').latest).filter((e) => e.event === 'message');
      expect(events.find((e) => e.data['message_id'] === 'app-reply')!.data['reply_to'])
        .toEqual({ message_id: 'plain', sender_name: 'you', text: 'No quote' });
      expect('reply_to' in events.find((e) => e.data['message_id'] === 'tg-reply')!.data).toBe(false);
    } finally { f.db.close(); }
  });
});

describe('Main as one conversation (E69)', () => {
  /** Main fragmented into rows the way the pre-E69 lifecycle left it: three ended rows and an active one. */
  function fragmented() {
    const f = fixture();
    const conversation = f.addSession('alice', 'agent:work', 'app', 'general', 'm1');
    const addRow = (id: string, offsetMs: number) => f.db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,agent_id)
      VALUES (?,?,'app','alice',?,?,'agent:work')`).run(id, conversation, new Date(Date.parse(when) + offsetMs).toISOString(),
      new Date(Date.parse(when) + offsetMs).toISOString());
    addRow('m2', 10_000); addRow('m3', 20_000); addRow('m4', 30_000);
    const at = (s: number) => new Date(Date.parse(when) + s * 1000).toISOString();
    const put = (session: string, id: string, s: number, direction: 'inbound' | 'outbound', body: string) =>
      f.db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES (?,?,?,?,?,'app','alice',?,?,'{}')`).run(`row:${id}`, id, conversation, session, at(s), direction, body);
    put('m1', 'a', 1, 'outbound', 'Scan one'); put('m2', 'b', 11, 'outbound', 'Scan two');
    put('m3', 'c', 21, 'inbound', 'Reply'); put('m3', 'd', 22, 'outbound', 'Answer'); put('m4', 'e', 31, 'outbound', 'Scan three');
    f.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(at(5), null, 'm1');
    f.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(at(15), 'idle', 'm2');
    f.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(at(25), 'clear', 'm3');
    return { ...f, conversation, at };
  }

  it('merges fragmented rows into one Main item, never listed under Earlier', () => {
    const f = fragmented();
    try {
      const telegram = f.addSession('alice', 'agent:work', 'telegram', 'general', 'tg');
      f.addMessage('alice', 'tg', telegram, 'tg-in', 'inbound', 'Hi');
      f.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(when, 'tg');
      const all = listSessions(f.db, 'alice', 'agent:work', 'all', 50);
      expect(all.filter(s => s['is_main'])).toHaveLength(1);
      expect(all.find(s => s['is_main'])).toMatchObject({ session_id: 'm4', conversation_id: f.conversation, ended_at: null,
        title: 'Main', started_at: when, resumable: true, unread_count: 4 });
      expect(listSessions(f.db, 'alice', 'agent:work', 'earlier', 50).map(s => s['session_id'])).toEqual(['tg']);
      expect(listSessions(f.db, 'alice', 'agent:work', 'active', 50).map(s => s['session_id'])).toEqual(['m4']);
      // Every Main row id projects the same item.
      for (const id of ['m1', 'm2', 'm3', 'm4'])
        expect(sessionInfo(f.db, visibleSession(f.db, 'alice', 'agent:work', id)!, 'alice')['session_id']).toBe('m4');
      // With no active row, Main is still listed (as active) at its newest row.
      f.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(f.at(40), 'm4');
      expect(listSessions(f.db, 'alice', 'agent:work', 'active', 50).map(s => [s['session_id'], s['ended_at']])).toEqual([['m4', null]]);
      expect(listSessions(f.db, 'alice', 'agent:work', 'earlier', 50).map(s => s['session_id'])).toEqual(['tg']);
    } finally { f.db.close(); }
  });

  it('keeps Main once across session-list pages', () => {
    const f = fragmented();
    try {
      for (const [id, topic] of [['t1', 'one'], ['t2', 'two']] as const) f.addSession('alice', 'agent:work', 'app', topic, id);
      f.db.prepare(`UPDATE sessions SET last_activity = ? WHERE id IN ('t1','t2')`).run(f.at(12));
      const pages: Record<string, unknown>[] = [];
      let before: string | undefined;
      for (;;) {
        const page = listSessions(f.db, 'alice', 'agent:work', 'all', 1, before);
        if (!page.length) break;
        pages.push(...page); before = String(page[page.length - 1]!['session_id']);
      }
      expect(pages.map(s => s['session_id'])).toEqual(['m4', 't2', 't1']);
    } finally { f.db.close(); }
  });

  it('pages history across every row oldest first, with rotation boundaries and conversation_id', () => {
    const f = fragmented();
    try {
      for (const id of ['m1', 'm3']) {
        const page = history(f.db, 'alice', 'agent:work', id, 50)!;
        expect(page.messages.map(m => m['message_id'])).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(page.messages.every(m => m['conversation_id'] === f.conversation)).toBe(true);
        expect(page.boundaries).toEqual([
          { session_id: 'm1', ended_at: f.at(5), reason: null },
          { session_id: 'm2', ended_at: f.at(15), reason: 'idle' },
          { session_id: 'm3', ended_at: f.at(25), reason: 'clear' },
        ]);
      }
      // Pages tile: each boundary appears on exactly one page.
      const newest = history(f.db, 'alice', 'agent:work', 'm4', 2)!;
      expect(newest.messages.map(m => m['message_id'])).toEqual(['d', 'e']);
      expect(newest.boundaries!.map(b => b.session_id)).toEqual(['m3']);
      const middle = history(f.db, 'alice', 'agent:work', 'm4', 2, String(newest.messages[0]!['cursor']))!;
      expect(middle.messages.map(m => m['message_id'])).toEqual(['b', 'c']);
      expect(middle.boundaries!.map(b => b.session_id)).toEqual(['m2']);
      const oldest = history(f.db, 'alice', 'agent:work', 'm4', 2, String(middle.messages[0]!['cursor']))!;
      expect(oldest.messages.map(m => m['message_id'])).toEqual(['a']);
      expect(oldest.boundaries!.map(b => b.session_id)).toEqual(['m1']);
      // Non-Main history omits boundaries.
      const { sessionId } = createAppSession(f.db, 'alice', 'agent:work', 'Topic');
      expect('boundaries' in history(f.db, 'alice', 'agent:work', sessionId, 50)!).toBe(false);
    } finally { f.db.close(); }
  });

  it('keeps one conversation-wide read marker, so rotation does not reset unread', () => {
    const f = fragmented();
    try {
      const seqOf = (id: string) => (readEvents(f.db, 'alice', 'agent:work', 0, eventBounds(f.db, 'alice').latest)
        .find(e => e.event === 'message' && e.data['message_id'] === id))!.seq;
      const main = () => listSessions(f.db, 'alice', 'agent:work', 'all', 50).find(s => s['is_main'])!;
      expect(main()['unread_count']).toBe(4);
      // A marker on an old row covers the conversation up to that event.
      f.db.prepare('INSERT INTO app_read_markers(contact_id,session_id,seq) VALUES (?,?,?)').run('alice', 'm2', seqOf('b'));
      expect(main()['unread_count']).toBe(2);
      f.db.prepare('INSERT INTO app_read_markers(contact_id,session_id,seq) VALUES (?,?,?)').run('alice', 'm4', seqOf('e'));
      expect(main()['unread_count']).toBe(0);
      // Rotate, then a new row gets a proactive message: unread counts only it.
      rotateMainSession(f.db, 'm4', 'idle');
      const next = ensureOutboundAppSession(f.db, 'alice', 'agent:work', 'general');
      f.db.prepare('UPDATE sessions SET conversation_id = ? WHERE id = ?').run(f.conversation, next.sessionId);
      f.addMessage('alice', next.sessionId, f.conversation, 'f', 'outbound', 'Scan four');
      expect(main()).toMatchObject({ session_id: next.sessionId, unread_count: 1 });
    } finally { f.db.close(); }
  });

  it('emits Main session events for the active-row change, with rotated after an end, and still replays ended-row messages', () => {
    const f = fixture();
    try {
      const first = ensureOutboundAppSession(f.db, 'alice', 'agent:work', 'general');
      f.addMessage('alice', first.sessionId, first.conversationId, 'scan', 'outbound', 'Scan');
      f.db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run('claude-1', first.sessionId);
      const cursor = eventBounds(f.db, 'alice').latest;
      expect(rotateMainSession(f.db, first.sessionId, 'clear')).toEqual({});
      // A bus reply logged into the ended row after the end.
      f.addMessage('alice', first.sessionId, first.conversationId, 'cleared', 'outbound', 'Context cleared');
      recordSessionEvent(f.db, 'alice', first.sessionId);
      const ended = f.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(first.sessionId) as {ended_at:string};
      const afterEnd = readEvents(f.db, 'alice', 'agent:work', cursor, eventBounds(f.db, 'alice').latest);
      const endEvents = afterEnd.filter(e => e.event === 'session');
      // Before a new row exists, Main's item is the ended row, still shown as open.
      expect(endEvents[0]!.data).toMatchObject({ is_main: true, session_id: first.sessionId, ended_at: null,
        rotated: { previous_session_id: first.sessionId, ended_at: ended.ended_at, reason: 'clear' } });
      expect(endEvents.filter(e => 'rotated' in e.data)).toHaveLength(1);
      expect(afterEnd.find(e => e.event === 'message')!.data).toMatchObject({ message_id: 'cleared',
        session_id: first.sessionId, conversation_id: first.conversationId });

      const mid = eventBounds(f.db, 'alice').latest;
      const second = ensureOutboundAppSession(f.db, 'alice', 'agent:work', 'general');
      expect(second.sessionId).not.toBe(first.sessionId);
      const created = readEvents(f.db, 'alice', 'agent:work', mid, eventBounds(f.db, 'alice').latest);
      expect(created).toHaveLength(1);
      expect(created[0]!.data).toMatchObject({ is_main: true, session_id: second.sessionId, ended_at: null });
      expect('rotated' in created[0]!.data).toBe(false);
      expect(f.db.prepare('SELECT end_reason FROM sessions WHERE id = ?').get(first.sessionId)).toEqual({ end_reason: 'clear' });
      // Rotating twice, or a non-Main row, is a no-op.
      expect(rotateMainSession(f.db, first.sessionId, 'idle')).toBeNull();
      const topic = createAppSession(f.db, 'alice', 'agent:work', 'Trip');
      expect(rotateMainSession(f.db, topic.sessionId, 'idle')).toBeNull();
    } finally { f.db.close(); }
  });

  it('quotes with the target time and its origin label as the source', () => {
    const f = fixture();
    try {
      const main = ensureOutboundAppSession(f.db, 'alice', 'agent:work', 'general');
      f.addMessage('alice', main.sessionId, main.conversationId, 'scan', 'outbound', 'Two calendar items',
        { origin: { kind: 'external', label: 'Ambient scan' } });
      const created = (f.db.prepare(`SELECT created_at FROM transcripts WHERE message_id = 'scan'`).get() as {created_at:string}).created_at;
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'scan')).toEqual({ message_id: 'scan', sender_name: 'agent',
        text: 'Two calendar items', created_at: created, source: 'Ambient scan' });
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'scan', main.conversationId)).not.toBeNull();
      expect(quotableMessage(f.db, 'alice', 'agent:work', 'scan', 'some-other-conversation')).toBeNull();
    } finally { f.db.close(); }
  });
});
