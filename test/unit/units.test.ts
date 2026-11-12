/**
 * Units from the client's side: Call and UnitAdmin on the wire, JSON with
 * blobs, retries, UnitError, the discovery feature check, and the types
 * `db.units` gets from a units module.
 */
import { afterEach, describe, expect, expectTypeOf, test } from 'vitest'
import {
  AzoraError, connect, UnitError, UnknownOutcomeError, type ConnectOptions, type Database, type UnitArgs, type UnitCallOptions, type UnitResult,
  type UnitsOf,
} from '../../src/index.ts'
import { MsgType, type Msg } from '../../src/messages.ts'
import { encodeUnitJSON, decodeUnitJSON } from '../../src/units.ts'
import { action, mutation, onChange, query, schedule, v } from '../../packages/units/src/index.ts'
import { FakeServer, type FakeConn } from '../helpers/fake-server.ts'
import { KeyedServer } from '../helpers/keyed-server.ts'

type Req<T extends number> = Extract<Msg, { type: T }>
const returned = (reqId: number, o: Partial<Req<typeof MsgType.Returned>> = {}): Msg => ({
  type: MsgType.Returned, reqId, ok: true, value: 'null', replayed: false, errCode: '', errMessage: '', errData: '', ...o,
})

let open: Database<any>[] = []
async function client<M = unknown>(server: FakeServer, o: Partial<ConnectOptions> = {}): Promise<Database<M>> {
  const db = await connect<M>({
    database: 'shop', allowPlaintext: true, apiKey: 'k', transport: server.transport, reconnectMinMs: 1, reconnectMaxMs: 5, onError: () => {}, ...o,
  })
  open.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(open.map((d) => d.close()))
  open = []
})

/** Answers Call with its arguments echoed under "args", and UnitAdmin with {op, body}. */
function echo(m: Msg, c: FakeConn): void {
  if (m.type === MsgType.Call) c.send(returned(m.reqId, { value: `{"unit":${JSON.stringify(m.unit)},"args":${m.args || 'null'}}` }))
  else if (m.type === MsgType.UnitAdmin) c.send({ type: MsgType.UnitAdminResult, reqId: m.reqId, body: JSON.stringify({ op: m.op, body: JSON.parse(m.body) }) })
}

describe('JSON with blobs', () => {
  test('Uint8Array travels as {"$bytes": base64} both ways', () => {
    expect(encodeUnitJSON({ a: Uint8Array.of(0, 1, 255), n: 5n, list: [new Uint8Array(0)] })).toBe('{"a":{"$bytes":"AAH/"},"n":5,"list":[{"$bytes":""}]}')
    expect(encodeUnitJSON(Buffer.from('hi'))).toBe('{"$bytes":"aGk="}') // not Buffer's own toJSON
    expect(encodeUnitJSON(new Uint16Array([1]).buffer)).toBe('{"$bytes":"AQA="}')
    expect(encodeUnitJSON(undefined)).toBe('')
    expect(encodeUnitJSON(null)).toBe('null')
    expect(() => encodeUnitJSON(() => 1)).toThrow(/cannot be sent/)
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    expect(decodeUnitJSON(encodeUnitJSON({ big }))).toEqual({ big })
    expect(decodeUnitJSON('{"x":{"$bytes":"AAH/"},"y":[{"$bytes":""}],"z":{"$bytes":1},"w":{"$bytes":"","other":1}}')).toEqual({
      x: Uint8Array.of(0, 1, 255), y: [new Uint8Array(0)], z: { $bytes: 1 }, w: { $bytes: '', other: 1 },
    })
    expect(decodeUnitJSON('')).toBeUndefined()
  })
})

