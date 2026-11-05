import { Store, canonicalJson } from '../db/store.js';
import { MupitError } from './errors.js';
import { sha256Hex } from '../security/tokens.js';
import { redact } from '../security/redaction.js';

export { Store };

/**
 * Execute a mutation exactly once per (actor, operation, request_id).
 * Must be called INSIDE a store.transaction so concurrent duplicates serialize:
 * BEGIN IMMEDIATE blocks the second caller until the first commits its record.
 * Results are redacted before storage: never persist tokens or contact values.
 */
export function withIdempotency<T extends Record<string, unknown>>(
  store: Store,
  actorId: string,
  operation: string,
  requestId: string,
  payload: unknown,
  fn: () => T,
): T & { idempotent_replay: boolean } {
  const payloadHash = sha256Hex(canonicalJson(payload));
  const existing = store.getIdempotent(actorId, operation, requestId);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new MupitError(
        'REQUEST_ID_REUSED',
        `request_id "${requestId}" was already used for "${operation}" with different arguments. Generate a fresh request_id per attempt.`,
      );
    }
    return { ...(JSON.parse(existing.result_json) as T), idempotent_replay: true };
  }
  const result = fn();
  store.putIdempotent(actorId, operation, requestId, payloadHash, JSON.stringify(redact(result)));
  return { ...result, idempotent_replay: false };
}
