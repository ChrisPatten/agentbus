import { describe, expect, it } from 'vitest';
import { fmtLocalDateTime, fmtRelativeAge, formatMessagesForSampling } from './message-format.js';
import type { MessageEnvelope } from '../types/envelope.js';

// E69 S69.5 — reply-target rendering in the shared formatter. (cc.test.ts
// covers the rest of the formatter but needs a config.yaml to load cc.ts.)

function env(metadata: Record<string, unknown>): MessageEnvelope {
  return {
    id: 'msg-1', timestamp: '2026-10-05T19:37:00.000Z', channel: 'app', topic: 'general',
    sender: 'contact:chris', recipient: 'agent:baxter', reply_to: null, priority: 'normal',
    payload: { type: 'text', body: 'Yes, move it' }, metadata,
  };
}

const bodyOf = (text: string) => text.split('\n').slice(1).join('\n');

describe('formatMessagesForSampling quotes (E28 / E69)', () => {
  it('keeps the Telegram quote line unchanged when there is no time or source', () => {
    const out = formatMessagesForSampling([env({ quoted_message: { sender_name: 'Chris', text: 'old note' } })]);
    expect(bodyOf(out)).toBe('[Replying to Chris: "old note"]\nYes, move it');
  });

  it('renders the source label and send time when present', () => {
    const out = formatMessagesForSampling([env({ quoted_message: {
      message_id: 'm1', sender_name: 'agent', text: 'Two calendar items', created_at: '2026-10-05T15:06:00.000Z', source: 'Ambient scan',
    } })]);
    expect(bodyOf(out)).toBe(`[Replying to a message from Ambient scan sent ${fmtLocalDateTime('2026-10-05T15:06:00.000Z')}: "Two calendar items"]\nYes, move it`);
  });

  it('names the agent\'s own and the user\'s own messages', () => {
    const own = formatMessagesForSampling([env({ quoted_message: { sender_name: 'agent', text: 't', source: 'agent' } })]);
    expect(bodyOf(own)).toBe('[Replying to your message: "t"]\nYes, move it');
    const user = formatMessagesForSampling([env({ quoted_message: { sender_name: 'you', text: 't', source: 'you' } })]);
    expect(bodyOf(user)).toBe('[Replying to the user\'s own message: "t"]\nYes, move it');
  });

  it('falls back to sender_name when only the time is present', () => {
    const out = formatMessagesForSampling([env({ quoted_message: { sender_name: 'agent', text: 't', created_at: '2026-10-05T15:06:00.000Z' } })]);
    expect(bodyOf(out)).toBe(`[Replying to agent's message sent ${fmtLocalDateTime('2026-10-05T15:06:00.000Z')}: "t"]\nYes, move it`);
  });
});

describe('date helpers (E69)', () => {
  it('formats an absolute local datetime with its zone', () => {
    expect(fmtLocalDateTime('2026-10-05T15:06:00.000Z', 'America/New_York')).toBe('2026-10-05 11:06 EDT');
    expect(fmtLocalDateTime('2026-01-05T00:30:00.000Z', 'America/New_York')).toBe('2026-01-04 19:30 EST');
    expect(fmtLocalDateTime('not a date')).toBe('not a date');
  });

  it('formats a coarse relative age', () => {
    const now = new Date('2026-10-05T19:06:00.000Z');
    expect(fmtRelativeAge('2026-10-05T19:05:30.000Z', now)).toBe('just now');
    expect(fmtRelativeAge('2026-10-05T18:54:00.000Z', now)).toBe('12m ago');
    expect(fmtRelativeAge('2026-10-05T15:06:00.000Z', now)).toBe('4h ago');
    expect(fmtRelativeAge('2026-10-02T19:06:00.000Z', now)).toBe('3d ago');
  });
});
