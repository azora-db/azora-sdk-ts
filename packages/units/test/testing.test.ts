import { describe, expect, test } from 'vitest'
import { AzoraError, UnitError } from '@azora-db/client'
import { createHmac } from 'node:crypto'
import { action, httpResponse, mutation, query, UnitError as Thrown, v } from '../src/index.ts'
import { createTestEnv, jobBackoff, type TestCallOptions, type TestEnvOptions } from '../src/testing.ts'
import * as units from './fixtures/local/index.ts'

const START = Date.UTC(2026, 10, 10, 12, 0, 0)
let n = 0
/** Deterministic random bytes. */
const random = (k: number): Uint8Array => Uint8Array.from({ length: k }, () => n++ & 0xff)

function env(o: TestEnvOptions = {}) {
  const t = createTestEnv(units, { schema: units.SCHEMA, now: START, random, ...o })
  t.db.exec("INSERT INTO carts(id, customer, total, note) VALUES ('c42', 42, 20, 'mine'), ('c7', 7, 5, 'theirs')")
  return t
}

const customer = { subject: 'user:42', claims: { plan: 'pro' } }

/** t.call without its types: for calls the types refuse. */
const untyped = (t: { call: unknown }) => t.call as (name: string, args?: unknown, opts?: TestCallOptions) => Promise<unknown>