describe('calls', () => {
  test('db.call sends Call with JSON arguments and a mutation id, and returns the result', async () => {
    const s = new FakeServer()
    s.onMessage = echo
    const db = await client(s)
    expect(await db.call('checkout', { cartId: 'c1', blob: Uint8Array.of(1, 2) })).toEqual({ unit: 'checkout', args: { cartId: 'c1', blob: Uint8Array.of(1, 2) } })
    const sent = s.last.received.find((m) => m.type === MsgType.Call) as Req<typeof MsgType.Call>
    expect(sent).toMatchObject({ unit: 'checkout', args: '{"cartId":"c1","blob":{"$bytes":"AQI="}}' })
    expect(sent.mutationId).toMatch(/^m-[0-9a-f]{32}$/)
    expect(await db.call('ping')).toEqual({ unit: 'ping', args: null })
    expect((s.last.received.at(-1) as Req<typeof MsgType.Call>).args).toBe('') // no arguments
    await db.call('pay', {}, { mutationId: 'order-7' })
    expect(s.last.received.at(-1)).toMatchObject({ unit: 'pay', args: '{}', mutationId: 'order-7' })
    const ids = s.last.received.filter((m) => m.type === MsgType.Call).map((m) => (m as Req<typeof MsgType.Call>).mutationId)
    expect(new Set(ids).size).toBe(3) // fresh per call

    // db.units is the same call; functions keep their identity; it is not a thenable.
    expect(await db.units['checkout']!({ cartId: 'c2' })).toEqual({ unit: 'checkout', args: { cartId: 'c2' } })
    expect(db.units['checkout']).toBe(db.units['checkout'])
    expect((db.units as Record<string, unknown>)['then']).toBeUndefined()
    await expect(db.call('', {})).rejects.toThrow(/empty unit name/)
    await expect(db.call('x', { f: () => 1, b: 1n << 70n, c: { toJSON: () => { throw new Error('nope') } } })).rejects.toThrow(/unit x: arguments: nope/)
  })

  test('a lost connection resends the call with the same mutation id', async () => {
    const s = new FakeServer()
    const seen: string[] = []
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.Call) return
      seen.push(m.mutationId)
      if (seen.length === 1) c.drop()
      else c.send(returned(m.reqId, { value: '{"orderId":7}', replayed: true }))
    }
    const db = await client(s)
    expect(await db.call('checkout', { cartId: 'c1' })).toEqual({ orderId: 7 })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    expect(s.accepted).toBe(2)
  })

  test('a unit that threw rejects with UnitError; failures around it with AzoraError', async () => {
    const s = new FakeServer()
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.Call) return
      if (m.unit === 'nope') c.send({ type: MsgType.Error, reqId: m.reqId, code: 'not_found', message: 'no unit nope', fatal: false, retryAfterMs: 0 })
      else if (m.unit === 'plain') c.send(returned(m.reqId, { ok: false, value: '', errCode: 'failed', errMessage: 'boom' }))
      else c.send(returned(m.reqId, { ok: false, value: '', errCode: 'not_found', errMessage: 'no such cart', errData: '{"cart":"c1","raw":{"$bytes":"AQ=="}}' }))
    }
    const db = await client(s)
    const e = await db.call('checkout', { cartId: 'c1' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UnitError)
    expect(e).toMatchObject({ name: 'UnitError', unit: 'checkout', code: 'not_found', message: 'no such cart', data: { cart: 'c1', raw: Uint8Array.of(1) } })
    const plain = await db.call('plain').catch((x: unknown) => x)
    expect(plain).toMatchObject({ code: 'failed', message: 'boom', data: undefined })
    const missing = await db.call('nope').catch((x: unknown) => x)
    expect(missing).toBeInstanceOf(AzoraError)
    expect(missing).toMatchObject({ code: 'not_found' })
  })
})

