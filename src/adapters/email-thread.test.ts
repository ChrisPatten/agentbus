import { describe, it, expect } from 'vitest';
import {
  normalizeMessageId,
  parseReferences,
  deriveThreadKey,
  topicForThreadKey,
  baseSubject,
  replySubject,
  buildReferencesChain,
  stripQuotedReply,
  selectInboundBody,
  isSenderAuthenticated,
  dkimAuthenticated,
} from './email-thread.js';

describe('normalizeMessageId', () => {
  it('strips angle brackets and whitespace', () => {
    expect(normalizeMessageId('  <abc@host>  ')).toBe('abc@host');
  });
  it('returns empty string for null/undefined', () => {
    expect(normalizeMessageId(null)).toBe('');
    expect(normalizeMessageId(undefined)).toBe('');
  });
});

describe('parseReferences', () => {
  it('splits a whitespace-separated chain into bare ids', () => {
    expect(parseReferences('<a@h>\n <b@h>\t<c@h>')).toEqual(['a@h', 'b@h', 'c@h']);
  });
  it('accepts an array (mailparser shape)', () => {
    expect(parseReferences(['<a@h>', '<b@h>'])).toEqual(['a@h', 'b@h']);
  });
  it('returns [] for empty input', () => {
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences('')).toEqual([]);
  });
});

describe('deriveThreadKey', () => {
  it('uses the References root when present', () => {
    expect(
      deriveThreadKey({ references: ['root@h', 'mid@h'], inReplyTo: 'mid@h', messageId: 'new@h' }),
    ).toBe('root@h');
  });
  it('falls back to In-Reply-To when no References', () => {
    expect(deriveThreadKey({ references: [], inReplyTo: 'parent@h', messageId: 'new@h' })).toBe(
      'parent@h',
    );
  });
  it('falls back to own Message-ID for a new thread (or a forward)', () => {
    expect(deriveThreadKey({ references: [], inReplyTo: '', messageId: 'fresh@h' })).toBe('fresh@h');
  });

  it('keeps a whole reply chain on one stable key', () => {
    const root = deriveThreadKey({ references: [], inReplyTo: '', messageId: 'root@h' });
    const reply1 = deriveThreadKey({ references: ['root@h'], inReplyTo: 'root@h', messageId: 'r1@h' });
    const reply2 = deriveThreadKey({
      references: ['root@h', 'r1@h'],
      inReplyTo: 'r1@h',
      messageId: 'r2@h',
    });
    expect(topicForThreadKey(reply1)).toBe(topicForThreadKey(root));
    expect(topicForThreadKey(reply2)).toBe(topicForThreadKey(root));
  });

  it('a forward (no References) gets a different topic than the original thread', () => {
    const original = topicForThreadKey(
      deriveThreadKey({ references: [], inReplyTo: '', messageId: 'root@h' }),
    );
    const forward = topicForThreadKey(
      deriveThreadKey({ references: [], inReplyTo: '', messageId: 'fwd@h' }),
    );
    expect(forward).not.toBe(original);
  });
});

describe('topicForThreadKey', () => {
  it('produces a stable, prefixed, deterministic topic', () => {
    const t = topicForThreadKey('root@h');
    expect(t).toMatch(/^thread:[0-9a-f]{16}$/);
    expect(topicForThreadKey('root@h')).toBe(t);
  });
});

describe('baseSubject / replySubject', () => {
  it('strips any number of Re:/Fwd: prefixes', () => {
    expect(baseSubject('Re: Fwd: RE: Hello')).toBe('Hello');
    expect(baseSubject('FW: Status')).toBe('Status');
  });
  it('leaves a clean subject untouched', () => {
    expect(baseSubject('Project plan')).toBe('Project plan');
  });
  it('reply subject has exactly one Re: prefix', () => {
    expect(replySubject('Re: Re: Hello')).toBe('Re: Hello');
    expect(replySubject('Hello')).toBe('Re: Hello');
  });
  it('reply subject handles an empty/missing subject', () => {
    expect(replySubject('')).toBe('Re: (no subject)');
  });
});

describe('buildReferencesChain', () => {
  it('appends the replied-to id in angle-bracket form', () => {
    expect(buildReferencesChain(['root@h', 'mid@h'], 'mid@h')).toBe('<root@h> <mid@h>');
  });
  it('does not duplicate an id already in the chain', () => {
    expect(buildReferencesChain(['root@h'], 'root@h')).toBe('<root@h>');
  });
  it('handles a brand-new thread (refs == own id)', () => {
    expect(buildReferencesChain([], 'fresh@h')).toBe('<fresh@h>');
  });
});

