import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';
import { AppAdapter } from './app.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function message(id: string, topic = 'general'): MessageEnvelope {
  return {
    id,
    timestamp: new Date().toISOString(),
    channel: 'app',
    topic,
    sender: 'agent:work',
    recipient: 'contact:me',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: `message ${id}` },
    metadata: {},
  };
}

describe('AppAdapter durable offline send', () => {
  it('persists a Main transcript and replay event before reporting success', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      const result = await app.send(message('out-1'));
      expect(result).toMatchObject({ success: true, platformMessageId: 'out-1' });
      const transcript = db.prepare(`SELECT t.message_id, t.body, s.channel, s.agent_id
        FROM transcripts t JOIN sessions s ON s.id = t.session_id
        WHERE t.message_id = 'out-1'`).get() as {
        message_id: string; body: string; channel: string; agent_id: string;
      } | undefined;
      expect(transcript).toEqual({ message_id: 'out-1', body: 'message out-1', channel: 'app', agent_id: 'agent:work' });
      const event = db.prepare(`SELECT e.kind, t.message_id FROM app_events e
        JOIN transcripts t ON t.id = e.transcript_id WHERE t.message_id = 'out-1'`).get();
      expect(event).toEqual({ kind: 'message', message_id: 'out-1' });
    } finally { db.close(); }
  });

  it('repeated delivery of one message does not duplicate transcript or event', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      const outgoing = message('out-2');
      expect((await app.send(outgoing)).success).toBe(true);
      expect((await app.send(outgoing)).success).toBe(true);
      const transcripts = db.prepare(`SELECT count(*) AS n FROM transcripts WHERE message_id = 'out-2'`).get() as { n: number };
      const events = db.prepare(`SELECT count(*) AS n FROM app_events WHERE transcript_id IN
        (SELECT id FROM transcripts WHERE message_id = 'out-2')`).get() as { n: number };
      expect(transcripts.n).toBe(1);
      expect(events.n).toBe(1);
    } finally { db.close(); }
  });
});

describe('AppAdapter unread projection', () => {
  it('follows each delivered message with a session event, once per message', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      const outgoing = message('out-unread');
      await app.send(outgoing);
      await app.send(outgoing);
      const events = db.prepare(`SELECT kind FROM app_events WHERE contact_id = 'me' ORDER BY seq`).all() as { kind: string }[];
      // Session creation, the message, then the session update that carries the new unread count.
      expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'session']);
    } finally { db.close(); }
  });
});

describe('AppAdapter activity lifecycle', () => {
  const capacity = { running_user: 1, running_system: 0, waiting: 0, limit: 5, reserved_system_slots: 1 };

  function setup() {
    const db = makeDb();
    const app = new AppAdapter(db, () => 'agent:work', () => [{ agent_id: 'agent:work', ...capacity }]);
    const events: Array<{ state: string; tool_lines?: string[]; typing?: boolean }> = [];
    app.setActivityListener((event) => events.push(event));
    return { db, app, events };
  }

  it('keeps a running headless turn running after a mid-turn message', async () => {
    const { db, app, events } = setup();
    try {
      await app.send(message('seed'));
      const conversationId = (db.prepare(`SELECT conversation_id FROM sessions WHERE channel = 'app'`).get() as { conversation_id: string }).conversation_id;
      app.publishActivity({ agent_id: 'agent:work', conversation_id: conversationId, state: 'running', turn_class: 'user', ...capacity });
      app.reportToolCall('contact:me', 'Read a.yml');
      await app.send(message('progress'));
      const last = events.at(-1)!;
      expect(last.state).toBe('running');
      expect(last.tool_lines).toBeUndefined();
      expect(last.typing).toBe(true);

      app.publishActivity({ agent_id: 'agent:work', conversation_id: conversationId, state: 'idle', turn_class: 'user', ...capacity });
      expect(events.at(-1)!.state).toBe('idle');
    } finally { db.close(); }
  });

  it('ends the turn on delivery when no headless turn is running', async () => {
    const { db, app, events } = setup();
    try {
      await app.send(message('seed'));
      app.reportToolCall('contact:me', 'Read a.yml');
      expect(events.at(-1)).toMatchObject({ state: 'running', tool_lines: ['Read a.yml'] });
      await app.send(message('reply'));
      expect(events.at(-1)!.state).toBe('idle');
    } finally { db.close(); }
  });
});

