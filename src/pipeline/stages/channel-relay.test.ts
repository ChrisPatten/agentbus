/**
 * Integration tests for the channel-relay stage (E26).
 *
 * Exercises the full path: processInbound() on the source channel ->
 * channel-relay (Stage 25) renders the template and re-submits a new
 * inbound message on the target channel -> that message runs the full
 * pipeline (normalize, channel-relay, dedup, route-resolve, transcript-log)
 * on its own terms -> queue.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { MessageQueue } from '../../core/queue.js';
import { AdapterRegistry } from '../../core/registry.js';
import { PipelineEngine } from '../engine.js';
import { normalize } from './normalize.js';
import { createChannelRelay } from './channel-relay.js';
import { createDedup } from './dedup.js';
import { createRouteResolve } from './route-resolve.js';
import { createTranscriptLog } from './transcript-log.js';
import { processInbound, type InboundMessage } from '../../http/api.js';
import type { AppConfig } from '../../config/schema.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<AppConfig['pipeline']> = {}): AppConfig {
  return {
    bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
    adapters: {},
    contacts: {},
    topics: ['general'],
    memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
    pipeline: {
      dedup_window_ms: 30000,
      drop_unrouted: false,
      topic_rules: [],
      priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
      urgency_keywords: [],
      vip_contacts: [],
      routes: [],
      relays: [],
      ...overrides,
    },
  } as unknown as AppConfig;
}

function makeHarness(config: AppConfig) {
  const db = makeDb();
  const queue = new MessageQueue(db);
  const registry = new AdapterRegistry();
  const pipeline = new PipelineEngine();
  const deps = { queue, pipeline, config, db, registry };
  pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
  pipeline.use({ slot: 25, name: 'channel-relay', stage: createChannelRelay(config, deps) });
  pipeline.use({ slot: 30, name: 'dedup', stage: createDedup(db, config.pipeline.dedup_window_ms) });
  pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(config, db) });
  pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, config), critical: false });
  return { db, queue, registry, pipeline, deps };
}

describe('channel-relay stage', () => {
  it('relays to the target channel with the template applied, preserving sender', async () => {
    const config = makeConfig({
      relays: [
        {
          match: { channel: 'pebble' },
          target: { channel: 'telegram:peggy', template: 'Pebble ring voice note:\n{{body}}' },
        },
      ],
      routes: [{ match: { channel: 'telegram:peggy' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }],
    });
    const { queue, deps } = makeHarness(config);

    const message: InboundMessage = {
      channel: 'pebble',
      sender: 'contact:chris',
      payload: { type: 'text', body: 'buy oat milk' },
    };
    const result = await processInbound(message, deps);

    expect(result.queued).toBe(false);
    if (!result.queued) {
      expect(result.reason).toContain('channel-relay');
    }

    const messages = queue.dequeue('agent:peggy', 'general', 10);
    expect(messages).toHaveLength(1);
    const envelope = messages[0]!.envelope;
    expect(envelope.channel).toBe('telegram:peggy');
    expect(envelope.sender).toBe('contact:chris');
    expect(envelope.payload).toEqual({ type: 'text', body: 'Pebble ring voice note:\nbuy oat milk' });
    expect(envelope.metadata['relayed_from']).toMatchObject({ channel: 'pebble' });
    expect(envelope.metadata['relay_hops']).toBe(1);
  });

  it('substitutes {{sender}} and {{channel}} placeholders', async () => {
    const config = makeConfig({
      relays: [
        {
          match: { channel: 'pebble' },
          target: { channel: 'telegram:peggy', template: '{{sender}} via {{channel}}: {{body}}' },
        },
      ],
      routes: [{ match: { channel: 'telegram:peggy' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }],
    });
    const { queue, deps } = makeHarness(config);

    await processInbound(
      { channel: 'pebble', sender: 'contact:chris', payload: { type: 'text', body: 'hi' } },
      deps,
    );

    const messages = queue.dequeue('agent:peggy', 'general', 10);
    expect(messages[0]!.envelope.payload).toEqual({
      type: 'text',
      body: 'contact:chris via pebble: hi',
    });
  });

  it('passes a non-matching message through the normal pipeline unchanged', async () => {
    const config = makeConfig({
      relays: [{ match: { channel: 'pebble' }, target: { channel: 'telegram:peggy', template: '{{body}}' } }],
      routes: [{ match: { channel: 'telegram' }, target: { adapterId: 'cc-headless', recipientId: 'agent:claude' } }],
    });
    const { queue, deps } = makeHarness(config);

    const result = await processInbound(
      { channel: 'telegram', sender: 'contact:alice', payload: { type: 'text', body: 'hello' } },
      deps,
    );

    expect(result.queued).toBe(true);
    const messages = queue.dequeue('agent:claude', 'general', 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.envelope.channel).toBe('telegram');
  });

  it('a relay rule matching a bot\'s DM channel also matches a group derived from it (E28)', async () => {
    const config = makeConfig({
      relays: [{ match: { channel: 'telegram:peggy' }, target: { channel: 'other', template: '{{body}}' } }],
      routes: [{ match: { channel: 'other' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }],
    });
    const { queue, deps } = makeHarness(config);

    const result = await processInbound(
      { channel: 'telegram:peggy:group:-1003977797157', sender: 'contact:chris', payload: { type: 'text', body: 'hi' } },
      deps,
    );

    expect(result.queued).toBe(false);
    const messages = queue.dequeue('agent:peggy', 'general', 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.envelope.channel).toBe('other');
  });

  it('deduplicates a retried source delivery after relaying', async () => {
    const config = makeConfig({
      relays: [{ match: { channel: 'pebble' }, target: { channel: 'telegram:peggy', template: 'wrapped: {{body}}' } }],
      routes: [{ match: { channel: 'telegram:peggy' }, target: { adapterId: 'cc-headless', recipientId: 'agent:peggy' } }],
    });
    const { queue, deps } = makeHarness(config);

    const message: InboundMessage = {
      channel: 'pebble',
      sender: 'contact:chris',
      payload: { type: 'text', body: 'buy oat milk' },
    };
    await processInbound(message, deps);
    await processInbound(message, deps);

    const messages = queue.dequeue('agent:peggy', 'general', 10);
    expect(messages).toHaveLength(1);
  });

  it('halts a relay cycle within the hop limit instead of looping forever', async () => {
    const config = makeConfig({
      relays: [
        { match: { channel: 'chanA' }, target: { channel: 'chanB', template: 'A>B: {{body}}' } },
        { match: { channel: 'chanB' }, target: { channel: 'chanA', template: 'B>A: {{body}}' } },
      ],
      routes: [
        { match: { channel: 'chanA' }, target: { adapterId: 'cc-headless', recipientId: 'agent:a' } },
        { match: { channel: 'chanB' }, target: { adapterId: 'cc-headless', recipientId: 'agent:b' } },
      ],
    });
    const { queue, deps } = makeHarness(config);

    const result = await processInbound(
      { channel: 'chanA', sender: 'contact:chris', payload: { type: 'text', body: 'loop me' } },
      deps,
    );
    expect(result.queued).toBe(false);

    const onA = queue.dequeue('agent:a', 'general', 10);
    const onB = queue.dequeue('agent:b', 'general', 10);
    // A -> B -> A -> B (3 hops, hop limit 3), the 3rd hop's relay is skipped
    // so the message lands on chanB and is delivered there exactly once.
    expect(onA).toHaveLength(0);
    expect(onB).toHaveLength(1);
    expect(onB[0]!.envelope.metadata['relay_hops']).toBe(3);
  });
});
