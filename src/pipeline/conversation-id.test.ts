import { describe, it, expect } from 'vitest';
import { computeConversationId } from './conversation-id.js';

describe('computeConversationId', () => {
  it('matches an independently-computed sha256 for a known input', () => {
    // sha256("alice:general:telegram") — sorted(['alice', 'telegram', 'general'])
    // = ['alice', 'general', 'telegram'], joined with ':'. Verified independently
    // via `printf '%s' "alice:general:telegram" | shasum -a 256`.
    const expected = 'ed61913e7730ebd7ab40ec11e11b234637b14c40271b0e1dbd662115766d4613';
    expect(computeConversationId('alice', 'telegram', 'general')).toBe(expected);
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(computeConversationId('bob', 'bluebubbles', 'code')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: the same inputs produce the same hash every call', () => {
    const a = computeConversationId('bob', 'bluebubbles', 'code');
    const b = computeConversationId('bob', 'bluebubbles', 'code');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = computeConversationId('alice', 'telegram', 'general');
    const b = computeConversationId('alice', 'telegram', 'code');
    expect(a).not.toBe(b);
  });
});
