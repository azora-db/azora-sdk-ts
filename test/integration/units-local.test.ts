/**
 * The local test environment (@azora-db/units/testing) against a real
 * engine: the same units, the same calls, the same answers. Skipped when
 * there is no engine binary or it has no units.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { AzoraError, connect, UnitError, type Database } from '../../src/index.ts'
import { publishUnits } from '../../packages/units/src/publish.ts'
import { createTestEnv, type TestCallOptions, type TestEnv } from '../../packages/units/src/testing.ts'
import * as fixture from '../fixtures/units/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

type Units = typeof fixture
const dir = new URL('../fixtures/units', import.meta.url).pathname

const SCHEMA = [
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)',
  'CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
]
const CARTS = "INSERT INTO carts(id, customer, total, note) VALUES ('k42', 42, 20, 'mine'), ('k7', 7, 5, 'theirs'), ('k9', 9, 3, 'later')"

/** What an error looks like, for comparing the engine's with the local one. */
function shape(e: unknown): Record<string, unknown> {
  if (e instanceof UnitError) return { type: 'UnitError', unit: e.unit, code: e.code, message: e.message, data: e.data }
  if (e instanceof AzoraError) return { type: 'AzoraError', code: e.code, message: e.message }
  return { type: 'other', message: String(e) }
}

/** t.call without its types: for calls the types refuse. */
const untyped = (t: { call: unknown }) => t.call as (name: string, args?: unknown, opts?: TestCallOptions) => Promise<unknown>

const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Record<string, unknown> }> =>
  p.then((value) => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, error: shape(e) }))

