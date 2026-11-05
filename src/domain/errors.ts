/** Stable machine-readable error codes. These are part of the MCP contract. */
export type MupitErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'VERSION_CONFLICT'
  | 'STALE_CONTEXT'
  | 'CONSENT_REQUIRED'
  | 'CONTACT_NOT_RELEASED'
  | 'CONVERSATION_CLOSED'
  | 'CONVERSATION_RELEASED'
  | 'INELIGIBLE_PAIR'
  | 'REQUEST_ID_REUSED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'SETUP_ERROR'
  | 'INTERNAL_ERROR';

export class MupitError extends Error {
  readonly code: MupitErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: MupitErrorCode, message: string, details?: Record<string, unknown>, retryable = false) {
    super(message);
    this.name = 'MupitError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function unauthorized(message = 'Invalid or missing participant token.'): MupitError {
  return new MupitError('UNAUTHORIZED', message);
}

/** Use for cross-participant access: reveals nothing about resource existence. */
export function notFound(what = 'resource'): MupitError {
  return new MupitError('NOT_FOUND', `No such ${what}, or you are not authorized to access it.`);
}

export function validation(message: string, details?: Record<string, unknown>): MupitError {
  return new MupitError('VALIDATION_ERROR', message, details);
}

export function versionConflict(message: string, details?: Record<string, unknown>): MupitError {
  return new MupitError('VERSION_CONFLICT', message, details);
}
