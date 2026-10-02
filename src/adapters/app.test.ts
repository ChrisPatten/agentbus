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