describe('AppAdapter agent reply quotes (E69)', () => {
  it('quotes an earlier message the agent replies to, but not an unanswered inbound', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      expect((await app.send({ ...message('scan'), metadata: { origin: { kind: 'external', label: 'Ambient scan' } } })).success).toBe(true);
      const { session_id: sessionId, conversation_id: conversationId } = db.prepare(`SELECT session_id, conversation_id FROM transcripts
        WHERE message_id = 'scan'`).get() as { session_id: string; conversation_id: string };
      db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES ('row-in','op-1',?,?,?,'app','me','inbound','What about the second item?','{}')`).run(conversationId, sessionId, new Date().toISOString());
      const quoteOf = (id: string) => {
        const row = db.prepare('SELECT metadata FROM transcripts WHERE message_id = ?').get(id) as { metadata: string };
        return JSON.parse(row.metadata)['quoted_message'];
      };
      // Reply to the newest inbound (the fallback reply) stays unquoted.
      expect((await app.send({ ...message('ans-1'), reply_to: 'op-1' })).success).toBe(true);
      expect(quoteOf('ans-1')).toBeUndefined();
      // Reply to the earlier scan renders a quote with its time and source.
      expect((await app.send({ ...message('ans-2'), reply_to: 'scan' })).success).toBe(true);
      expect(quoteOf('ans-2')).toEqual({ message_id: 'scan', sender_name: 'agent', text: 'message scan',
        created_at: expect.any(String), source: 'Ambient scan' });
      // ans-2 answered something else, so op-1 now quotes too.
      db.prepare(`INSERT INTO transcripts(id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
        VALUES ('row-in2','op-2',?,?,?,'app','me','inbound','Thanks','{}')`).run(conversationId, sessionId, new Date(Date.now() + 1000).toISOString());
      expect((await app.send({ ...message('ans-3'), reply_to: 'op-1' })).success).toBe(true);
      expect(quoteOf('ans-3')).toMatchObject({ message_id: 'op-1', sender_name: 'you', source: 'you' });
      // An unknown reply_to stays unquoted and still delivers to Main.
      expect((await app.send({ ...message('ans-4'), reply_to: 'nope' })).success).toBe(true);
      expect(quoteOf('ans-4')).toBeUndefined();
      expect(db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM transcripts`).get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});

describe('AppAdapter quote rule: the conversation moved on (E69)', () => {
  async function seeded() {
    const db = makeDb();
    const app = new AppAdapter(db, () => 'agent:work');
    expect((await app.send(message('hello'))).success).toBe(true);
    const { session_id: s, conversation_id: c } = db.prepare(`SELECT session_id, conversation_id FROM transcripts
      WHERE message_id = 'hello'`).get() as { session_id: string; conversation_id: string };
    let clock = Date.now();
    const inbound = (id: string) => db.prepare(`INSERT INTO transcripts
      (id,message_id,conversation_id,session_id,created_at,channel,contact_id,direction,body,metadata)
      VALUES (?,?,?,?,?,'app','me','inbound',?,'{}')`).run(`row-${id}`, id, c, s, new Date(clock += 1000).toISOString(), `body ${id}`);
    // Agent replies go through the adapter so their reply_to is stored like production rows.
    const reply = async (id: string, replyTo: string) => {
      expect((await app.send({ ...message(id), reply_to: replyTo })).success).toBe(true);
      db.prepare('UPDATE transcripts SET created_at = ? WHERE message_id = ?').run(new Date(clock += 1000).toISOString(), id);
    };
    const quoteOf = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM transcripts WHERE message_id = ?')
      .get(id) as { metadata: string }).metadata)['quoted_message'];
    return { db, inbound, reply, quoteOf };
  }

  it('leaves a fallback reply to the first message of a two-message batch unquoted', async () => {
    const f = await seeded();
    try {
      f.inbound('i1'); f.inbound('i2');
      await f.reply('r', 'i1');
      expect(f.quoteOf('r')).toBeUndefined();
    } finally { f.db.close(); }
  });

  it('leaves every send of one turn answering the same message unquoted', async () => {
    const f = await seeded();
    try {
      f.inbound('i1');
      await f.reply('r1', 'i1');
      await f.reply('r2', 'i1');
      expect(f.quoteOf('r1')).toBeUndefined();
      expect(f.quoteOf('r2')).toBeUndefined();
      expect(JSON.parse((f.db.prepare(`SELECT metadata FROM transcripts WHERE message_id = 'r2'`).get() as {metadata:string}).metadata))
        .toMatchObject({ reply_to: 'i1' });
    } finally { f.db.close(); }
  });

  it('quotes a reply to an older message once the conversation has moved on, and any reply to an outbound', async () => {
    const f = await seeded();
    try {
      f.inbound('i0');
      await f.reply('r0', 'i0');
      f.inbound('i1');
      await f.reply('r1', 'i1');
      await f.reply('back', 'i0');
      expect(f.quoteOf('back')).toMatchObject({ message_id: 'i0', sender_name: 'you', source: 'you' });
      await f.reply('re-own', 'r0');
      expect(f.quoteOf('re-own')).toMatchObject({ message_id: 'r0', sender_name: 'agent' });
    } finally { f.db.close(); }
  });
});
