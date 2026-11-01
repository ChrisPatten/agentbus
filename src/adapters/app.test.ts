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

describe('AppAdapter choice prompts (E86 S86.2)', () => {
  const withChoices = (id: string, metadata: Record<string, unknown>): MessageEnvelope => ({ ...message(id), metadata });

  it('creates one open prompt for a message with choices, keyed by the message id', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      const envelope = withChoices('out-c1', { choices: ['A', { label: 'B', style: 'success' }] });
      expect((await app.send(envelope)).success).toBe(true);
      expect((await app.send(envelope)).success).toBe(true);
      const prompts = db.prepare(`SELECT * FROM choice_prompts`).all() as Record<string, unknown>[];
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ channel: 'app', topic: 'general', contact_id: 'me', labels: '["A","B"]',
        buttons: '[null,{"style":"success"}]', commands: null, platform_message_id: 'out-c1', bus_message_id: 'out-c1', status: 'open' });
      const ttl = Date.parse(String(prompts[0]!['expires_at'])) - Date.parse(String(prompts[0]!['created_at']));
      expect(ttl).toBe(24 * 60 * 60 * 1000);
    } finally { db.close(); }
  });

  it('keeps choice_commands on the prompt and honours choice_ttl_hours', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work', () => [], { choiceTtlHours: 2 });
      await app.sendCommandResponse(withChoices('out-c2', { choices: ['Opus', 'Haiku'], choice_commands: ['/model opus', '/model haiku'] }));
      const prompt = app.choices.list()[0]!;
      expect(prompt.commands).toEqual(['/model opus', '/model haiku']);
      expect(Date.parse(prompt.expires_at) - Date.parse(prompt.created_at)).toBe(2 * 60 * 60 * 1000);
    } finally { db.close(); }
  });

  it('creates no prompt for a copy- or link-only message, or a message without choices', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      await app.send(withChoices('out-c3', { choices: [{ label: 'Copy', copy_text: 'abc' }, { label: 'Docs', url: 'https://example.com' }] }));
      await app.send(message('out-c4'));
      expect(db.prepare(`SELECT COUNT(*) AS n FROM choice_prompts`).get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('rolls the prompt back with the transcript when the insert fails', async () => {
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      db.exec(`CREATE TRIGGER fail_prompt BEFORE INSERT ON choice_prompts BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
      const result = await app.send(withChoices('out-c5', { choices: ['A'] }));
      expect(result).toMatchObject({ success: false, retryable: true });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE message_id = 'out-c5'`).get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('the expiry sweep writes one choice event for an expired app prompt', async () => {
    const { AdapterRegistry } = await import('../core/registry.js');
    const { sweepChoices } = await import('../choices/sweep.js');
    const db = makeDb();
    try {
      const app = new AppAdapter(db, () => 'agent:work');
      const registry = new AdapterRegistry(); registry.register(app);
      await app.send(withChoices('out-c6', { choices: ['A', 'B'] }));
      const before = (db.prepare(`SELECT seq FROM app_event_counters WHERE contact_id = 'me'`).get() as { seq: number }).seq;
      const future = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
      expect(await sweepChoices({ registry, store: app.choices }, future)).toEqual({ expired: 1, keyboardsCleared: 1 });
      expect(await sweepChoices({ registry, store: app.choices }, future)).toEqual({ expired: 0, keyboardsCleared: 0 });
      const events = db.prepare(`SELECT e.seq, e.kind, e.choice_prompt_id, t.message_id FROM app_events e
        JOIN transcripts t ON t.id = e.transcript_id WHERE e.kind = 'choice'`).all();
      expect(events).toEqual([{ seq: before + 1, kind: 'choice', choice_prompt_id: app.choices.list()[0]!.id, message_id: 'out-c6' }]);
      expect(app.choices.list()[0]).toMatchObject({ status: 'expired', platform_message_id: null });
    } finally { db.close(); }
  });
});
