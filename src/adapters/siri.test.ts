import { describe, it, expect, vi, afterEach } from 'vitest';
import { SiriAdapter } from './siri.js';
import type { SiriAdapterConfig } from '../config/schema.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeCfg(overrides: Partial<SiriAdapterConfig> = {}): SiriAdapterConfig {
  return {
    enabled: true,
    reply_timeout_ms: 25000,
    late_reply_ttl_ms: 86_400_000,
    max_body_bytes: 8192,
    rate_limit: { per_minute: 20, max_in_flight: 4 },
    debug_delay_ms: 0,
    ...overrides,
  };
}

function replyEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'out-1',
    timestamp: new Date().toISOString(),
    channel: 'siri',
    topic: 'general',
    sender: 'agent:peggy',
    recipient: 'contact:chris',
    reply_to: 'msg-1',
    priority: 'normal',
    payload: { type: 'text', body: 'Two things: dentist at 9 and the review at 2.' },
    metadata: {},
    ...overrides,
  };
}

const pending = (messageId = 'msg-1', contactId = 'contact:chris') => ({
  requestId: 'req-1',
  messageId,
  contactId,
  text: 'what is on my calendar',
  receivedAt: new Date().toISOString(),
});

describe('SiriAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('declares the siri channel and never advertises typing', () => {
    const siri = new SiriAdapter(makeCfg());
    expect(siri.id).toBe('siri');
    expect(siri.capabilities.channels).toEqual(['siri']);
    expect(siri.capabilities.typing).toBe(false);
  });

  it('resolves a waiting ask when a reply arrives with a matching reply_to', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending());
    const waiting = siri.wait('msg-1', 5000);

    const result = await siri.send(replyEnvelope());
    expect(result).toEqual({ success: true, platformMessageId: 'out-1' });

    const reply = await waiting;
    expect(reply?.body).toBe('Two things: dentist at 9 and the review at 2.');
    expect(reply?.messageId).toBe('out-1');
    expect(siri.pendingCount()).toBe(0);
  });

  it('returns a reply that arrived before wait() was called (synchronous command response)', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending());
    await siri.send(replyEnvelope({ payload: { type: 'text', body: 'bus-core up 3d' } }));

    const reply = await siri.wait('msg-1', 0);
    expect(reply?.body).toBe('bus-core up 3d');
    expect(siri.pendingCount()).toBe(0);
  });

  it('resolves null on timeout and removes the entry', async () => {
    vi.useFakeTimers();
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending());
    const waiting = siri.wait('msg-1', 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await waiting).toBeNull();
    expect(siri.pendingCount()).toBe(0);
    const health = await siri.health();
    expect(health.details).toMatchObject({ pending: 0, timed_out: 1 });
  });

  it('treats a reply after the timeout as unmatched but still delivered', async () => {
    vi.useFakeTimers();
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending());
    const waiting = siri.wait('msg-1', 1000);
    await vi.advanceTimersByTimeAsync(1001);
    await waiting;

    const result = await siri.send(replyEnvelope());
    expect(result.success).toBe(true);
    const health = await siri.health();
    expect(health.details).toMatchObject({ unmatched: 1 });
  });

  it('falls back to the oldest pending ask for the recipient when reply_to is null', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register({ ...pending('msg-old'), receivedAt: new Date(Date.now() - 2000).toISOString() });
    // Force distinct createdAt ordering.
    await new Promise((r) => setTimeout(r, 5));
    siri.register(pending('msg-new'));
    const oldWait = siri.wait('msg-old', 5000);
    const newWait = siri.wait('msg-new', 5000);

    await siri.send(replyEnvelope({ reply_to: null }));

    const old = await oldWait;
    expect(old?.messageId).toBe('out-1');
    expect(siri.pendingCount()).toBe(1);

    siri.cancel('msg-new');
    expect(await newWait).toBeNull();
  });

  it('does not match a reply addressed to a different recipient', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending('msg-1', 'contact:chris'));
    const waiting = siri.wait('msg-1', 5000);

    const result = await siri.send(replyEnvelope({ reply_to: null, recipient: 'contact:alice' }));
    expect(result.success).toBe(true);
    expect(siri.pendingCount()).toBe(1);

    siri.cancel('msg-1');
    expect(await waiting).toBeNull();
  });

  it('only the first reply completes the request; a second one is unmatched', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending());
    const waiting = siri.wait('msg-1', 5000);
    await siri.send(replyEnvelope({ id: 'out-1' }));
    await siri.send(replyEnvelope({ id: 'out-2', payload: { type: 'text', body: 'and one more thing' } }));

    expect((await waiting)?.messageId).toBe('out-1');
    const health = await siri.health();
    expect(health.details).toMatchObject({ answered: 1, unmatched: 1 });
  });

  it('wait() on an unknown message id resolves null immediately', async () => {
    const siri = new SiriAdapter(makeCfg());
    expect(await siri.wait('nope', 5000)).toBeNull();
  });

  it('stop() releases every open waiter with null', async () => {
    const siri = new SiriAdapter(makeCfg());
    siri.register(pending('a'));
    siri.register(pending('b'));
    const a = siri.wait('a', 60_000);
    const b = siri.wait('b', 60_000);
    await siri.stop();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(siri.pendingCount()).toBe(0);
  });

  it('refuses to construct with debug_delay_ms > 0 under NODE_ENV=production', () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => new SiriAdapter(makeCfg({ debug_delay_ms: 5000 }))).toThrow(/NODE_ENV=production/);
      expect(() => new SiriAdapter(makeCfg({ debug_delay_ms: 0 }))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prev;
    }
  });
});
