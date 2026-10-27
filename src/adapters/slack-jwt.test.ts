import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signJwt } from './slack-jwt.js';

const secret = 'a-shared-n8n-passphrase-of-32-chars!';

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('signJwt (E76)', () => {
  it('produces an HS256 header and the given claims', () => {
    const token = signJwt({ iss: 'agentbus', iat: 1000, exp: 1060, jti: 'msg-1' }, secret);
    const [header, payload] = token.split('.');
    expect(decode(header!)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decode(payload!)).toEqual({ iss: 'agentbus', iat: 1000, exp: 1060, jti: 'msg-1' });
  });

  it('signs with the secret as raw UTF-8 bytes', () => {
    const token = signJwt({ iss: 'agentbus', iat: 1, exp: 2 }, secret);
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('uses base64url without padding', () => {
    const token = signJwt({ iss: 'agentbus', iat: 1, exp: 2, jti: '??>>' }, secret);
    expect(token).not.toMatch(/[+/=]/);
  });
});
