/**
 * Units against a real engine: publishing, calls with an API key and with
 * a restricted client token, exactly-once mutations, errors, the admin
 * operations, onChange, and the CLI. Skipped when there is no engine
 * binary; the tests that need units are skipped when the engine's
 * discovery document does not list "units" in its features.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { AzoraError, connect, isCode, UnitError, type Database } from '../../src/index.ts'
import { publishUnits } from '../../packages/units/src/publish.ts'
import { main } from '../../packages/units/src/main.ts'
import { DEFAULT_SCHEMA, engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

type Units = typeof import('../fixtures/units/index.ts')
const dir = new URL('../fixtures/units', import.meta.url).pathname

describe.skipIf(!engineBinary())('units', () => {
  let engine: Engine
  let supported = false
  let db: Database<Units>
  let customer: Database<Units>
  let reader: Database<Units>

  beforeAll(async () => {
    engine = await startEngine({
      schema: [
        ...DEFAULT_SCHEMA,
        'CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER NOT NULL, total REAL NOT NULL, note TEXT)',
        'CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)',
        'CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
      ],
      tokens: { customer42: ['--sub', 'user:42', '--scope', 'read', '--ttl', '1h', '--table', 'orders', '--filter', 'orders: customer = 42'] },
    })
    const doc = (await (await fetch(`${engine.httpUrl}/.well-known/azora.json`)).json()) as { features?: unknown }
    supported = Array.isArray(doc.features) && doc.features.includes('units')
    if (!supported) return
    const url = `${engine.connectUrl}?key=${engine.serverKey}`
    db = await connect<Units>(url, { token: engine.apiKey })
    customer = await connect<Units>(url, { token: engine.tokens['customer42']! })
    reader = await connect<Units>(url, { token: engine.readKey })
  })
  afterAll(async () => {
    await Promise.all([db?.close(), customer?.close(), reader?.close()])
    await engine?.stop()
  })

  /** A test that needs an engine with units. */
  const it = (name: string, fn: () => Promise<void>, timeout?: number): void => {
    test(name, async (ctx) => {
      if (!supported) ctx.skip()
      await fn()
    }, timeout)
  }

  test('without units, a connection that read the discovery document refuses calls clearly', async (ctx) => {
    if (supported) ctx.skip()
    const old = await connect(engine.connectUrl, { token: engine.apiKey }) // loopback: the key comes from discovery
    try {
      await expect(old.call('checkout', { cartId: 'c1' })).rejects.toThrow('unavailable: this server does not support units')
    } finally {
      await old.close()
    }
  })

  it('publishing makes a version; the same bundle again does not', async () => {
    const dry = await publishUnits(db, dir, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect((await db.unitsAdmin.list()).version).toBe(0) // a dry run publishes nothing
    const first = await publishUnits(db, dir, { note: 'first' })
    expect(first).toMatchObject({ unchanged: false, dryRun: false })
    expect(first.version).toBeGreaterThan(0)
    const names = first.units.map((u) => u.name).sort()
    expect(names).toEqual(['audit', 'bump', 'boom', 'cartReminder', 'checkout', 'echo', 'hasSecret', 'myOrders', 'orderPlaced', 'refuse', 'remindCart', 'stats', 'whoami'].sort())
    expect(first.units.find((u) => u.name === 'checkout')).toMatchObject({
      kind: 'mutation', internal: false, args: { type: 'object', properties: { cartId: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['cartId'] },
    })
    expect(first.units.find((u) => u.name === 'stats')).toMatchObject({ kind: 'schedule', internal: true, every: '1m', mode: 'mutation' })
    expect(first.units.find((u) => u.name === 'orderPlaced')).toMatchObject({ kind: 'onChange', table: 'orders', ops: ['insert'] })
    const again = await publishUnits(db, dir)
    expect(again).toMatchObject({ unchanged: true, version: first.version })
    const list = await db.unitsAdmin.list()
    expect(list.version).toBe(first.version)
    const history = await db.unitsAdmin.deploys()
    expect(history.active).toBe(first.version)
    expect(history.deploys[0]).toMatchObject({ version: first.version, note: 'first' })
  })

  it('calls: results, blobs, typed db.units, the caller in ctx.auth', async () => {
    expect(await db.call('echo', { a: [1, 'x', null], b: Uint8Array.of(0, 255) })).toEqual({ a: [1, 'x', null], b: Uint8Array.of(0, 255) })
    expect(await db.units.whoami()).toMatchObject({ kind: 'key', principal: 'key:app', subject: '', unit: 'whoami', trigger: 'call' })
    expect(await customer.units.whoami()).toMatchObject({ kind: 'token', subject: 'user:42' })
  })

  it('a token that cannot run SQL can call units, which decide from ctx.auth', async () => {
    await expect(customer.query('SELECT * FROM carts')).rejects.toSatisfy((e) => isCode(e, 'permission_denied'))
    await db.batch([
      ["INSERT INTO carts(id, customer, total, note) VALUES ('k42', 42, 20, 'mine')"],
      ["INSERT INTO carts(id, customer, total, note) VALUES ('k7', 7, 5, 'theirs')"],
    ])
    const { orderId, total } = await customer.units.checkout({ cartId: 'k42' })
    expect(total).toBe(20)
    expect(await db.queryOne('SELECT customer, status, total FROM orders WHERE id = ?', [orderId])).toEqual({ customer: 42, status: 'open', total: 20 })
    expect(await db.queryValue("SELECT count(*) FROM carts WHERE id = 'k42'")).toBe(0)
    await expect(customer.units.checkout({ cartId: 'k7' })).rejects.toMatchObject({ name: 'UnitError', code: 'permission_denied' })
    await expect(customer.units.checkout({ cartId: 'k404' })).rejects.toMatchObject({ code: 'not_found', data: { cartId: 'k404' } })
    const mine = await customer.units.myOrders()
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((o) => o.customer === 42)).toBe(true)
    await expect(db.units.myOrders()).rejects.toMatchObject({ code: 'permission_denied' }) // the API key is no customer
    // The checkout's audit line (ctx.run of an internal unit) committed with it.
    expect(await db.queryValue("SELECT count(*) FROM audit WHERE what = 'checkout' AND detail LIKE 'cart k42 %'")).toBe(1)
  })

  it('a mutation runs exactly once per mutation id, and rolls back when it throws', async () => {
    const a = await db.call<{ n: number; mutationId: string }>('bump', { by: 5 }, { mutationId: 'bump-1' })
    const b = await db.call<{ n: number; mutationId: string }>('bump', { by: 5 }, { mutationId: 'bump-1' })
    expect(b).toEqual(a)
    expect(a.mutationId).toBe('bump-1')
    expect(await db.queryValue('SELECT n FROM counter WHERE id = 1')).toBe(a.n)
    const c = await db.units.bump({ by: 1 }) // a fresh id
    expect(c.n).toBe(a.n + 1)
    expect(c.mutationId).toMatch(/^m-/)
    await expect(db.call('boom')).rejects.toMatchObject({ name: 'UnitError', code: 'failed', message: expect.stringContaining('boom') })
    expect(await db.queryValue('SELECT count(*) FROM counter WHERE id = 99')).toBe(0)
  })

  it('errors: thrown UnitError, no such unit, internal units, arguments that do not match', async () => {
    const e = await db.call('refuse').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UnitError)
    expect(e).toMatchObject({ unit: 'refuse', code: 'conflict', message: 'already paid', data: { order: 7 } })
    await expect(db.call('nope')).rejects.toSatisfy((x) => x instanceof AzoraError && x.code === 'not_found')
    await expect(db.call('audit', { what: 'x' })).rejects.toSatisfy((x) => x instanceof AzoraError && x.code === 'permission_denied')
    await expect(db.call('checkout', { cartId: 1 })).rejects.toSatisfy((x) => x instanceof AzoraError && x.code === 'invalid')
    await expect(db.call('checkout', { cartId: 'a', extra: true })).rejects.toSatisfy((x) => isCode(x, 'invalid'))
    await expect(db.call('bump', { by: 0 })).rejects.toSatisfy((x) => isCode(x, 'invalid'))
  })

  it('onChange: every new order gets an audit line', async () => {
    const audited = async (id: number | bigint): Promise<boolean> =>
      (await db.queryValue<number>("SELECT count(*) FROM audit WHERE what = 'order placed' AND detail LIKE ?", [`order ${id} %`])) === 1
    const first = await db.exec("INSERT INTO orders(customer, status, total) VALUES (3, 'open', 1)")
    await new Promise((r) => setTimeout(r, 500))
    const second = await db.exec("INSERT INTO orders(customer, status, total) VALUES (3, 'open', 2)")
    await until(() => audited(second.lastInsertId), 'the onChange run for the second order')
    const runs = await db.unitsAdmin.runs({ unit: 'orderPlaced' })
    expect(runs[0]).toMatchObject({ unit: 'orderPlaced', kind: 'onChange', trigger: 'change', principal: 'system', status: 'ok' })
    expect((await db.unitsAdmin.triggers()).map((t) => t.unit).sort()).toEqual(['orderPlaced', 'stats'])
    // Every change exactly once: the first order too, and the orders the checkout unit wrote earlier.
    expect(await audited(first.lastInsertId), 'the first order after the deploy').toBe(true)
    expect(await db.queryValue("SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM audit a WHERE a.what = 'order placed' AND a.detail LIKE 'order ' || o.id || ' %')")).toBe(0)
  })

  it('admin: runs, secrets, admin calls, rollback, and the ddl scope', async () => {
    const runs = await db.unitsAdmin.runs({ unit: 'refuse', limit: 5 })
    expect(runs[0]).toMatchObject({ unit: 'refuse', status: 'error', trigger: 'call' })
    await db.unitsAdmin.secrets.set('PAYMENT_KEY', 'sk_test')
    expect((await db.unitsAdmin.secrets.list()).map((s) => s.name)).toContain('PAYMENT_KEY')
    expect(await db.units.hasSecret({ name: 'PAYMENT_KEY' })).toBe(true)
    expect(await db.unitsAdmin.secrets.unset('PAYMENT_KEY')).toBe(true)
    expect(await db.units.hasSecret({ name: 'PAYMENT_KEY' })).toBe(false)
    // Admin calls may run internal units.
    await db.unitsAdmin.call('audit', { what: 'admin call' })
    expect(await db.queryValue("SELECT count(*) FROM audit WHERE what = 'admin call'")).toBe(1)
    await expect(db.unitsAdmin.call('refuse')).rejects.toMatchObject({ name: 'UnitError', code: 'conflict' })
    // Without ddl, no admin.
    await expect(reader.unitsAdmin.list()).rejects.toSatisfy((x) => isCode(x, 'permission_denied'))
    await expect(customer.unitsAdmin.list()).rejects.toSatisfy((x) => isCode(x, 'permission_denied'))
    // A second deploy, then a rollback to the first.
    const before = (await db.unitsAdmin.list()).version
    await expect(db.unitsAdmin.deploy({ bundle: 'globalThis.__azora_units = {}' })).rejects.toSatisfy((x) => isCode(x, 'invalid')) // no units
    const only = 'globalThis.__azora_units = { one: { "~azora": 1, kind: "query", handler: function () { return 1 }, args: null, internal: false, description: "" } }'
    const smaller = await db.unitsAdmin.deploy({ bundle: only, note: 'one unit' })
    expect(smaller.version).toBeGreaterThan(before)
    expect(smaller.units.map((u) => u.name)).toEqual(['one'])
    await expect(db.call('echo', 1)).rejects.toSatisfy((x) => isCode(x, 'not_found'))
    const back = await db.unitsAdmin.activate(before)
    expect(back.version).toBe(before)
    expect(await db.call('echo', 1)).toBe(1)
  })

  it('the CLI publishes, lists and calls with AZORA_URL and AZORA_TOKEN', async () => {
    const lines: string[] = []
    const errors: string[] = []
    const io = { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l), readSecret: async () => '' }
    const prev = { url: process.env['AZORA_URL'], token: process.env['AZORA_TOKEN'] }
    process.env['AZORA_URL'] = `${engine.connectUrl}?key=${engine.serverKey}`
    process.env['AZORA_TOKEN'] = engine.apiKey
    try {
      expect(await main(['publish', dir, '--dry-run'], io)).toBe(0)
      expect(lines[0]).toMatch(/^Dry run: the bundle .* is valid/)
      expect(await main(['list', '--json'], io)).toBe(0)
      expect(await main(['call', 'echo', '{"x":[1,2]}'], io)).toBe(0)
      expect(lines.at(-1)).toBe('{\n  "x": [\n    1,\n    2\n  ]\n}')
      process.env['AZORA_TOKEN'] = engine.readKey
      expect(await main(['list'], io)).toBe(1)
      expect(errors.at(-1)).toMatch(/ddl/)
    } finally {
      process.env['AZORA_URL'] = prev.url
      process.env['AZORA_TOKEN'] = prev.token
      if (prev.url === undefined) delete process.env['AZORA_URL']
      if (prev.token === undefined) delete process.env['AZORA_TOKEN']
    }
  })
})
