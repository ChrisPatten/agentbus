import { describe, it, expect, vi } from 'vitest';
import {
  detectSamplingCapability,
  formatMessagesForSampling,
  processAckedMessages,
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

// ── S13.1 — Capability negotiation ───────────────────────────────────────────

describe('detectSamplingCapability', () => {
  it('returns true when sampling is present in caps', () => {
    expect(detectSamplingCapability({ sampling: {} })).toBe(true);
  });

  it('returns false when sampling is absent from caps', () => {
    expect(detectSamplingCapability({})).toBe(false);
  });

  it('returns false when caps is undefined', () => {
    expect(detectSamplingCapability(undefined)).toBe(false);
  });
});

// ── S13.2 — processAckedMessages (poll → enqueue path) ───────────────────────

describe('processAckedMessages', () => {
  it('enqueues formatted text when sampling is available', () => {
    const buffer: MessageEnvelope[] = [];
    const queue = { enqueue: vi.fn() };
    const sendLogging = vi.fn();
    const acked = [makeEnvelope()];

    processAckedMessages(acked, buffer, true, queue, sendLogging);

    expect(buffer).toHaveLength(1);
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith(
      'New message from contact:chris via telegram [id:msg-001]:\nHello Peggy!'
    );
    expect(sendLogging).not.toHaveBeenCalled();
  });

  it('calls sendLogging instead of enqueue when sampling is unavailable', () => {
    const buffer: MessageEnvelope[] = [];
    const sendLogging = vi.fn();
    const acked = [makeEnvelope()];

    processAckedMessages(acked, buffer, false, null, sendLogging);

    expect(buffer).toHaveLength(1);
    expect(sendLogging).toHaveBeenCalledOnce();
    expect(sendLogging).toHaveBeenCalledWith(
      '[agentbus] 1 new message(s) — call get_pending_messages'
    );
  });

  it('enqueues a single batch for multiple acked messages', () => {
    const buffer: MessageEnvelope[] = [];
    const queue = { enqueue: vi.fn() };
    const acked = [
      makeEnvelope({ id: 'msg-001', payload: { type: 'text', body: 'First' } }),
      makeEnvelope({ id: 'msg-002', payload: { type: 'text', body: 'Second' } }),
    ];

    processAckedMessages(acked, buffer, true, queue, vi.fn());

    expect(buffer).toHaveLength(2);
    // One enqueue call containing both messages
    expect(queue.enqueue).toHaveBeenCalledOnce();
    const text = queue.enqueue.mock.calls[0]![0] as string;
    expect(text).toContain('msg-001');
    expect(text).toContain('msg-002');
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
