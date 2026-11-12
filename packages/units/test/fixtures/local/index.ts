/** Units for the local test environment's tests: the example shop's, and probes of the engine's rules. */
import { action, mutation, onChange, query, schedule, UnitError, v } from '@azora-db/units'

export * from '../../../../../examples/units/units/index.ts'

export const SCHEMA = [
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)',
  'CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
  'CREATE TABLE vals(id INTEGER PRIMARY KEY, v)',
]

export const echo = query({ args: v.any(), handler: (_ctx, a) => a })

export const whoami = query({
  handler: (ctx) => ({ auth: { ...ctx.auth, has: ctx.auth.has('write') }, unit: ctx.unit }),
})

export const bump = mutation({
  args: { by: v.int({ min: 1 }) },
  handler: (ctx, { by }) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET n = n + excluded.n', by)
    return { n: ctx.db.value<number>('SELECT n FROM counter WHERE id = 1'), mutationId: ctx.unit.mutationId }
  },
})

export const boom = mutation({
  handler: (ctx) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (99, 1)')
    throw new Error('boom')
  },
})

export const refuse = query({ handler: () => { throw new UnitError('conflict', 'already paid', { order: 7, blob: Uint8Array.of(1, 2) }) } })

export const throwString = mutation({ handler: () => { throw 'plain' } })

/** Runs one statement and reports what happened. */
export const sql = mutation({
  args: { sql: v.string(), args: v.optional(v.array(v.any())), how: v.optional(v.enum(['all', 'exec'])) },
  handler: (ctx, a) => (a.how === 'all' ? ctx.db.all(a.sql, ...(a.args ?? [])) : ctx.db.exec(a.sql, ...(a.args ?? []))),
})

export const readSql = query({
  args: { sql: v.string(), how: v.enum(['all', 'exec']) },
  handler: (ctx, a) => (a.how === 'all' ? ctx.db.all(a.sql) : (ctx.db as unknown as { exec(s: string): unknown }).exec(a.sql)),
})

/** Stores arguments and reads them back, with SQLite's types. */
export const values = mutation({
  handler: (ctx) => {
    const args: unknown[] = [7, 7.5, 2n ** 60n, true, false, new Date(1_700_000_000_000), Uint8Array.of(1, 2, 3), null, undefined, { a: [1] }, 'x']
    for (const a of args) ctx.db.exec('INSERT INTO vals(v) VALUES (?)', a as never)
    const rows = ctx.db.all<{ v: unknown; t: string }>('SELECT v, typeof(v) AS t FROM vals ORDER BY id')
    return {
      rows: rows.map((r) => [typeof r.v === 'bigint' ? `bigint ${r.v}` : r.v, r.t]),
      big: ctx.db.value('SELECT 9007199254740993'),
      edge: ctx.db.value('SELECT 9007199254740992'),
      result: { big: 2n ** 60n, small: 5n, blob: Uint8Array.of(9), date: new Date(0) },
    }
  },
})

/** An action: writes commit on their own; ctx.db.tx groups them and rolls back on throw. */
export const act = action({
  args: { fail: v.boolean() },
  handler: async (ctx, { fail }) => {
    ctx.db.exec('INSERT INTO audit(at, what) VALUES (1, ?)', 'outside')
    try {
      await ctx.db.tx(async (db) => {
        db.exec('INSERT INTO audit(at, what) VALUES (2, ?)', 'inside')
        if (fail) throw new Error('nope')
      })
    } catch (e) {
      ctx.log.warn('tx failed:', (e as Error).message)
    }
    let nested = ''
    await ctx.db.tx(() => {
      try {
        ctx.db.exec('INSERT INTO audit(at, what) VALUES (3, ?)', 'wrong db')
      } catch (e) {
        nested = (e as Error).message
      }
    })
    const viaRun = await ctx.run('bump', { by: 2 })
    return { nested, viaRun, audit: ctx.db.all('SELECT what FROM audit ORDER BY id') }
  },
})

