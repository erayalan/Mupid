import { createHmac, createHash, randomBytes } from 'node:crypto';

/** 256-bit random Bearer [REDACTED] base64url-encoded (43 chars, no padding). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a token. Only hashes are stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Deterministic registration token: HMAC(serverSecret, domain + registrationKey).
 * Same registration key -> same token, so a lost response can be retried safely
 * without storing any plaintext token server-side.
 */
export function deriveRegistrationToken(serverSecret: Buffer, registrationKey: string): string {
  return createHmac('sha256', serverSecret).update(`mupit-reg-token-v1:${registrationKey}`, 'utf8').digest('base64url');
}

/** Public opaque ID: prefix + 96 bits of randomness, hex. */
export function randomId(prefix: 'p' | 'c' | 'm' | 'r' | 'e'): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function randomRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
