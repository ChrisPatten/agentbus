import { describe, it, expect, vi } from 'vitest';
import { createAdvisoryInject } from './advisory-inject.js';
import { SYSTEM_BLOCKS_KEY, SYSTEM_ONLY_KEY } from '../../core/system-block.js';
import type { PipelineContext } from '../types.js';

function ctx(overrides: Partial<PipelineContext> = {}, metadata: Record<string, unknown> = {}): PipelineContext {
  return {
    envelope: {
      id: 'm1', timestamp: '', channel: 'telegram:baxter', topic: 'general', sender: 'contact:chris',
      recipient: 'agent:baxter', reply_to: null, priority: 'normal', payload: { type: 'text', body: 'hi' }, metadata,
    },
    contact: { id: 'chris', displayName: 'Chris', platforms: {} },
    dedupKey: null, isSlashCommand: false, slashCommand: null, topics: [], priorityScore: 0,
    routes: [
      { adapterId: 'cc-headless', recipientId: 'agent:baxter' },
      { adapterId: 'telegram', recipientId: 'contact:alice' },
    ],
    conversationId: null, sessionId: null, sessionCreated: false,
    config: {} as PipelineContext['config'], db: {} as PipelineContext['db'],
    ...overrides,
  };
}

describe('advisory-inject stage (E65)', () => {
  it('attaches the block for the agent route only, passing the system-turn flag', async () => {
    const takeInjection = vi.fn(() => ({ block: '<agentbus-system kind="advisories">x</agentbus-system>', ids: ['a'] }));
    const c = ctx({}, { [SYSTEM_ONLY_KEY]: true });
    await createAdvisoryInject({ takeInjection })(c);
    expect(takeInjection).toHaveBeenCalledOnce();
    expect(takeInjection).toHaveBeenCalledWith('agent:baxter', 'chris', 'telegram:baxter', { systemTurn: true });
    expect(c.envelope.metadata[SYSTEM_BLOCKS_KEY]).toEqual([
      { text: '<agentbus-system kind="advisories">x</agentbus-system>', recipient: 'agent:baxter' },
    ]);
  });

  it('adds nothing when there is nothing to inject', async () => {
    const c = ctx();
    await createAdvisoryInject({ takeInjection: () => null })(c);
    expect(c.envelope.metadata[SYSTEM_BLOCKS_KEY]).toBeUndefined();
  });

  it('skips slash commands and unknown senders', async () => {
    const takeInjection = vi.fn(() => null);
    await createAdvisoryInject({ takeInjection })(ctx({ isSlashCommand: true }));
    await createAdvisoryInject({ takeInjection })(ctx({ contact: null }));
    expect(takeInjection).not.toHaveBeenCalled();
  });
});
