import { describe, it, expect, vi } from 'vitest';
import {
  formatMessagesForSampling,
  processAckedMessages,
  sendChannelNotification,
} from './cc.js';
import type { MessageEnvelope } from '../types/envelope.js';

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg-001',
    timestamp: new Date().toISOString(),
    channel: 'telegram',
    topic: 'general',
    sender: 'contact:alice',
    recipient: 'agent:claude',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'Hello!' },
    metadata: {},
    ...overrides,
  };
}

// ── S13.2 — processAckedMessages (poll → notify path) ────────────────────────

describe('processAckedMessages', () => {
  it('pushes to buffer and calls notify with formatted text', () => {
    const buffer: MessageEnvelope[] = [];
    const notify = vi.fn();
    const acked = [makeEnvelope()];

    processAckedMessages(acked, buffer, notify);

    expect(buffer).toHaveLength(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      'New message from contact:alice via telegram [id:msg-001]:\nHello!'
    );
  });

  it('batches multiple acked messages into a single notify call', () => {
    const buffer: MessageEnvelope[] = [];
    const notify = vi.fn();
    const acked = [
      makeEnvelope({ id: 'msg-001', payload: { type: 'text', body: 'First' } }),
      makeEnvelope({ id: 'msg-002', payload: { type: 'text', body: 'Second' } }),
    ];

    processAckedMessages(acked, buffer, notify);

    expect(buffer).toHaveLength(2);
    expect(notify).toHaveBeenCalledOnce();
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toContain('msg-001');
    expect(text).toContain('msg-002');
  });
});

// ── S13.1 — sendChannelNotification ──────────────────────────────────────────

describe('sendChannelNotification', () => {
  it('emits notifications/claude/channel with wrapped content', () => {
    const server = { notification: vi.fn() };

    sendChannelNotification(server, 'hello world');

    expect(server.notification).toHaveBeenCalledOnce();
    const call = server.notification.mock.calls[0]![0] as {
      method: string;
      params: { content: string; meta: { source: string } };
    };
    expect(call.method).toBe('notifications/claude/channel');
    // content is the raw body — Claude Code wraps it in <channel> automatically
    expect(call.params.content).toBe('hello world');
    expect(call.params.meta).toHaveProperty('ts');
  });
});

// ── formatMessagesForSampling ─────────────────────────────────────────────────

describe('formatMessagesForSampling', () => {
  it('formats a single message correctly', () => {
    const result = formatMessagesForSampling([makeEnvelope()]);
    expect(result).toBe(
      'New message from contact:alice via telegram [id:msg-001]:\nHello!'
    );
  });

  it('joins multiple messages with a blank line', () => {
    const envelopes = [
      makeEnvelope({ id: 'msg-001', payload: { type: 'text', body: 'First' } }),
      makeEnvelope({
        id: 'msg-002',
        sender: 'contact:alice',
        channel: 'bluebubbles',
        payload: { type: 'text', body: 'Second' },
      }),
    ];
    const result = formatMessagesForSampling(envelopes);
    expect(result).toBe(
      'New message from contact:alice via telegram [id:msg-001]:\nFirst\n\n' +
        'New message from contact:alice via bluebubbles [id:msg-002]:\nSecond'
    );
  });

  it('renders non-text payload type as bracketed label', () => {
    const env = makeEnvelope({ payload: { type: 'image', body: '' } as unknown as MessageEnvelope['payload'] });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('[image]');
    expect(result).not.toContain('undefined');
  });

  // ── E9: memory context prepending ────────────────────────────────────────────

  it('prepends memory_context when present in first envelope metadata', () => {
    const context = '<memory contact="alice">\n## Known facts\n- [fact] Likes hiking\n</memory>';
    const env = makeEnvelope({ metadata: { memory_context: context } });
    const result = formatMessagesForSampling([env]);
    expect(result.startsWith(context)).toBe(true);
    expect(result).toContain('New message from contact:alice');
  });

  it('does not prepend when memory_context is absent', () => {
    const env = makeEnvelope();
    const result = formatMessagesForSampling([env]);
    expect(result.startsWith('New message')).toBe(true);
  });

  it('does not prepend when memory_context is empty string', () => {
    const env = makeEnvelope({ metadata: { memory_context: '' } });
    const result = formatMessagesForSampling([env]);
    expect(result.startsWith('New message')).toBe(true);
  });

  it('only reads memory_context from the first envelope in a batch', () => {
    const context = '<memory contact="alice">\n## Known facts\n- [fact] Likes hiking\n</memory>';
    const env1 = makeEnvelope({ id: 'msg-001', metadata: { memory_context: context } });
    const env2 = makeEnvelope({ id: 'msg-002', metadata: {} });
    const result = formatMessagesForSampling([env1, env2]);
    // Context appears once at the start
    expect(result.indexOf(context)).toBe(0);
    expect(result.indexOf(context, 1)).toBe(-1); // not repeated
    expect(result).toContain('msg-001');
    expect(result).toContain('msg-002');
  });

  it('does not double-inject memory_context if called twice on the same envelope', () => {
    const context = '<memory contact="alice">\n## Known facts\n- [fact] Likes hiking\n</memory>';
    const env = makeEnvelope({ metadata: { memory_context: context } });
    const first = formatMessagesForSampling([env]);
    const second = formatMessagesForSampling([env]);

    expect(first.startsWith(context)).toBe(true);
    // memory_context was cleared after first call; second call omits it
    expect(second.startsWith('New message')).toBe(true);
    expect(second).not.toContain('<memory');
  });
});
