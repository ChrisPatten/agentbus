/**
 * E96 S96.2 — certificate helpers for the surface listener and the pairing payload.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** SHA-256 fingerprint of a PEM certificate, `AA:BB:...` (what devices pin). */
export function certFingerprint(certPem: string | Buffer): string {
  return new X509Certificate(certPem).fingerprint256;
}

/** Fingerprint of the cert file at `path`, or null when it cannot be read or parsed. */
export function certFingerprintFile(path: string | undefined): string | null {
  if (!path) return null;
  try { return certFingerprint(readFileSync(path)); } catch { return null; }
}