describe('createTestEnv', () => {
  test('calls run the units with the caller in ctx.auth; results come back as from db.call', async () => {
    const t = env({ auth: customer })
    const { orderId, total } = await t.call('checkout', { cartId: 'c42' })
    expect(total).toBe(20)
    expect(t.db.one('SELECT customer, status, total FROM orders WHERE id = ?', orderId)).toEqual({ customer: 42, status: 'open', total: 20 })
    expect(t.db.value("SELECT count(*) FROM carts WHERE id = 'c42'")).toBe(0)
    expect(t.db.all('SELECT what FROM audit')).toEqual([{ what: 'checkout' }]) // ctx.run of an internal unit, same transaction
    expect(await t.units.myOrders()).toEqual([{ id: orderId, customer: 42, status: 'open', total: 20, note: 'mine' }])

    const who = (await t.call('whoami')) as unknown as { auth: Record<string, unknown>; unit: Record<string, unknown> }
    expect(who.auth).toEqual({ kind: 'token', principal: 'user:42', subject: 'user:42', scopes: ['read', 'write'], tables: [], claims: { plan: 'pro' }, has: true })
    expect(who.unit).toMatchObject({ name: 'whoami', kind: 'query', trigger: 'call', deploy: 1, job: null, mutationId: expect.stringMatching(/^m-[0-9a-f]{32}$/) })
    expect(await t.call('whoami', undefined, { auth: { scopes: ['read'] } })).toMatchObject({ auth: { kind: 'key', principal: 'key:test', subject: '', has: false } })
    expect(await t.call('whoami', undefined, { as: 'admin' })).toMatchObject({ auth: { kind: 'admin', principal: 'admin:test', has: true }, unit: { trigger: 'admin', mutationId: '' } })
  })

  test('a thrown UnitError rejects with the client UnitError; anything else is failed', async () => {
    const t = env({ auth: customer })
    const e = await t.call('checkout', { cartId: 'c7' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UnitError)
    expect(e).toMatchObject({ unit: 'checkout', code: 'permission_denied', message: 'this cart is not yours', data: undefined })
    await expect(t.call('checkout', { cartId: 'nope' })).rejects.toMatchObject({ code: 'not_found', data: { cartId: 'nope' } })
    await expect(t.call('refuse')).rejects.toMatchObject({ code: 'conflict', message: 'already paid', data: { order: 7, blob: Uint8Array.of(1, 2) } })
    await expect(t.call('throwString')).rejects.toMatchObject({ name: 'UnitError', code: 'failed', message: 'plain' })
    await expect(t.call('boom')).rejects.toMatchObject({ code: 'failed', message: 'boom' })
    expect(t.db.value('SELECT count(*) FROM counter WHERE id = 99')).toBe(0) // rolled back
    const runs = t.runs({ unit: 'boom' })
    expect(runs).toEqual([expect.objectContaining({ status: 'error', trigger: 'call', principal: 'user:42', error: expect.stringMatching(/^failed: boom\nError: boom\n/) })])
  })

  test('failures around the unit are AzoraErrors, logged as rejected', async () => {
    const t = env()
    const call = untyped(t)
    const invalid = await call('checkout', { cartId: 1 }).catch((x: unknown) => x)
    expect(invalid).toBeInstanceOf(AzoraError)
    expect(invalid).toMatchObject({ code: 'invalid', message: 'invalid: unit checkout: args.cartId: must be string, got integer' })
    await expect(call('checkout', {})).rejects.toThrow('invalid: unit checkout: args.cartId: is required')
    await expect(call('checkout', { cartId: 'a', x: 1 })).rejects.toThrow('args.x: is not an allowed argument')
    await expect(call('checkout', { cartId: '' })).rejects.toThrow('args.cartId: must be at least 1 characters')
    await expect(call('bump', { by: 1.5 })).rejects.toThrow('args.by: must be integer, got number')
    await expect(call('audit', { what: 'x' })).rejects.toMatchObject({ code: 'permission_denied', message: 'permission_denied: unit "audit" is internal: only other units can run it' })
    await expect(call('nope')).rejects.toMatchObject({ code: 'not_found', message: 'not_found: no unit "nope"' })
    await expect(call('stats')).rejects.toMatchObject({ code: 'permission_denied' }) // schedules are internal
    expect(t.runs({ status: 'rejected' }).map((r) => [r.unit, r.error])).toEqual([
      ['checkout', 'invalid: unit checkout: args.cartId: must be string, got integer'],
      ['checkout', 'invalid: unit checkout: args.cartId: is required'],
      ['checkout', 'invalid: unit checkout: args.x: is not an allowed argument'],
      ['checkout', 'invalid: unit checkout: args.cartId: must be at least 1 characters'],
      ['bump', 'invalid: unit bump: args.by: must be integer, got number'],
      ['audit', 'permission denied: unit "audit" is internal: only other units can run it'],
      ['stats', 'permission denied: unit "stats" is internal: only other units can run it'],
    ])
    // Internal units for cli and admin calls.
    await call('audit', { what: 'cli' }, { as: 'cli' })
    expect(t.runs().at(-1)).toMatchObject({ unit: 'audit', trigger: 'cli', principal: 'key:test', status: 'ok' })
  })

  test('mutation ids: a retried mutation runs once', async () => {
    const t = env()
    const a = await t.call('bump', { by: 5 }, { mutationId: 'm1' })
    expect(await t.call('bump', { by: 5 }, { mutationId: 'm1' })).toEqual(a)
    expect(t.db.value('SELECT n FROM counter WHERE id = 1')).toBe(5)
    expect(t.runs().map((r) => r.status)).toEqual(['ok', 'replayed'])
  })

  test('queries cannot write; SQL is checked like the engine does', async () => {
    const t = env()
    await expect(t.call('readSql', { sql: 'DELETE FROM carts', how: 'exec' })).rejects.toMatchObject({ code: 'failed', message: 'a query cannot write (make it a mutation)' })
    await expect(t.call('readSql', { sql: 'DELETE FROM carts', how: 'all' })).rejects.toMatchObject({ code: 'failed', message: 'attempt to write a readonly database' })
    expect(t.db.value('SELECT count(*) FROM carts')).toBe(2)
    const refused = async (s: string): Promise<string> => ((await t.call('sql', { sql: s }).catch((e: unknown) => e)) as Error).message
    expect(await refused('DELETE FROM carts; DELETE FROM orders')).toBe('one statement per call (use ctx.db.batch for several)')
    expect(await refused('  -- nothing\n')).toBe('empty statement')
    expect(await refused('/* x */ PRAGMA foreign_keys = OFF')).toBe('PRAGMA statements cannot run in a unit')
    expect(await refused('begin')).toBe('BEGIN statements cannot run in a unit')
    expect(await refused("ATTACH 'x.db' AS x")).toBe('ATTACH statements cannot run in a unit')
    expect(await refused('VACUUM')).toBe('VACUUM statements cannot run in a unit')
    expect(await refused('SELECT * FROM azora_units_jobs')).toBe('units cannot use the azora_units* tables')
    expect(await t.call('sql', { sql: "SELECT ';' AS s; -- trailing", how: 'all' })).toEqual([{ s: ';' }])
    expect(await refused('INSERT INTO counter(id, n) VALUES (1, NULL)')).toBe('NOT NULL constraint failed: counter.n')
  })

  test('values: integers, bigints, booleans, dates, blobs and JSON, as the engine converts them', async () => {
    const t = env()
    const r = (await t.call('values')) as { rows: unknown[]; big: unknown; edge: unknown; result: unknown }
    expect(r.rows).toEqual([
      [7, 'integer'], [7.5, 'real'], ['bigint 1152921504606846976', 'integer'], [1, 'integer'], [0, 'integer'], [1_700_000_000_000, 'integer'],
      [Uint8Array.of(1, 2, 3), 'blob'], [null, 'null'], [null, 'null'], ['{"a":[1]}', 'text'], ['x', 'text'],
    ])
    // Results go through JSON: a bigint beyond 2^53 is a string (the engine's prelude), blobs come back as bytes.
    expect(r.result).toEqual({ big: '1152921504606846976', small: 5, blob: Uint8Array.of(9), date: '1970-01-01T00:00:00.000Z' })
    expect(r.edge).toBe(9007199254740992)
    expect(r.big).toBe('9007199254740993')
    expect(await t.call('echo', { b: Uint8Array.of(0, 255), n: 10n, u: undefined })).toEqual({ b: Uint8Array.of(0, 255), n: 10 })
    expect(await t.call('echo')).toBeNull()
  })

  test('actions: writes commit on their own, ctx.db.tx groups them, ctx.run of a mutation is its own transaction', async () => {
    const t = env()
    const r = (await t.call('act', { fail: true }, { mutationId: 'a1' })) as { nested: string; viaRun: unknown; audit: unknown }
    expect(r.nested).toBe('ctx.db.tx is open: use the db its callback receives')
    expect(r.viaRun).toEqual({ n: 2, mutationId: 'a1' })
    expect(r.audit).toEqual([{ what: 'outside' }]) // 'inside' rolled back
    expect(t.logs({ unit: 'act' }).map((l) => [l.level, l.message])).toEqual([['warn', 'tx failed: nope']])
    expect(t.runs({ unit: 'act' })[0]?.logs).toBe('warn: tx failed: nope\n')
    await t.call('act', { fail: false })
    expect(t.db.all("SELECT what FROM audit WHERE what = 'inside'")).toHaveLength(1)
  })

  test('ctx.run: what may run what, depth 8, arguments checked, one transaction in a mutation', async () => {
    const t = env()
    expect(await t.call('rules')).toEqual({
      action: 'threw: ctx.run: a mutation cannot run an action (act)',
      missing: 'threw: ctx.run: no unit "nope"',
      badArgs: 'threw: ctx.run: invalid: unit bump: args.by: must be >= 1',
      internal: 'undefined',
      deep: 'threw: ctx.run: nested deeper than 8',
      fetch: 'threw: ctx.fetch is only available in actions (rules is a mutation)',
      caught: 'threw: boom',
      counter99: '1',
    })
    expect(t.db.value('SELECT n FROM counter WHERE id = 99')).toBe(1)
    await expect(t.call('queryRunsMutation')).rejects.toThrow('ctx.run: a query can only run queries (bump is a mutation)')
  })

  test('jobs: written in the mutation transaction, run by advance with ctx.unit.job, as the system', async () => {
    const t = env({ auth: customer })
    const { jobId } = await t.call('remindCart', { cartId: 'c42', minutes: 60 })
    expect(jobId).toMatch(/^job_[a-z2-7]{26}$/)
    expect(t.jobs()).toEqual([{
      id: jobId, unit: 'cartReminder', args: { cartId: 'c42' }, runAt: START + 3600e3, createdAt: START, createdBy: 'user:42', source: 'remindCart',
      attempts: 0, state: 'pending', error: '',
    }])
    expect(await t.runJobs()).toBe(0) // not due yet
    expect(await t.advance(59 * 60e3)).toBe(0)
    expect(await t.advance(60e3)).toBe(1)
    expect(t.now()).toBe(START + 3600e3)
    expect(t.jobs()).toEqual([])
    expect(t.db.one("SELECT at, detail FROM audit WHERE what = 'reminder'")).toEqual({ at: START + 3600e3, detail: `cart c42 of customer 42 is waiting (${jobId})` })
    expect(t.runs({ unit: 'cartReminder' })).toEqual([expect.objectContaining({ trigger: 'job', principal: `job:${jobId}`, status: 'ok' })])

    // A job whose mutation throws is never scheduled.
    await expect(t.call('later', { unit: 'record', ms: 0, args: { tag: 'x' }, fail: true })).rejects.toMatchObject({ code: 'conflict' })
    expect(t.jobs()).toEqual([])
    // ctx.unit.job and ctx.auth in the job.
    const id = (await t.call('later', { unit: 'record', ms: 1000, args: { tag: 'seen' } })) as string
    await t.advance(1000)
    expect(JSON.parse(t.db.value<string>("SELECT detail FROM audit WHERE what = 'seen'")!)).toEqual({
      job: { id, attempt: 1, scheduledAt: START + 3600e3, scheduledBy: 'user:42', source: 'later' }, trigger: 'job', auth: `job:${id}`, kind: 'system',
    })
    // Cancel, in a transaction too.
    const c = (await t.call('later', { unit: 'record', ms: 5000, args: { tag: 'never' } })) as string
    expect(await t.call('cancel', { id: c })).toBe(true)
    expect(await t.call('cancel', { id: c })).toBe(false)
    await t.advance(10_000)
    expect(t.db.value("SELECT count(*) FROM audit WHERE what = 'never'")).toBe(0)
  })

  test('jobs: arguments checked when scheduled, the target a mutation or action, queries cannot schedule', async () => {
    const t = env()
    const msg = async (a: Record<string, unknown>): Promise<string> => ((await untyped(t)('later', a).catch((e: unknown) => e)) as Error).message
    expect(await msg({ unit: 'record', ms: 0, args: { tag: 1 } })).toBe('ctx.scheduler: invalid: unit record: args.tag: must be string, got integer')
    expect(await msg({ unit: 'myOrders', ms: 0 })).toBe('ctx.scheduler: myOrders is a query; jobs run mutations and actions')
    expect(await msg({ unit: 'nope', ms: 0 })).toBe('ctx.scheduler: no unit "nope"')
    expect(await msg({ unit: 'record', ms: 367 * 24 * 3600e3, args: { tag: 'x' } })).toBe('ctx.scheduler.after: a job can be at most 366 days ahead')
    await expect(t.call('queryScheduler')).rejects.toThrow('ctx.scheduler: a query cannot schedule jobs (make it a mutation or an action)')
  })

  test('jobs: a failing job is retried with backoff, then failed; retry and cancel', async () => {
    const t = env({ jobAttempts: 3 })
    const id = (await t.call('later', { unit: 'flaky', ms: 0, args: { until: 10 } })) as string
    expect(await t.runJobs()).toBe(1)
    expect(t.jobs()[0]).toMatchObject({ id, state: 'pending', attempts: 1, error: 'failed: attempt 1', runAt: START + jobBackoff(1) })
    expect(await t.advance(999)).toBe(0)
    expect(await t.advance(1)).toBe(1) // 1s after the first failure
    expect(t.jobs()[0]).toMatchObject({ attempts: 2, runAt: START + 1000 + 2000 })
    expect(await t.advance(60_000)).toBe(1) // the third and last attempt
    // A failed job's time is when it failed.
    expect(t.jobs({ state: 'failed' })).toEqual([expect.objectContaining({ id, attempts: 3, error: 'failed: attempt 3', runAt: START + 3000 })])
    expect(t.runs({ unit: 'flaky' }).map((r) => r.status)).toEqual(['error', 'error', 'error'])
    expect(() => t.retryJob('job_nope')).toThrow('no job "job_nope"')
    t.retryJob(id)
    expect(t.jobs()[0]).toMatchObject({ state: 'pending', attempts: 0, error: '', runAt: t.now() })
    expect(() => t.retryJob(id)).toThrow(`job ${id} is pending, not failed`)
    await t.advance(60_000)
    expect(t.jobs({ state: 'failed' })).toHaveLength(1)
    expect(t.cancelJob(id)).toBe(true)
    expect(t.jobs()).toEqual([])
    expect(jobBackoff(1)).toBe(1000)
    expect(jobBackoff(5)).toBe(16_000)
    expect(jobBackoff(40)).toBe(3600e3)
  })

  test('schedules and onChange run when the test says so', async () => {
    const t = env()
    await t.runSchedule('tick')
    await t.runSchedule('tick')
    expect(t.db.value('SELECT n FROM counter WHERE id = 7')).toBe(2)
    expect(t.runs({ unit: 'tick' })[0]).toMatchObject({ trigger: 'schedule', principal: 'system', kind: 'schedule' })
    await expect(t.runSchedule('seen')).rejects.toThrow('seen is an onChange, not a schedule unit')
    await t.change('seen', [
      { op: 'insert', new: { id: 1, n: 1 } },
      { op: 'delete', old: { id: 1, n: 1 } }, // not in ops
      { op: 'update', old: { id: 1, n: 1 }, new: { id: 1, n: 2 } },
      { op: 'insert', new: { id: 2, n: 1 } },
    ])
    expect(t.runs({ unit: 'seen' })).toHaveLength(2) // batch: 2
    expect(t.db.all("SELECT what, detail FROM audit WHERE what LIKE 'seen %' ORDER BY id")).toEqual([
      { what: 'seen insert', detail: '{"key":{"id":1},"new":{"id":1,"n":1},"gap":false}' },
      { what: 'seen update', detail: '{"key":{"id":1},"new":{"id":1,"n":2},"gap":false}' },
      { what: 'seen insert', detail: '{"key":{"id":2},"new":{"id":2,"n":1},"gap":false}' },
    ])
    await t.change('orderPlaced', [{ op: 'insert', new: { id: 9, customer: 3, total: 4 } }])
    expect(t.db.value("SELECT detail FROM audit WHERE what = 'order placed'")).toBe('order 9 for customer 3: 4')
  })

  test('env, log, now, uuid, crypto', async () => {
    const lines: string[] = []
    const t = env({ env: { STRIPE_KEY: 'sk_test' }, onLog: (l) => lines.push(l.message) })
    const r = (await t.call('secrets')) as Record<string, unknown>
    expect(r).toMatchObject({ key: 'sk_test', assign: 'TypeError', now: START, sha: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
    expect(r['missing']).toBeUndefined()
    expect(r['uuid']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(lines[0]).toBe('keys ["STRIPE_KEY"] {"n":1}')
    expect(lines[1]).toMatch(/^Error: logged\n/)
  })

  test('fetch: refused without one, from the fetch option otherwise; actions only', async () => {
    const t = env()
    await expect(t.call('fetcher', { url: 'https://api.example.com/x' })).rejects.toThrow(/this test environment has no fetch: pass one to createTestEnv/)
    const seen: unknown[] = []
    const t2 = env({
      fetch: async (url, init) => {
        seen.push([url, init.method, init.headers, init.body])
        return Response.json({ got: JSON.parse(String(init.body)) }, { status: 201 })
      },
    })
    expect(await t2.call('fetcher', { url: 'https://api.example.com/x' })).toEqual({ status: 201, ok: true, type: 'application/json', body: { got: { hello: 'world' } } })
    expect(seen).toEqual([['https://api.example.com/x', 'POST', { 'Content-Type': 'application/json', 'User-Agent': 'azora-units' }, '{"hello":"world"}']])
    expect(t2.logs()[0]?.message).toMatch(/^fetch POST https:\/\/api\.example\.com\/x -> 201 \(\d+ms\)$/)
    await expect(t2.call('fetcher', { url: 'ftp://x' })).rejects.toThrow('ctx.fetch: only http and https URLs (got "ftp://x")')
  })

  test('access: a credential needs the unit\'s scope, unless the unit declares another', async () => {
    const t = createTestEnv({
      read: query({ handler: () => 1 }),
      change: mutation({ handler: () => 2 }),
      open: mutation({ access: 'any', handler: (ctx) => ctx.auth.has('write') }),
      locked: query({ access: 'write', handler: () => 4 }),
    })
    const reader = { auth: { kind: 'token' as const, subject: 'user:1', scopes: ['read'] } }
    const writer = { auth: { kind: 'key' as const, scopes: ['write'] } }
    expect(await t.call('read', undefined, reader)).toBe(1)
    await expect(t.call('change', undefined, reader)).rejects.toMatchObject({
      code: 'permission_denied', message: 'permission_denied: unit "change" needs the write scope (declare access: "any" to let every credential call it)',
    })
    expect(await t.call('open', undefined, reader)).toBe(false)
    await expect(t.call('locked', undefined, reader)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(t.call('read', undefined, writer)).rejects.toMatchObject({ code: 'permission_denied' }) // write does not include read
    expect(await t.call('change', undefined, writer)).toBe(2)
    expect(await t.call('locked', undefined, { auth: { kind: 'key', scopes: ['admin'] } })).toBe(4)
    // The default caller has read and write; cli and admin calls are not checked.
    expect(await t.call('change')).toBe(2)
    expect(await t.call('change', undefined, { ...reader, as: 'cli' })).toBe(2)
    expect(t.runs({ status: 'rejected' }).map((r) => r.unit)).toEqual(['change', 'locked', 'read'])

    expect(() => createTestEnv({ bad: { ...query({ handler: () => 1 }), access: 'admin' } })).toThrow('unit bad: access must be "any", "read" or "write"')
  })

  test('calls run one at a time; definitions are checked like a deploy', async () => {
    const t = env()
    await Promise.all([1, 2, 3, 4, 5].map(() => t.call('bump', { by: 1 })))
    expect(t.db.value('SELECT n FROM counter WHERE id = 1')).toBe(5)
    expect(() => createTestEnv({ x: 1 })).toThrow(/no units/)
    expect(() => createTestEnv({ bad_: query({ args: { a: { '~validator': true, schema: { format: 'email' }, optional: false } as never }, handler: () => 1 }) }))
      .toThrow('unit bad_: args schema .a: unsupported keyword "format"')
    expect(() => createTestEnv({ seen: units.seen })).toThrow('onChange unit seen: table "counter" does not exist')
    const typed = createTestEnv({ m: mutation({ args: { n: v.int() }, handler: (_c, { n }) => n * 2 }) })
    const two: number = await typed.call('m', { n: 1 })
    expect(two).toBe(2)
    // @ts-expect-error n is a number
    await expect(typed.call('m', { n: 'x' })).rejects.toThrow('must be integer')
  })
})

describe('ctx.storage in the local test environment', () => {
  const files = {
    save: mutation({
      args: { title: v.string(), text: v.string() },
      handler: (ctx, { title, text }) => ctx.db.exec('INSERT INTO docs(title, file) VALUES (?, ?)', title, ctx.storage.upload(text, { name: `${title}.txt`, metadata: { title } })).lastInsertId,
    }),
    read: query({
      args: { id: v.int() },
      handler: (ctx, { id }) => {
        const fileId = ctx.db.value<string>('SELECT file FROM docs WHERE id = ?', id) as string
        return { file: ctx.storage.stat(fileId), text: ctx.storage.text(fileId), n: ctx.storage.read(fileId).length, url: ctx.storage.url(fileId, { download: 'a.txt' }) }
      },
    }),
    put: mutation({ args: { path: v.string(), overwrite: v.optional(v.boolean()) }, handler: (ctx, { path, overwrite }) => ctx.storage.put(Uint8Array.of(1, 2, 3), { path, overwrite: overwrite === true }) }),
    drop: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.delete(id) }),
    putThenFail: mutation({ handler: (ctx) => { ctx.storage.put('x', { path: 'lost.txt' }); throw new Error('no') } }),
    twice: mutation({
      handler: (ctx) => {
        const up = ctx.storage.upload('once')
        ctx.db.exec("INSERT INTO docs(title, file) VALUES ('a', ?)", up)
        ctx.db.exec("INSERT INTO docs(title, file) VALUES ('b', ?)", up)
      },
    }),
    act: action({
      handler: async (ctx) => {
        const kept = ctx.storage.put('kept', { path: 'kept.txt' })
        await ctx.db.tx(async (db) => {
          db.exec("INSERT INTO docs(title, file) VALUES ('undone', ?)", ctx.storage.upload('undone'))
          throw new Error('undo')
        }).catch(() => {})
        return kept.id
      },
    }),
    grant: mutation({ handler: (ctx) => ctx.storage.uploadUrl({ bucket: 'avatars', max_size: 100 }, { ttl: 60 }) }),
    big: mutation({ handler: (ctx) => ctx.storage.put('x'.repeat(200)) }),
    inQuery: query({ handler: (ctx) => (ctx.storage as unknown as { put(c: string): unknown }).put('x') }),
    readArg: query({ handler: (ctx) => ctx.db.all('SELECT ?', (ctx.storage as unknown as { upload(c: string): never }).upload('x')) }),
  }
  const make = (limits = {}) => createTestEnv(files, { schema: 'CREATE TABLE docs(id INTEGER PRIMARY KEY, title TEXT, file FILE)', now: START, random, limits })

  test('a mutation stores a file with its row; a query reads it', async () => {
    const t = make()
    const id = await t.call('save', { title: 'notes', text: 'hello' })
    const r = await t.call('read', { id })
    const file = r.file
    if (!file) throw new Error('the file is missing')
    expect(file).toMatchObject({ bucket: 'default', path: '', name: 'notes.txt', contentType: 'text/plain', size: 5, metadata: { title: 'notes' }, createdAt: START })
    expect(file.id).toMatch(/^obj_[a-z2-7]{26}$/)
    expect(file.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect([r.text, r.n]).toEqual(['hello', 5])
    expect(r.url).toContain(`/storage/v1/o/test/${file.id}?`)
    expect(r.url).toContain('dl=a.txt')
    // The test sees the same files, and can seed its own.
    expect(t.storage.list().map((f) => f.name)).toEqual(['notes.txt'])
    expect(t.storage.text(file.id)).toBe('hello')
    const seeded = t.storage.put('seeded', { path: 'seed/a.txt' })
    expect(t.storage.stat(seeded.id)).toMatchObject({ path: 'seed/a.txt', size: 6 })
    expect(t.storage.read('obj_nope')).toBeNull()
    t.close()
  })

  test('files follow the transaction: a throw stores nothing, an action commits its put at once', async () => {
    const t = make()
    await expect(t.call('putThenFail')).rejects.toThrow('no')
    expect(t.storage.list()).toEqual([])
    const kept = await t.call('act')
    expect(t.storage.list().map((f) => f.id)).toEqual([kept]) // the upload inside the rolled back ctx.db.tx is gone
    expect(t.db.value('SELECT count(*) FROM docs')).toBe(0)
    t.close()
  })

  test('paths are unique unless overwritten; delete says whether there was a file', async () => {
    const t = make()
    const a = await t.call('put', { path: 'r/a.bin' })
    await expect(t.call('put', { path: 'r/a.bin' })).rejects.toThrow('object exists: default/r/a.bin')
    const again = await t.call('put', { path: 'r/a.bin', overwrite: true })
    expect(again.id).toBe(a.id)
    expect(await t.call('drop', { id: a.id })).toBe(true)
    expect(await t.call('drop', { id: a.id })).toBe(false)
    t.close()
  })

  test('what is refused, with the engine\'s words', async () => {
    const t = make({ maxFileBytes: 100 })
    await expect(t.call('inQuery')).rejects.toThrow('a query cannot store files (make it a mutation or an action)')
    await expect(t.call('big')).rejects.toThrow('ctx.storage: the content is 200 bytes, over units.max_file_bytes (100)')
    await expect(t.call('twice')).rejects.toThrow('this upload was already used')
    expect(t.db.value('SELECT count(*) FROM docs')).toBe(0)
    await expect(t.call('readArg')).rejects.toThrow('a query cannot store files')
    const g = await t.call('grant')
    expect(g.url).toContain('/storage/v1/u/test?')
    expect(g.expiresAt).toBe(START + 60_000)
    t.close()
  })
})

describe('t.request: units over plain HTTP, locally', () => {
  const api = {
    sum: query({ http: true, args: { a: v.number(), b: v.number() }, handler: (_ctx, { a, b }) => ({ sum: a + b }) }),
    echo: query({ http: 'public', handler: (ctx, args: unknown) => ({ args: args ?? null, request: ctx.request, kind: ctx.auth.kind }) }),
    hook: mutation({
      http: 'public',
      handler: (ctx, event: { type: string }) => {
        const r = ctx.request
        if (!r || !ctx.crypto.timingSafeEqual(ctx.crypto.hmac(ctx.env['SECRET'] ?? '', r.body), r.headers['x-signature'] ?? '')) throw new Thrown('permission_denied', 'bad signature')
        ctx.db.exec('INSERT INTO seen(type) VALUES (?)', event.type)
        return httpResponse({ ok: true }, { status: 202, headers: { 'X-Handled': 'yes' } })
      },
    }),
    page: query({ http: 'public', handler: () => httpResponse('<h1>hi</h1>', { headers: { 'Content-Type': 'text/html' } }) }),
    bytes: query({ http: 'public', handler: () => httpResponse(Uint8Array.of(0, 255)) }),
    boom: query({ http: 'public', handler: () => { throw new Thrown('conflict', 'taken', { id: 7 }) } }),
    hidden: mutation({ handler: () => 1 }),
  }
  const make = () => createTestEnv(api, { schema: 'CREATE TABLE seen(type TEXT)', env: { SECRET: 's3' } })

  test('a JSON body or the query are the arguments; ctx.request is the request', async () => {
    const t = make()
    const r = await t.request('echo', { path: '/a/b', query: { x: 1 }, headers: { 'X-Test': 'y', Authorization: 'Bearer nope' }, body: { n: 1 }, ip: '203.0.113.9' })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.json()).toEqual({
      args: { n: 1 }, kind: 'public',
      request: { method: 'POST', path: '/a/b', query: { x: '1' }, headers: { 'x-test': 'y', 'content-type': 'application/json' }, body: '{"n":1}', bytes: { $bytes: 'eyJuIjoxfQ==' }, ip: '203.0.113.9' },
    })
    expect(((await t.request('echo', { query: { a: 'b' } })).json() as { args: unknown }).args).toEqual({ a: 'b' })
    expect(((await t.request('echo', { body: 'plain text' })).json() as { args: unknown }).args).toBeNull()
    expect((await t.request('echo', { headers: { 'Content-Type': 'application/json' }, body: '{"n":' })).status).toBe(400)
    // Outside HTTP there is no request.
    expect(await t.call('echo')).toMatchObject({ request: null, kind: 'key' })
    t.close()
  })

  test('credentials, units that are not offered, errors as statuses', async () => {
    const t = make()
    expect((await t.request('sum', { body: { a: 1, b: 2 } })).status).toBe(401)
    expect((await t.request('sum', { body: { a: 1, b: 2 }, auth: { subject: 'user:1' } })).json()).toEqual({ sum: 3 })
    expect((await t.request('sum', { body: { a: 'x', b: 2 }, auth: {} })).status).toBe(400)
    expect((await t.request('sum', { body: { a: 1, b: 2 }, auth: { scopes: ['write'] } })).status).toBe(403) // a query needs read
    expect((await t.request('hidden', { auth: {} })).status).toBe(404)
    expect((await t.request('nope')).status).toBe(404)
    const boom = await t.request('boom')
    expect([boom.status, boom.json()]).toEqual([409, { error: { code: 'conflict', message: 'taken', data: { id: 7 } } }])
    expect(t.runs({ status: 'rejected' }).map((r) => [r.unit, r.trigger])).toContainEqual(['hidden', 'http'])
    t.close()
  })

  test('a webhook checks its signature and shapes its own response', async () => {
    const t = make()
    const body = '{"type":"paid"}'
    const sig = createHmac('sha256', 's3').update(body).digest('hex')
    const ok = await t.request('hook', { headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body })
    expect([ok.status, ok.headers['x-handled'], ok.json()]).toEqual([202, 'yes', { ok: true }])
    expect((await t.request('hook', { headers: { 'Content-Type': 'application/json', 'X-Signature': 'nope' }, body })).status).toBe(403)
    expect(t.db.all('SELECT type FROM seen')).toEqual([{ type: 'paid' }])
    // An Idempotency-Key runs the mutation once.
    const again = { headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'Idempotency-Key': 'evt_1' }, body }
    expect((await t.request('hook', again)).headers['azora-replayed']).toBeUndefined()
    expect((await t.request('hook', again)).headers['azora-replayed']).toBe('true')
    expect(t.db.value('SELECT count(*) FROM seen')).toBe(2)
    const page = await t.request('page')
    expect([page.body, page.headers['content-type']]).toEqual(['<h1>hi</h1>', 'text/html'])
    expect([...(await t.request('bytes')).bytes]).toEqual([0, 255])
    expect((await t.request('page', { method: 'HEAD' })).body).toBe('')
    t.close()
  })
})
