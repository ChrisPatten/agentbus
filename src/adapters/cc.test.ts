import { describe, it, expect, vi } from 'vitest';
import {
  formatMessagesForSampling,
  processAckedMessages,
  sendChannelNotification,
} from './cc.js';
import type { MessageEnvelope } from '../types/envelope.js';

const FIXED_TS = '2026-01-01T00:00:00.000Z';

function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: 'msg-001',
    timestamp: FIXED_TS,
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
    const text = notify.mock.calls[0]![0] as string;
    expect(text).toMatch(/^New message from contact:alice via telegram at \d{4}-\d{2}-\d{2}T\d{2}:\d{2} \[id:msg-001\]:\nHello!$/);
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
  it('formats a single message with full date+time', () => {
    const result = formatMessagesForSampling([makeEnvelope()]);
    expect(result).toMatch(
      /^New message from contact:alice via telegram at \d{4}-\d{2}-\d{2}T\d{2}:\d{2} \[id:msg-001\]:\nHello!$/
    );
  });

  it('first message in batch gets full date+time, subsequent get time-only', () => {
    const envelopes = [
      makeEnvelope({ id: 'msg-001', payload: { type: 'text', body: 'First' } }),
      makeEnvelope({ id: 'msg-002', channel: 'bluebubbles', payload: { type: 'text', body: 'Second' } }),
    ];
    const result = formatMessagesForSampling(envelopes);
    const [first, second] = result.split('\n\n') as [string, string];
    expect(first).toMatch(/at \d{4}-\d{2}-\d{2}T\d{2}:\d{2} /);
    expect(second).toMatch(/at \d{2}:\d{2} /);
    expect(second).not.toMatch(/at \d{4}-/);
  });

  it('omits timestamp segment when envelope has no timestamp', () => {
    const env = makeEnvelope({ timestamp: undefined });
    const result = formatMessagesForSampling([env]);
    expect(result).toBe('New message from contact:alice via telegram [id:msg-001]:\nHello!');
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

  // ── image attachments ────────────────────────────────────────────────────────

  it('appends a single [Image: path] line after the body', () => {
    const env = makeEnvelope({
      metadata: {
        attachments: [{ type: 'image', local_path: '/tmp/agentbus/claude/abc.jpg' }],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('Hello!\n[Image: /tmp/agentbus/claude/abc.jpg]');
  });

  it('emits multiple [Image: ...] lines for multiple attachments', () => {
    const env = makeEnvelope({
      payload: { type: 'text', body: 'look' },
      metadata: {
        attachments: [
          { type: 'image', local_path: '/tmp/a.jpg' },
          { type: 'image', local_path: '/tmp/b.png', mime_type: 'image/png' },
        ],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('look\n[Image: /tmp/a.jpg]\n[Image: /tmp/b.png]');
  });

  it('renders an image-only message (empty body) as just the [Image: ...] line', () => {
    const env = makeEnvelope({
      payload: { type: 'text', body: '' },
      metadata: {
        attachments: [{ type: 'image', local_path: '/tmp/solo.jpg' }],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toMatch(/\[id:msg-001\]:\n\[Image: \/tmp\/solo\.jpg\]$/);
  });

  it('is unchanged when no attachments are present', () => {
    const result = formatMessagesForSampling([makeEnvelope()]);
    expect(result).not.toContain('[Image:');
    expect(result).not.toContain('[File:');
  });

  it('ignores unsupported types and malformed attachment entries', () => {
    const env = makeEnvelope({
      metadata: {
        attachments: [
          { type: 'image', local_path: '/tmp/ok.jpg' },
          { type: 'video', local_path: '/tmp/nope.mp4' },
          'garbage',
          { type: 'image' }, // missing local_path
        ],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('[Image: /tmp/ok.jpg]');
    expect(result).not.toContain('nope.mp4');
  });

  // ── file attachments ─────────────────────────────────────────────────────────

  it('renders a file attachment as [File: path — filename]', () => {
    const env = makeEnvelope({
      metadata: {
        attachments: [{ type: 'file', local_path: '/tmp/uuid.pdf', original_filename: 'report.pdf' }],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('[File: /tmp/uuid.pdf — report.pdf]');
  });

  it('renders a file attachment without original_filename as just [File: path]', () => {
    const env = makeEnvelope({
      metadata: {
        attachments: [{ type: 'file', local_path: '/tmp/uuid.pdf' }],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('[File: /tmp/uuid.pdf]');
    expect(result).not.toContain(' — ');
  });

  it('renders mixed image and file attachments in order', () => {
    const env = makeEnvelope({
      payload: { type: 'text', body: 'here' },
      metadata: {
        attachments: [
          { type: 'image', local_path: '/tmp/photo.jpg' },
          { type: 'file', local_path: '/tmp/uuid.pdf', original_filename: 'report.pdf' },
        ],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toContain('here\n[Image: /tmp/photo.jpg]\n[File: /tmp/uuid.pdf — report.pdf]');
  });

  it('renders a file-only message (empty body) as just the [File: ...] line', () => {
    const env = makeEnvelope({
      payload: { type: 'text', body: '' },
      metadata: {
        attachments: [{ type: 'file', local_path: '/tmp/uuid.pdf', original_filename: 'doc.pdf' }],
      },
    });
    const result = formatMessagesForSampling([env]);
    expect(result).toMatch(/\[id:msg-001\]:\n\[File: \/tmp\/uuid\.pdf — doc\.pdf\]$/);
  });
});
