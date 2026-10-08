import { describe, it, expect, vi } from 'vitest';
import { JournalRunGate } from '../../journaling/journalers/system-message.js';
import type { PipelineContext } from '../types.js';
import { createJournalHoldNotice } from './journal-hold.js';

const run = { runId: 'run-1', agentId: 'agent:peggy', recipient: 'agent:peggy-pool-1', startedAt: 'x', conversationId: 'conv-1', channel: 'telegram', contactId: 'chris', topic: 'general' };

const ctx = (over: Partial<PipelineContext> = {}, metadata: Record<string, unknown> = {}) => ({
  envelope: { id: 'm', timestamp: 'x', channel: 'telegram', topic: 'general', sender: 'contact:chris', recipient: '', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'hi' }, metadata },
  isSlashCommand: false, routes: [{ adapterId: 'cc-pool', recipientId: 'agent:peggy-pool-1' }], conversationId: 'conv-1', ...over,
}) as unknown as PipelineContext;

describe('journal-hold notice stage (E66 S66.8)', () => {
  it('notifies once per hold for a message routed to the held agent', async () => {
    const gate = new JournalRunGate();
    void gate.start(run);
    const notify = vi.fn();
    const stage = createJournalHoldNotice(gate, notify);
    await stage(ctx());
    await stage(ctx());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toEqual({ contactId: 'chris', channel: 'telegram', topic: 'general', conversationId: 'conv-1' });
  });

  it('skips slash commands, system-only turns, other conversations and other agents', async () => {
    const gate = new JournalRunGate();
    void gate.start(run);
    const notify = vi.fn();
    const stage = createJournalHoldNotice(gate, notify);
    await stage(ctx({ isSlashCommand: true }));
    await stage(ctx({}, { system_only: true }));
    await stage(ctx({ conversationId: 'conv-2' }));
    await stage(ctx({ routes: [{ adapterId: 'claude-code', recipientId: 'agent:other' }] }));
    expect(notify).not.toHaveBeenCalled();
  });
});
