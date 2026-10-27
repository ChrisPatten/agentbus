import { describe, it, expect, vi } from 'vitest';
import { createTopicContextInject, TOPIC_CONTEXT_KEY } from './topic-context-inject.js';
import type { PipelineContext } from '../types.js';

function ctx(overrides: Partial<PipelineContext> = {}, metadata: Record<string, unknown> = {}, topic = 'thread:abc'): PipelineContext {
  return {
    envelope: {
      id: 'm1', timestamp: '', channel: 'telegram:group:-1', topic, sender: 'contact:chris',
      recipient: 'agent:peggy', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'hi' }, metadata,
    },
    contact: { id: 'chris', displayName: 'Chris', platforms: {} },
    dedupKey: null, isSlashCommand: false, slashCommand: null, topics: [], priorityScore: 0, routes: [],
    conversationId: 'c', sessionId: 's', sessionCreated: true,
    config: {} as PipelineContext['config'], db: {} as PipelineContext['db'],
    ...overrides,
  };
}

const reg = (text: string | null | (() => never)) => {
  const getTopicContext = vi.fn(typeof text === 'function' ? text : () => text);
  return { reg: { lookupByChannel: () => [{ getTopicContext }, ] } as never, getTopicContext };
};

describe('topic-context-inject stage', () => {
  it('stamps topic_context on the first message of a new session', async () => {
    const { reg: r, getTopicContext } = reg('[Topic context] Topic: X');
    const c = ctx();
    await createTopicContextInject(r)(c);
    expect(c.envelope.metadata[TOPIC_CONTEXT_KEY]).toBe('[Topic context] Topic: X');
    expect(getTopicContext).toHaveBeenCalledWith('telegram:group:-1', 'thread:abc');
  });

  it('does nothing when the session already existed', async () => {
    const { reg: r, getTopicContext } = reg('x');
    const c = ctx({ sessionCreated: false });
    await createTopicContextInject(r)(c);
    expect(getTopicContext).not.toHaveBeenCalled();
    expect(c.envelope.metadata[TOPIC_CONTEXT_KEY]).toBeUndefined();
  });

  it('skips non-thread topics, slash commands, system-only and journal turns', async () => {
    const { reg: r, getTopicContext } = reg('x');
    const stage = createTopicContextInject(r);
    await stage(ctx({}, {}, 'general'));
    await stage(ctx({ isSlashCommand: true }));
    await stage(ctx({}, { system_only: true }));
    await stage(ctx({}, { journal_run_id: 'r' }));
    expect(getTopicContext).not.toHaveBeenCalled();
  });

  it('adds nothing when the adapter has no context, and never throws', async () => {
    const c = ctx();
    await createTopicContextInject(reg(null).reg)(c);
    expect(c.envelope.metadata[TOPIC_CONTEXT_KEY]).toBeUndefined();
    const boom = reg(() => { throw new Error('db down'); }).reg;
    const c2 = ctx();
    await expect(createTopicContextInject(boom)(c2)).resolves.toBe(c2);
  });
});
