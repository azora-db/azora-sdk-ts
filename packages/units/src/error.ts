/** UnitError: the error a unit throws to answer its caller. */

/** The codes a unit may throw with. */
export type UnitErrorCode = 'invalid' | 'not_found' | 'permission_denied' | 'conflict' | 'failed'

/**
 * Thrown in a unit, it answers the caller with this code, message and
 * data (any JSON value):
 *
 * ```ts
 * if (!cart) throw new UnitError('not_found', 'no such cart', { cartId })
 * ```
 *
 * Any other thrown value reaches the caller as code `failed` with its
 * message. The engine recognizes the error by its `name` ("UnitError"),
 * which is set on every instance, so it survives bundling and renaming.
 */
export class UnitError extends Error {
  /** One of `invalid`, `not_found`, `permission_denied`, `conflict`, `failed`. */
  readonly code: UnitErrorCode
  /** A JSON value for the caller (undefined for none). */
  readonly data: unknown

  constructor(code: UnitErrorCode, message: string, data?: unknown) {
    super(message)
    // An own property, not the class's name: a bundler may rename the class.
    this.name = 'UnitError'
    this.code = code
    this.data = data
  }
}
