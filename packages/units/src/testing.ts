/**
 * Test units locally, without an engine: `createTestEnv(units, options)`
 * runs a units module in Node against an in-memory SQLite database
 * (node:sqlite: Node.js 22.13 or later, or 23.4 and later), with the
 * engine's semantics: query, mutation and action transactions, ctx.run,
 * argument checks, the SQL rules, values, ctx.scheduler jobs on a fake
 * clock, and the run log. See the README (Testing units locally) for what
 * differs from the engine.
 *
 * ```ts
 * import * as units from '../units/index.ts'
 * import { createTestEnv } from '@azora-db/units/testing'
 *
 * const t = createTestEnv(units, { schema: ['CREATE TABLE carts(...)'], auth: { subject: 'user:42' } })
 * const { orderId } = await t.call('checkout', { cartId: 'c1' })
 * ```
 *
 * Errors are @azora-db/client's: a unit's thrown UnitError rejects with
 * its `UnitError`, a failure around the unit with its `AzoraError`.
 *
 * @packageDocumentation
 */
export {
  createTestEnv, jobBackoff, NODE_SQLITE, type TestAuth, type TestCallOptions, type TestChange, type TestDb, type TestEnv, type TestEnvOptions,
  type TestFetch, type TestLogLine,
} from './emulator/env.ts'