describe('unit admin', () => {
  test('operations and their JSON shapes', async () => {
    const s = new FakeServer()
    const answers: Record<string, unknown> = {
      deploy: { version: 2, sha256: 'ab', unchanged: false, dry_run: true, units: [{ name: 'checkout', kind: 'mutation', internal: false, description: '', args: null }] },
      deploys: { active: 2, deploys: [{ version: 2, at: 1, by: 'key:app', note: 'n', sha256: 'ab', size: 10, units: 1, active: true }] },
      runs: { runs: [{ id: 9, at: 1, unit: 'checkout', kind: 'mutation', trigger: 'call', principal: 'key:app', duration_ms: 4.25, status: 'ok', error: '', logs: '' }] },
      triggers: { triggers: [{ unit: 'nightly', kind: 'schedule', spec: '0 3 * * *', mode: 'mutation', next_at: 5, last_at: 4, cursor: 0, failures: 0, error: '', lagged: false }] },
      'triggers.skip': { skipped: 12 },
      'secrets.list': { secrets: [{ name: 'K', updated_at: 3 }] },
      'secrets.unset': { removed: true },
      'secrets.set': {},
      activate: { version: 1, units: [] },
      list: { version: 0, units: [] },
      call: { ok: true, value: { blob: { $bytes: 'AQ==' } } },
      jobs: { jobs: [
        { id: 'job_a', unit: 'remind', args: { cartId: 'c1', b: { $bytes: 'AQ==' } }, run_at: 9, created_at: 2, created_by: 'user:42', source: 'checkout', attempts: 0, state: 'pending' },
        { id: 'job_b', unit: 'tick', args: null, run_at: 8, created_at: 1, created_by: 'system', source: 'stats', attempts: 5, state: 'failed', error: 'failed: boom' },
      ], pending: 1, failed: 1 },
      'jobs.cancel': { removed: true },
      'jobs.retry': {},
    }
    const bodies: Array<[string, unknown]> = []
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.UnitAdmin) return
      bodies.push([m.op, JSON.parse(m.body)])
      c.send({ type: MsgType.UnitAdminResult, reqId: m.reqId, body: JSON.stringify(answers[m.op]) })
    }
    const a = (await client(s)).unitsAdmin
    expect(await a.deploy({ bundle: 'B', sourceMap: 'M', note: 'n', dryRun: true })).toMatchObject({ version: 2, dryRun: true, units: [{ name: 'checkout' }] })
    expect(bodies.at(-1)).toEqual(['deploy', { bundle: 'B', source_map: 'M', note: 'n', dry_run: true }])
    await a.deploy({ bundle: 'B' })
    expect(bodies.at(-1)).toEqual(['deploy', { bundle: 'B' }])
    expect(await a.list()).toEqual({ version: 0, units: [] })
    expect(await a.deploys({ limit: 5 })).toEqual({ active: 2, deploys: [{ version: 2, at: 1, by: 'key:app', note: 'n', sha256: 'ab', size: 10, units: 1, active: true }] })
    expect(bodies.at(-1)).toEqual(['deploys', { limit: 5 }])
    expect(await a.activate(1)).toEqual({ version: 1, units: [] })
    expect(bodies.at(-1)).toEqual(['activate', { version: 1 }])
    expect(await a.runs({ unit: 'checkout', limit: 1, before: 10 })).toEqual([
      { id: 9, at: 1, unit: 'checkout', kind: 'mutation', trigger: 'call', principal: 'key:app', durationMs: 4.25, status: 'ok', error: '', logs: '' },
    ])
    expect(bodies.at(-1)).toEqual(['runs', { unit: 'checkout', limit: 1, before: 10 }])
    expect((await a.triggers())[0]).toMatchObject({ unit: 'nightly', nextAt: 5, lastAt: 4, lagged: false })
    expect(await a.skipTrigger('paid')).toBe(12)
    expect(bodies.at(-1)).toEqual(['triggers.skip', { unit: 'paid' }])
    expect(await a.secrets.list()).toEqual([{ name: 'K', updatedAt: 3 }])
    await a.secrets.set('K', 'v')
    expect(bodies.at(-1)).toEqual(['secrets.set', { name: 'K', value: 'v' }])
    expect(await a.secrets.unset('K')).toBe(true)
    expect(await a.call('audit', { b: Uint8Array.of(1) })).toEqual({ blob: Uint8Array.of(1) })
    expect(bodies.at(-1)).toEqual(['call', { unit: 'audit', args: { b: { $bytes: 'AQ==' } } }])
    answers['call'] = { ok: false, value: null, error: { code: 'conflict', message: 'taken', data: { id: 1 } } }
    await expect(a.call('audit')).rejects.toMatchObject({ name: 'UnitError', unit: 'audit', code: 'conflict', message: 'taken', data: { id: 1 } })
    expect(bodies.at(-1)).toEqual(['call', { unit: 'audit' }])
    expect(await a.jobs.list({ state: 'pending', unit: 'remind', limit: 5 })).toEqual({
      jobs: [
        { id: 'job_a', unit: 'remind', args: { cartId: 'c1', b: Uint8Array.of(1) }, runAt: 9, createdAt: 2, createdBy: 'user:42', source: 'checkout', attempts: 0, state: 'pending', error: '' },
        { id: 'job_b', unit: 'tick', args: undefined, runAt: 8, createdAt: 1, createdBy: 'system', source: 'stats', attempts: 5, state: 'failed', error: 'failed: boom' },
      ],
      pending: 1,
      failed: 1,
    })
    expect(bodies.at(-1)).toEqual(['jobs', { state: 'pending', unit: 'remind', limit: 5 }])
    await a.jobs.list()
    expect(bodies.at(-1)).toEqual(['jobs', {}])
    expect(await a.jobs.cancel('job_a')).toBe(true)
    expect(bodies.at(-1)).toEqual(['jobs.cancel', { id: 'job_a' }])
    await a.jobs.retry('job_b')
    expect(bodies.at(-1)).toEqual(['jobs.retry', { id: 'job_b' }])
    await a.runs({ status: 'rejected' })
    expect(bodies.at(-1)).toEqual(['runs', { status: 'rejected' }])
  })

  test('reads are retried after a lost connection; changes are not', async () => {
    const s = new FakeServer()
    let drops = 0
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.UnitAdmin) return
      if (drops++ % 2 === 0) return c.drop() // every first attempt is lost
      c.send({ type: MsgType.UnitAdminResult, reqId: m.reqId, body: '{"version":3,"units":[]}' })
    }
    const db = await client(s)
    expect(await db.unitsAdmin.list()).toEqual({ version: 3, units: [] })
    for (const run of [
      () => db.unitsAdmin.deploy({ bundle: 'x' }),
      () => db.unitsAdmin.activate(2),
      () => db.unitsAdmin.secrets.set('A', 'b'),
      () => db.unitsAdmin.secrets.unset('A'),
      () => db.unitsAdmin.skipTrigger('paid'),
      () => db.unitsAdmin.call('audit'),
    ]) {
      drops = 0
      await expect(run()).rejects.toBeInstanceOf(UnknownOutcomeError)
    }
  })
})