/** The ctx.run rules, each in a try. */
export const rules = mutation({
  handler: async (ctx) => {
    const out: Record<string, string> = {}
    const attempt = async (k: string, fn: () => unknown): Promise<void> => {
      try {
        out[k] = JSON.stringify(await fn()) ?? 'undefined'
      } catch (e) {
        out[k] = `threw: ${(e as Error).message}`
      }
    }
    await attempt('action', () => ctx.run('act', { fail: false }))
    await attempt('missing', () => ctx.run('nope'))
    await attempt('badArgs', () => ctx.run('bump', { by: 0 }))
    await attempt('internal', () => ctx.run('audit', { what: 'from rules' }))
    await attempt('deep', () => ctx.run('deep', { n: 20 }))
    await attempt('fetch', () => (ctx as unknown as { fetch(u: string): unknown }).fetch('https://example.com'))
    // A nested mutation that writes and throws, caught: its write stays (same transaction, no savepoint).
    await attempt('caught', () => ctx.run('boom'))
    out['counter99'] = String(ctx.db.value('SELECT n FROM counter WHERE id = 99'))
    return out
  },
})

export const deep = mutation({ args: { n: v.int() }, handler: (ctx, { n }): unknown => (n === 0 ? 'bottom' : ctx.run('deep', { n: n - 1 })) })

export const queryRunsMutation = query({ handler: (ctx) => ctx.run('bump', { by: 1 }) })

/** Schedules a job, then throws when asked (the job must roll back). */
export const later = mutation({
  args: { unit: v.string(), ms: v.number(), args: v.optional(v.any()), fail: v.optional(v.boolean()) },
  handler: (ctx, a) => {
    const id = ctx.scheduler.after(a.ms, a.unit, a.args)
    if (a.fail) throw new UnitError('conflict', 'rolled back')
    return id
  },
})

export const cancel = mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.scheduler.cancel(id) })

export const queryScheduler = query({ handler: (ctx) => (ctx as unknown as { scheduler: { after(ms: number, u: string): string } }).scheduler.after(0, 'bump') })

/** A job that records what it sees. */
export const record = mutation({
  internal: true,
  args: { tag: v.string() },
  handler: (ctx, { tag }) => {
    ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', ctx.now(), tag, JSON.stringify({ job: ctx.unit.job, trigger: ctx.unit.trigger, auth: ctx.auth.principal, kind: ctx.auth.kind }))
  },
})

/** A job that fails until counter 5 reaches n. */
export const flaky = mutation({
  args: { until: v.int() },
  handler: (ctx, { until }) => {
    const n = ctx.db.value<number>('SELECT n FROM counter WHERE id = 5') ?? 0
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (5, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1')
    if (n + 1 < until) throw new Error(`attempt ${ctx.unit.job?.attempt}`)
  },
})

export const fetcher = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    const r = await ctx.fetch(url, { method: 'post', body: { hello: 'world' } })
    return { status: r.status, ok: r.ok, type: r.headers.get('content-type'), body: await r.json() }
  },
})

export const secrets = query({
  handler: (ctx) => {
    let assign = 'allowed'
    try {
      ;(ctx.env as Record<string, string>)['X'] = 'y'
    } catch (e) {
      assign = (e as Error).name
    }
    ctx.log.info('keys', Object.keys(ctx.env), { n: 1 })
    ctx.log.error(new Error('logged'))
    return { key: ctx.env['STRIPE_KEY'], missing: ctx.env['NOPE'], assign, now: ctx.now(), uuid: ctx.uuid(), sha: ctx.crypto.sha256('abc') }
  },
})

export const tick = schedule({
  every: '1m',
  handler: (ctx) => void ctx.db.exec('INSERT INTO counter(id, n) VALUES (7, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1'),
})

export const seen = onChange<{ id: number; n: number }>({
  table: 'counter',
  ops: ['insert', 'update'],
  batch: 2,
  handler: (ctx, { changes, gap }) => {
    for (const c of changes) ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', c.seq, `seen ${c.op}`, JSON.stringify({ key: c.key, new: c.new, gap }))
  },
})

export const notAUnit = 42
