/** Error codes the server reports (`AzoraError.code`). */
export const ErrorCode = {
  Invalid: 'invalid',
  Unauthenticated: 'unauthenticated',
  PermissionDenied: 'permission_denied',
  NotFound: 'not_found',
  ResourceExhausted: 'resource_exhausted',
  Gone: 'gone',
  Unavailable: 'unavailable',
  Conflict: 'conflict',
  Internal: 'internal',
  Canceled: 'canceled',
} as const
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {})

/** An error reported by the server, with a stable `code`. */
export class AzoraError extends Error {
  override name = 'AzoraError'
  /** One of {@link ErrorCode}. */
  readonly code: ErrorCodeValue
  /** Fatal errors end the session (the client reconnects). */
  readonly fatal: boolean
  /** The server's retry hint in milliseconds (rate limits), 0 when none. */
  readonly retryAfterMs: number
  /** The HTTP status, for errors of the storage API. */
  readonly status?: number

  constructor(code: ErrorCodeValue, message: string, o: { fatal?: boolean; retryAfterMs?: number; status?: number } = {}) {
    super(`${code}: ${message}`)
    this.code = code
    this.fatal = o.fatal ?? false
    this.retryAfterMs = o.retryAfterMs ?? 0
    if (o.status !== undefined) this.status = o.status
  }
}

/** The client (or a subscription) was closed. */
export class ClosedError extends Error {
  override name = 'ClosedError'
  constructor(message = 'azora: closed') {
    super(message)
  }
}

/** A connection could not be established or was lost. */
export class ConnectionError extends Error {
  override name = 'ConnectionError'
}

/**
 * The encrypted handshake failed: the server does not hold the pinned key,
 * its key does not match the fingerprint, or the exchange was tampered with.
 */
export class HandshakeError extends ConnectionError {
  override name = 'HandshakeError'
}

/** A call ran past its timeout (`requestTimeoutMs`, or the caller's). */
export class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/**
 * A statement that cannot carry a mutation id (a schema change) was sent,
 * and the connection dropped before its answer: it may or may not have run.
 */
export class UnknownOutcomeError extends Error {
  override name = 'UnknownOutcomeError'
  constructor() {
    super('azora: connection lost before the answer; the statement may have run')
  }
}

/**
 * A subscription opened with `manualResync` lost its resume point: close it
 * and subscribe again without `since`.
 */
export class ResyncError extends Error {
  override name = 'ResyncError'
}

/** `verify()` must be called again after applying the next update. */
export class RetryVerifyError extends Error {
  override name = 'RetryVerifyError'
  constructor() {
    super('azora: verify again after applying the pending update')
  }
}

/** Reports whether err is a server error with the given code. */
export function isCode(err: unknown, code: ErrorCodeValue): err is AzoraError {
  return err instanceof AzoraError && err.code === code
}

/** A connection-level failure: the request may be sent again on a new connection. */
export class LostError extends Error {
  override name = 'LostError'
  /** Whether the request was (at least partly) written before the loss. */
  readonly sent: boolean
  override readonly cause: unknown

  constructor(sent: boolean, cause: unknown) {
    super(`connection lost: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.sent = sent
    this.cause = cause
  }
}

/** Hello rejections a reconnect will not fix by itself. */
export function isPermanent(err: unknown): boolean {
  if (!(err instanceof AzoraError)) return false
  return (
    err.code === ErrorCode.Unauthenticated ||
    err.code === ErrorCode.PermissionDenied ||
    err.code === ErrorCode.Invalid ||
    err.code === ErrorCode.NotFound
  )
}

/** The codes a unit throws (`UnitError.code`); anything else a unit throws arrives as `failed`. */
export const UnitErrorCode = {
  Invalid: 'invalid',
  NotFound: 'not_found',
  PermissionDenied: 'permission_denied',
  Conflict: 'conflict',
  Failed: 'failed',
} as const
export type UnitErrorCodeValue = (typeof UnitErrorCode)[keyof typeof UnitErrorCode] | (string & {})

/**
 * The error a unit threw (`throw new UnitError(code, message, data)` in the
 * unit, or any other exception, as code `failed`). Failures around the
 * unit (no such unit, arguments that do not match, a timeout) are an
 * {@link AzoraError} instead.
 */
export class UnitError extends Error {
  override name = 'UnitError'
  /** The unit that was called. */
  readonly unit: string
  /** One of {@link UnitErrorCode}. */
  readonly code: UnitErrorCodeValue
  /** The JSON value the unit attached (blobs as Uint8Array), undefined for none. */
  readonly data: unknown

  constructor(unit: string, code: UnitErrorCodeValue, message: string, data?: unknown) {
    super(message)
    this.unit = unit
    this.code = code
    this.data = data
  }
}
