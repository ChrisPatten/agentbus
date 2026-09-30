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