describe('feature check', () => {
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

  test('a server whose discovery document lacks "units" is not sent units messages', async () => {
    const server = new KeyedServer()
    const old = await connect('https://db.example.com/shop', { token: 'k', transport: server.transport, fetch: (async () => json(server.document())) as typeof fetch })
    open.push(old)
    const err = await old.call('checkout', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AzoraError)
    expect((err as Error).message).toBe('unavailable: this server does not support units (its /.well-known/azora.json does not list "units" in features)')
    await expect(old.unitsAdmin.list()).rejects.toThrow(/does not support units/)

    const doc = { ...server.document(), features: ['units'] }
    const current = await connect('https://db.example.com/shop', { token: 'k', transport: server.transport, fetch: (async () => json(doc)) as typeof fetch })
    open.push(current)
    expect(await current.call('echo', { a: 1 })).toEqual({ a: 1 })

    // With a pinned key there is no document: the server answers for itself.
    const s = new FakeServer()
    s.onMessage = echo
    expect(await (await client(s)).call('x')).toEqual({ unit: 'x', args: null })
  })
})

// Types: db.units from a units module.
const units = {
  checkout: mutation({ args: { cartId: v.string(), qty: v.optional(v.int()) }, handler: () => ({ orderId: 1 }) }),
  myOrders: query({ handler: async () => [{ id: 1, total: 2.5 }] }),
  thumbnail: action({ args: v.bytes(), handler: (_ctx, b) => b }),
  audit: mutation({ internal: true, args: { what: v.string() }, handler: () => {} }),
  nightly: schedule({ cron: '0 3 * * *', handler: () => {} }),
  paid: onChange({ table: 'orders', handler: () => {} }),
  TAX: 0.2,
}
type Shop = typeof units

describe('types', () => {
  test('db.units is typed from the units module', () => {
    type U = Database<Shop>['units']
    expectTypeOf<keyof UnitsOf<Shop>>().toEqualTypeOf<'checkout' | 'myOrders' | 'thumbnail'>()
    expectTypeOf<U['checkout']>().parameter(0).toEqualTypeOf<{ cartId: string; qty?: number | undefined }>()
    expectTypeOf<U['checkout']>().returns.toEqualTypeOf<Promise<{ orderId: number }>>()
    expectTypeOf<U['myOrders']>().returns.toEqualTypeOf<Promise<{ id: number; total: number }[]>>()
    expectTypeOf<U['thumbnail']>().returns.toEqualTypeOf<Promise<Uint8Array>>()
    expectTypeOf<UnitArgs<Shop, 'checkout'>>().toEqualTypeOf<{ cartId: string; qty?: number | undefined }>()
    expectTypeOf<UnitResult<Shop, 'myOrders'>>().toEqualTypeOf<{ id: number; total: number }[]>()
    const typed = (db: Database<Shop>): void => {
      void db.units.checkout({ cartId: 'c1' }, { mutationId: 'm1' })
      void db.units.myOrders() // no arguments needed
      // @ts-expect-error cartId must be a string
      void db.units.checkout({ cartId: 1 })
      // @ts-expect-error the arguments are required
      void db.units.checkout()
      // @ts-expect-error internal units are not on db.units
      void db.units.audit
      // @ts-expect-error nor schedules and onChange
      void db.units.nightly
      // db.call takes any name
      void db.call<number>('anything', { x: 1 })
    }
    expectTypeOf(typed).toBeFunction()
  })

  test('without a module type everything stays as it was, and typed databases fit where a Database is expected', () => {
    expectTypeOf<Database['call']>().returns.toEqualTypeOf<Promise<unknown>>()
    expectTypeOf<Database['units']['anything']>().toEqualTypeOf<(args?: any, opts?: UnitCallOptions) => Promise<unknown>>()
    const take = (db: Database): Database => db
    expectTypeOf(take).toBeCallableWith(null as unknown as Database<Shop>)
    expectTypeOf(connect<Shop>).returns.toEqualTypeOf<Promise<Database<Shop>>>()
    expectTypeOf(connect).returns.toEqualTypeOf<Promise<Database>>()
  })
})
