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
    sender: 'contact:chris',
    recipient: 'agent:peggy',
    reply_to: null,
    priority: 'normal',
    payload: { type: 'text', body: 'Hello Peggy!' },
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
      'New message from contact:chris via telegram [id:msg-001]:\nHello Peggy!'
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
      'New message from contact:chris via telegram [id:msg-001]:\nHello Peggy!'
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
      'New message from contact:chris via telegram [id:msg-001]:\nFirst\n\n' +
        'New message from contact:alice via bluebubbles [id:msg-002]:\nSecond'
    );
  });

  it('renders non-text payload type as bracketed label', () => {
    const env = makeEnvelope({ payload: { type: 'image', body: '' } as unknown as MessageEnvelope['payload'] });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('[image]');
    expect(result).not.toContain('undefined');
  });
});
