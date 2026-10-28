import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { AppConfigSchema, type AppConfig } from '../../config/schema.js';
import { computeConversationId } from '../conversation-id.js';
import { createPendingContextInject } from './pending-context-inject.js';
import { JOURNAL_RUN_KEY, SYSTEM_ONLY_KEY, pendingContextFor } from '../../core/system-block.js';
import { loadWindow } from '../../journaling/eligibility.js';
import type { PipelineContext } from '../types.js';

// E80 S80.4 — the stage in isolation: which envelopes it ignores. The end-to-end cases live in src/http/pool-context.test.ts.

const config = AppConfigSchema.parse({
  bus: { db_path: ':memory:' }, adapters: {}, memory: {},
  agents: { 'agent:peggy': { pending_context: { channels: ['telegram:peggy'] } } },
}) as AppConfig;

function fixture() {
  const db = new Database(':memory:');
  runMigrations(db);
  const conv = computeConversationId('alice', 'telegram:peggy', 'general');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversation_registry(id,contact_id,channel,topic,first_seen,last_seen) VALUES (?,?,?,?,?,?)`).run(conv, 'alice', 'telegram:peggy', 'general', now, now);
  db.prepare(`INSERT INTO sessions(id,conversation_id,channel,contact_id,started_at,last_activity,message_count,agent_id) VALUES ('s1',?,?,?,?,?,0,'agent:peggy')`)
    .run(conv, 'telegram:peggy', 'alice', now, now);
  db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
    VALUES ('t1','m1',?,'s1',?,'telegram:peggy','alice','outbound','routine result',?)`).run(conv, now, JSON.stringify({ origin: { kind: 'external', label: 'Ambient scan' } }));
  const ctx = (over: Partial<PipelineContext> = {}, metadata: Record<string, unknown> = {}): PipelineContext => ({
    envelope: { id: 'e1', timestamp: now, channel: 'telegram:peggy', topic: 'general', sender: 'contact:alice', recipient: 'agent:peggy', reply_to: null,
      priority: 'normal', payload: { type: 'text', body: 'hi' }, metadata },
    contact: null, dedupKey: null, isSlashCommand: false, slashCommand: null, topics: [], priorityScore: 0,
    routes: [{ adapterId: 'cc-pool', recipientId: 'agent:peggy-pool-1' }], conversationId: conv, sessionId: 's1', sessionCreated: false,
    config, db, ...over,
  } as PipelineContext);
  return { db, conv, ctx };
}

describe('createPendingContextInject (E80)', () => {
  it('attaches for the pane route only, not for a cc-headless route or any other recipient', async () => {
    const f = fixture();
    const stage = createPendingContextInject(f.db, config);
    const out = await stage(f.ctx({ routes: [{ adapterId: 'cc-pool', recipientId: 'agent:peggy-pool-1' }, { adapterId: 'cc-headless', recipientId: 'agent:work' }] }));
    expect(pendingContextFor(out!.envelope.metadata, 'agent:peggy-pool-1')?.block).toContain('Ambient scan: routine result');
    expect(pendingContextFor(out!.envelope.metadata, 'agent:work')).toBeNull();
    const none = await stage(f.ctx({ routes: [{ adapterId: 'cc-headless', recipientId: 'agent:work' }] }));
    expect(none!.envelope.metadata['pending_context']).toBeUndefined();
    f.db.close();
  });

  it('ignores slash commands, system-only turns, journaling instructions, reactions and a missing conversation', async () => {
    const f = fixture();
    const stage = createPendingContextInject(f.db, config);
    const ignored = [
      f.ctx({ isSlashCommand: true }),
      f.ctx({}, { [SYSTEM_ONLY_KEY]: true }),
      f.ctx({}, { [JOURNAL_RUN_KEY]: 'run-1' }),
      f.ctx({ conversationId: null }),
    ];
    const reaction = f.ctx();
    reaction.envelope.payload = { type: 'reaction', emoji: '👍', removed: false, target_message_id: 'x' };
    ignored.push(reaction);
    for (const ctx of ignored) {
      const out = await stage(ctx);
      expect(out!.envelope.metadata['pending_context']).toBeUndefined();
    }
    f.db.close();
  });
});

describe('journaling window for a Telegram DM note (E80)', () => {
  it('keeps the note, marked as not shown to the user, as for Main', () => {
    const f = fixture();
    f.db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES ('t2','m2',?,'s1','2026-10-28T10:00:00.000Z','telegram:peggy','alice','outbound','Decided on SQLite',?)`)
      .run(f.conv, JSON.stringify({ origin: { kind: 'external', label: 'Claude Code: peggy' }, context_only: true }));
    f.db.prepare(`INSERT INTO transcripts (id, message_id, conversation_id, session_id, created_at, channel, contact_id, direction, body, metadata)
      VALUES ('t3','m3',?,'s1','2026-10-28T10:05:00.000Z','telegram:peggy','alice','inbound','go ahead','{}')`).run(f.conv);
    const w = loadWindow(f.db, { sessionId: 's1', cursorAt: null, agentId: 'agent:peggy' });
    expect(w.messages.map((m) => m.body)).toContain('[Context shared by Claude Code: peggy, not shown to the user] Decided on SQLite');
    expect(w.humanTimes).toEqual(['2026-10-28T10:05:00.000Z']);
    f.db.close();
  });
});