describe.skipIf(!engineBinary())('units: local test environment = engine', () => {
  let engine: Engine
  let supported = false
  let db: Database<Units>
  let customer: Database<Units>
  let local: TestEnv<Units>
  let asCustomer: TestEnv<Units>

  beforeAll(async () => {
    engine = await startEngine({
      schema: [...SCHEMA, CARTS],
      publish: ['orders'],
      tokens: { customer42: ['--sub', 'user:42', '--scope', 'read', '--ttl', '1h', '--table', 'orders'] },
    })
    const doc = (await (await fetch(`${engine.httpUrl}/.well-known/azora.json`)).json()) as { features?: unknown }
    supported = Array.isArray(doc.features) && doc.features.includes('units')
    if (!supported) return
    const url = `${engine.connectUrl}?key=${engine.serverKey}`
    db = await connect<Units>(url, { token: engine.apiKey })
    customer = await connect<Units>(url, { token: engine.tokens['customer42']! })
    await publishUnits(db, dir)
    local = createTestEnv(fixture, { schema: [...SCHEMA, CARTS], auth: { kind: 'key', principal: 'key:app', scopes: ['read', 'write', 'ddl'] } })
    // The customer shares the local database: another env would have its own.
    asCustomer = { ...local, call: ((name: string, args?: unknown) => untyped(local)(name, args, { auth: { subject: 'user:42', scopes: ['read'] } })) as unknown as TestEnv<Units>['call'] }
  })
  afterAll(async () => {
    local?.close()
    await Promise.all([db?.close(), customer?.close()])
    await engine?.stop()
  })

  const it = (name: string, fn: () => Promise<void>, timeout?: number): void => {
    test(name, async (ctx) => {
      if (!supported) ctx.skip()
      await fn()
    }, timeout)
  }

  it('a thrown UnitError reaches the caller the same way', async () => {
    const remote = await settle(customer.call('checkout', { cartId: 'k7' }))
    const here = await settle(asCustomer.call('checkout', { cartId: 'k7' }))
    expect(here).toEqual(remote)
    expect(remote).toMatchObject({ ok: false, error: { type: 'UnitError', code: 'permission_denied', message: 'this cart is not yours' } })
    expect(await settle(local.call('refuse'))).toEqual(await settle(db.call('refuse')))
    expect(await settle(local.call('checkout', { cartId: 'nope' }))).toEqual(await settle(db.call('checkout', { cartId: 'nope' })))
    // And a success: the customer's own cart.
    const ok = await settle(customer.call('checkout', { cartId: 'k42' }))
    const okHere = await settle(asCustomer.call('checkout', { cartId: 'k42' }))
    expect(ok).toMatchObject({ ok: true, value: { total: 20 } })
    expect(okHere).toMatchObject({ ok: true, value: { total: 20 } })
    expect(local.db.all("SELECT what, substr(detail, 1, 22) AS d FROM audit WHERE what = 'checkout'")).toEqual(
      await db.query("SELECT what, substr(detail, 1, 22) AS d FROM audit WHERE what = 'checkout'"),
    )
  })

  it('a mutation that throws rolls back the same way', async () => {
    const remote = await settle(db.call('boom'))
    const here = await settle(local.call('boom'))
    expect(remote).toMatchObject({ ok: false, error: { type: 'UnitError', code: 'failed', message: 'boom' } })
    expect(here).toEqual(remote)
    expect(local.db.value('SELECT count(*) FROM counter WHERE id = 99')).toBe(await db.queryValue('SELECT count(*) FROM counter WHERE id = 99'))
    expect(local.db.value('SELECT count(*) FROM counter WHERE id = 99')).toBe(0)
  })

  it('arguments that do not match, internal and unknown units are refused the same way, and logged as rejected', async () => {
    const cases: Array<[string, unknown]> = [
      ['checkout', { cartId: 1 }],
      ['checkout', { cartId: 'a', extra: true }],
      ['checkout', {}],
      ['checkout', undefined],
      ['bump', { by: 0 }],
      ['bump', { by: 1.5 }],
      ['remindCart', { cartId: 'x'.repeat(65) }],
      ['audit', { what: 'x' }],
      ['nope', {}],
    ]
    for (const [unit, args] of cases) {
      const remote = await settle(db.call(unit, args))
      expect(remote.ok, `${unit} ${JSON.stringify(args)}`).toBe(false)
      expect(await settle(untyped(local)(unit, args)), `${unit} ${JSON.stringify(args)}`).toEqual(remote)
    }
    const remoteRuns = (await db.unitsAdmin.runs({ status: 'rejected', limit: 100 })).reverse()
    const localRuns = local.runs({ status: 'rejected' })
    const view = (r: { unit: string; trigger: string; principal: string; status: string; error: string }) => [r.unit, r.trigger, r.principal, r.status, r.error]
    expect(localRuns.map(view)).toEqual(remoteRuns.map(view))
    expect(localRuns.length).toBe(cases.length - 1) // an unknown unit is not logged
  })

  it('a scheduled job runs the same way: as the system, with ctx.unit.job, removed when done', async () => {
    const remote = (await db.call('remindCart', { cartId: 'k9', minutes: 0 })) as { jobId: string }
    const here = (await local.call('remindCart', { cartId: 'k9', minutes: 0 })) as { jobId: string }
    expect(here.jobId).toMatch(/^job_[a-z2-7]{26}$/)
    expect(remote.jobId).toMatch(/^job_[a-z2-7]{26}$/)
    const reminder = "SELECT replace(detail, ?, '<job>') AS d FROM audit WHERE what = 'reminder'"
    await until(async () => (await db.query(reminder, [remote.jobId])).length === 1, 'the job on the engine')
    expect(await local.runJobs()).toBe(1)
    expect(local.db.all(reminder, here.jobId)).toEqual(await db.query(reminder, [remote.jobId]))
    expect(local.db.all(reminder, here.jobId)).toEqual([{ d: 'cart k9 of customer 9 is waiting (<job>)' }])
    const view = (r: { unit: string; trigger: string; principal: string; status: string }, id: string) => [r.unit, r.trigger, r.principal.replace(id, '<job>'), r.status]
    const remoteRun = (await db.unitsAdmin.runs({ unit: 'cartReminder' }))[0]!
    expect(view(local.runs({ unit: 'cartReminder' }).at(-1)!, here.jobId)).toEqual(view(remoteRun, remote.jobId))
    expect(view(remoteRun, remote.jobId)).toEqual(['cartReminder', 'job', 'job:<job>', 'ok'])
    expect((await db.unitsAdmin.jobs.list()).jobs).toEqual([])
    expect(local.jobs()).toEqual([])

    // A waiting job is listed the same way, and cancelled.
    const later = (await db.call('remindCart', { cartId: 'k9', minutes: 60 })) as { jobId: string }
    const laterHere = (await local.call('remindCart', { cartId: 'k9', minutes: 60 })) as { jobId: string }
    const list = await db.unitsAdmin.jobs.list({ state: 'pending' })
    expect(list).toMatchObject({ pending: 1, failed: 0 })
    const job = (j: { unit: string; args: unknown; runAt: number; createdAt: number; createdBy: string; source: string; attempts: number; state: string; error: string }) =>
      ({ unit: j.unit, args: j.args, delay: j.runAt - j.createdAt, createdBy: j.createdBy, source: j.source, attempts: j.attempts, state: j.state, error: j.error })
    expect(local.jobs().map(job)).toEqual(list.jobs.map(job))
    expect(list.jobs[0]!.id).toBe(later.jobId)
    expect(await db.unitsAdmin.jobs.cancel(later.jobId)).toBe(true)
    expect(local.cancelJob(laterHere.jobId)).toBe(true)
    await expect(db.unitsAdmin.jobs.retry(later.jobId)).rejects.toMatchObject({ code: 'not_found' })
  })
})