describe('stripQuotedReply', () => {
  it('cuts at an "On … wrote:" boundary', () => {
    const body = 'Sounds good, thanks!\n\nOn Mon, Jun 1, 2026 at 9:00 AM Chris <c@h> wrote:\n> original';
    expect(stripQuotedReply(body)).toBe('Sounds good, thanks!');
  });
  it('cuts at a quoted block', () => {
    expect(stripQuotedReply('My answer.\n> you asked\n> more')).toBe('My answer.');
  });
  it('cuts at an Original Message divider', () => {
    expect(stripQuotedReply('Reply text\n-----Original Message-----\nfoo')).toBe('Reply text');
  });
  it('falls back to the full body when stripping would empty it', () => {
    expect(stripQuotedReply('> only quoted content')).toBe('> only quoted content');
  });
  it('leaves an unquoted body intact', () => {
    expect(stripQuotedReply('Just a plain message.')).toBe('Just a plain message.');
  });
});

describe('selectInboundBody', () => {
  const forward = [
    'Hey, can you look at this?',
    '',
    '---------- Forwarded message ---------',
    'From: Carol <carol@corp.com>',
    'Subject: Q3 plan',
    '',
    'Team, the Q3 plan: launch in August, budget $50k.',
  ].join('\n');

  it('a threaded reply strips the quoted history (session already holds it)', () => {
    const reply = 'Sounds good!\n\nOn Mon, Jun 1 Chris <c@h> wrote:\n> the original question';
    expect(selectInboundBody(reply, true)).toBe('Sounds good!');
  });

  it('a forward (new thread) keeps the full forwarded content', () => {
    const body = selectInboundBody(forward, false);
    expect(body).toContain('Forwarded message');
    expect(body).toContain('From: Carol');
    expect(body).toContain('Team, the Q3 plan: launch in August, budget $50k.');
  });

  it('regression: stripping a forward would have destroyed its payload', () => {
    // The old behaviour cut at the forwarded `From:` header, losing the content.
    expect(stripQuotedReply(forward)).not.toContain('launch in August');
    // selectInboundBody preserves it by not stripping new threads.
    expect(selectInboundBody(forward, false)).toContain('launch in August');
  });

  it('trims surrounding whitespace for a new thread', () => {
    expect(selectInboundBody('  hello world  \n', false)).toBe('hello world');
  });
});

describe('isSenderAuthenticated', () => {
  const dom = 'example.com';

  it('passes on dmarc=pass', () => {
    expect(isSenderAuthenticated(['spf=fail; dmarc=pass header.from=example.com'], dom)).toBe(true);
  });
  it('passes on dkim=pass aligned to the From domain', () => {
    expect(isSenderAuthenticated(['dkim=pass header.d=example.com'], dom)).toBe(true);
  });
  it('passes on dkim=pass with a subdomain signer (relaxed alignment)', () => {
    expect(isSenderAuthenticated(['dkim=pass header.i=@mail.example.com'], dom)).toBe(true);
  });
  it('passes on spf=pass aligned via smtp.mailfrom', () => {
    expect(isSenderAuthenticated(['spf=pass smtp.mailfrom=bounce@example.com'], dom)).toBe(true);
  });
  it('fails on dkim=pass for an UNALIGNED domain (spoof attempt)', () => {
    expect(isSenderAuthenticated(['dkim=pass header.d=evil.com'], dom)).toBe(false);
  });
  it('fails when all mechanisms fail', () => {
    expect(isSenderAuthenticated(['spf=fail; dkim=fail; dmarc=fail'], dom)).toBe(false);
  });
  it('fails when the header is absent', () => {
    expect(isSenderAuthenticated([], dom)).toBe(false);
  });
  it('fails when the From domain is empty', () => {
    expect(isSenderAuthenticated(['dmarc=pass'], '')).toBe(false);
  });
  it('handles multiple Authentication-Results headers', () => {
    expect(
      isSenderAuthenticated(['spf=pass smtp.mailfrom=other@x.com', 'dkim=pass header.d=example.com'], dom),
    ).toBe(true);
  });
});

describe('dkimAuthenticated', () => {
  it('passes when a signature is pass AND aligned', () => {
    expect(dkimAuthenticated([{ result: 'pass', aligned: true }])).toBe(true);
  });
  it('passes when aligned is the aligned-domain string (mailauth runtime shape)', () => {
    expect(dkimAuthenticated([{ result: 'pass', aligned: 'icloud.com' }])).toBe(true);
  });
  it('fails a passing-but-unaligned signature (third-party signer)', () => {
    expect(dkimAuthenticated([{ result: 'pass', aligned: false }])).toBe(false);
  });
  it('fails when the only signature does not verify', () => {
    expect(dkimAuthenticated([{ result: 'fail', aligned: true }])).toBe(false);
  });
  it('passes if any one of several signatures is pass+aligned', () => {
    expect(
      dkimAuthenticated([
        { result: 'fail', aligned: true },
        { result: 'pass', aligned: false },
        { result: 'pass', aligned: true },
      ]),
    ).toBe(true);
  });
  it('fails on no signatures', () => {
    expect(dkimAuthenticated([])).toBe(false);
  });
});
