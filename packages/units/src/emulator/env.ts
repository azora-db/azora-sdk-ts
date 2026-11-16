/**
 * The local test environment: a user's units run in Node against an
 * in-memory SQLite database (node:sqlite), with the engine's semantics
 * (internal/units: engine.go, host.go, scheduler.go, jobs.go): kinds and
 * transactions, ctx.run, argument checks, the SQL check, value
 * conversions, the run log, jobs with their retries.
 */
import type { Units } from '@azora-db/client'
import { PendingUpload } from './files.ts'
import { bytesArg } from './runtime.ts'
import { TestEnvImpl } from './test-env.ts'
import type { TestCallOptions, TestEnv, TestEnvOptions } from './types.ts'

export { jobBackoff, NODE_SQLITE } from './runtime.ts'
export type {
  TestAuth,
  TestCallOptions,
  TestChange,
  TestDb,
  TestEnv,
  TestEnvOptions,
  TestFetch,
  TestLogLine,
  TestRequest,
  TestResponse,
  TestStorage,
} from './types.ts'

/**
 * Runs units locally, without an engine: the module's units against an
 * in-memory SQLite database (node:sqlite, Node.js 22.13+), with the
 * engine's transactions, argument checks, SQL rules, values, jobs and
 * run log.
 *
 * ```ts
 * import * as units from '../units/index.ts'
 * import { createTestEnv } from '@azora-db/units/testing'
 *
 * const t = createTestEnv(units, { schema: ['CREATE TABLE carts(...)'], auth: { subject: 'user:42' } })
 * const { orderId } = await t.call('checkout', { cartId: 'c1' })
 * t.db.all('SELECT * FROM orders')
 * await t.advance(24 * 3600e3) // runs the jobs that fall due
 * ```
 */
export function createTestEnv<M>(units: M, options: TestEnvOptions = {}): TestEnv<M> {
  if (typeof units !== 'object' || units === null)
    throw new TypeError('createTestEnv: pass your units module (import * as units from ...)')
  const t = new TestEnvImpl(units as Record<string, unknown>, options)
  return {
    call: ((name: string, args?: unknown, opts?: TestCallOptions) => t.call(name, args, opts)) as TestEnv<M>['call'],
    units: t.unitsProxy as unknown as Units<M>,
    db: t.db,
    runSchedule: (name) => t.runSchedule(name),
    change: (name, changes, o) => t.change(name, changes, o),
    jobs: (f) => t.jobs(f),
    runJobs: () => t.runJobs(),
    advance: (ms) => t.advance(ms),
    now: () => t.clock,
    cancelJob: (id) => t.cancelJob(id),
    retryJob: (id) => t.retryJob(id),
    runs: (f = {}) =>
      t.runLog.filter(
        (r) => (f.unit === undefined || r.unit === f.unit) && (f.status === undefined || r.status === f.status),
      ),
    logs: (f = {}) => t.logLines.filter((l) => f.unit === undefined || l.unit === f.unit),
    request: (name, init) => t.request(name, init),
    storage: {
      put: (content, opts = {}) => t.files.store(new PendingUpload(new Uint8Array(bytesArg(content)), opts, true)),
      stat: (id) => t.files.stat(id),
      read: (id) => t.files.read(id),
      text: (id) => {
        const b = t.files.read(id)
        return b === null ? null : new TextDecoder().decode(b)
      },
      list: () => t.files.list(),
    },
    close: () => t.raw.close(),
  }
}
