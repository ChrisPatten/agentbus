/**
 * Minimal HS256 JWT signer for the slack channel's n8n webhook (E76, S76.0).
 *
 * n8n's Webhook node verifies the token with its JWT credential. With the
 * "Passphrase" key type, n8n uses the passphrase string itself as the HMAC
 * key, so the secret is signed here as raw UTF-8 bytes — never base64-decoded.
 */
import { createHmac } from 'node:crypto';

export interface JwtClaims {
  iss: string;
  iat: number;
  exp: number;
  jti?: string;
  [claim: string]: unknown;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
