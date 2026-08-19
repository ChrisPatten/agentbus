import { describe, it, expect } from 'vitest';
import { channelMatches } from './types.js';

describe('channelMatches', () => {
  it('matches an exact channel', () => {
    expect(channelMatches('telegram:peggy', 'telegram:peggy')).toBe(true);
  });

  it('matches a group derived from the base channel (E28)', () => {
    expect(channelMatches('telegram:peggy', 'telegram:peggy:group:-1003977797157')).toBe(true);
    expect(channelMatches('telegram:peggy', 'telegram:peggy:group:-1')).toBe(true);
  });

  it('does not match an unrelated channel', () => {
    expect(channelMatches('telegram:peggy', 'telegram:pokeclaude')).toBe(false);
    expect(channelMatches('telegram:peggy', 'email:peggy')).toBe(false);
  });

  it('does not match a channel that merely shares a string prefix without the :group: separator', () => {
    expect(channelMatches('telegram:peggy', 'telegram:peggyland')).toBe(false);
    expect(channelMatches('telegram', 'telegram:peggy')).toBe(false);
  });

  it('does not match the base channel\'s own group against a different base channel', () => {
    expect(channelMatches('telegram:pokeclaude', 'telegram:peggy:group:-1')).toBe(false);
  });
});
