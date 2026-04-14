/**
 * Integration tests for slash command dispatch through processInbound().
 *
 * These tests exercise the full path: message → pipeline → command lookup →
 * handler → adapter.send() → transcript logging.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { processInbound, type InboundMessage } from './api.js';
import { PipelineEngine } from '../pipeline/engine.js';
import { normalize } from '../pipeline/stages/normalize.js';
import { slashCommandDetect } from '../pipeline/stages/slash-command.js';
import { createTranscriptLog } from '../pipeline/stages/transcript-log.js';
import { createRouteResolve } from '../pipeline/stages/route-resolve.js';
import { MessageQueue } from '../core/queue.js';
import { AdapterRegistry, type AdapterInstance } from '../core/registry.js';
import { createCommandSystem } from '../commands/index.js';
import type { AppConfig } from '../config/schema.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const stubConfig = {
  bus: { http_port: 0, db_path: ':memory:', log_level: 'info' },
  adapters: {},
  contacts: { chris: { display_name: 'Chris', platforms: { telegram: { user_id: '123' } } } },
  topics: ['general'],
  memory: { summarizer_interval_ms: 60000, session_idle_threshold_ms: 1800000, context_window_hours: 48, claude_api_model: 'claude-opus-4-6' },
  pipeline: {
    dedup_window_ms: 30000,
    drop_unrouted: false,
    topic_rules: [],
    priority_weights: { base_score: 0, topic_bonus: 40, vip_sender_bonus: 20, urgency_keyword_bonus: 15 },
    urgency_keywords: [],
    vip_contacts: [],
    routes: [{ match: { channel: 'telegram' }, target: { adapterId: 'cc', recipientId: 'agent:claude' } }],
  },
} as unknown as AppConfig;

function makeStubAdapter(id: string, channel: string): AdapterInstance {
  return {
    id,
    name: id,
    capabilities: { send: true, channels: [channel] },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    send: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('processInbound — slash command dispatch', () => {
  let db: Database.Database;
  let queue: MessageQueue;
  let adapterRegistry: AdapterRegistry;
  let pipeline: PipelineEngine;
  let telegramAdapter: AdapterInstance;

  beforeEach(() => {
    db = makeDb();
    queue = new MessageQueue(db);
    adapterRegistry = new AdapterRegistry();
    telegramAdapter = makeStubAdapter('telegram', 'telegram');
    adapterRegistry.register(telegramAdapter);

    pipeline = new PipelineEngine();
    pipeline.use({ slot: 10, name: 'normalize', stage: normalize });
    pipeline.use({ slot: 40, name: 'slash-command', stage: slashCommandDetect });
    pipeline.use({ slot: 70, name: 'route-resolve', stage: createRouteResolve(stubConfig, db) });
    pipeline.use({ slot: 80, name: 'transcript-log', stage: createTranscriptLog(db, stubConfig), critical: false });
  });

  it('dispatches /status and sends response via adapter', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry,
      queue,
      db,
      config: stubConfig,
    });

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: '/status' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('command_handled');
    expect(telegramAdapter.send).toHaveBeenCalledTimes(1);
    const sentEnvelope = (telegramAdapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sentEnvelope.payload.body).toContain('AgentBus status');
  });

  it('returns error for unknown commands', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: '/nonexistent' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('command_handled');
    const sentBody = (telegramAdapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].payload.body;
    expect(sentBody).toContain('Unknown command: /nonexistent');
  });

  it('allows slash commands from paused adapters', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });
    pauseSet.add('telegram');

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: '/status' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('command_handled');
    expect(telegramAdapter.send).toHaveBeenCalledTimes(1);
  });

  it('drops non-command messages from paused adapters', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });
    pauseSet.add('telegram');

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: 'just a regular message' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('adapter_paused');
    expect(telegramAdapter.send).not.toHaveBeenCalled();
  });

  it('falls through agent-scope commands to fan-out queue', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });

    // Register an agent-scope command
    commandRegistry.register({
      name: 'summarize',
      description: 'Agent summarization',
      usage: '/summarize',
      scope: 'agent',
      handler: async () => ({ body: 'should not be called inline' }),
    });

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: '/summarize' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    // Agent-scope commands are queued, not handled inline
    expect('queued' in result && result.queued).toBe(true);
    // Should NOT have sent a direct response
    expect(telegramAdapter.send).not.toHaveBeenCalled();

    // Payload should be restored to text; slash command data in metadata
    const pending = queue.dequeue('agent:claude', undefined, 1);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.envelope.payload.type).toBe('text');
    expect(pending[0]!.envelope.payload.body).toBe('/summarize');
    expect(pending[0]!.envelope.metadata['slash_command']).toEqual({ command: 'summarize', args_raw: '' });
  });

  it('rejects non-text payloads from in-process callers', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });

    const message = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'slash_command', body: '/status', command: 'status', args_raw: '' },
    } as unknown as InboundMessage;

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('invalid_payload');
  });

  it('catches handler errors and returns them as command response', async () => {
    const { registry: commandRegistry, pauseSet } = createCommandSystem({
      adapterRegistry, queue, db, config: stubConfig,
    });

    // Register a command that throws
    commandRegistry.register({
      name: 'broken',
      description: 'Always fails',
      usage: '/broken',
      scope: 'bus',
      handler: async () => { throw new Error('handler exploded'); },
    });

    const message: InboundMessage = {
      channel: 'telegram',
      sender: 'contact:chris',
      payload: { type: 'text', body: '/broken' },
    };

    const result = await processInbound(message, {
      queue, pipeline, config: stubConfig, db,
      registry: adapterRegistry, commandRegistry, pauseSet,
    });

    expect(result.ok).toBe(true);
    expect('reason' in result && result.reason).toBe('command_handled');
    const sentBody = (telegramAdapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].payload.body;
    expect(sentBody).toContain('Command error:');
    expect(sentBody).toContain('handler exploded');
  });
});
