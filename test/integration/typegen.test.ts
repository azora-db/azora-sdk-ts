import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connect, type Database } from '../../src/index.ts'
import { generateTypes, readSchema } from '../../src/typegen.ts'
import { main, type IO } from '../../src/typegen-cli.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'

const SCHEMA = [
  "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', total REAL NOT NULL, paid BOOLEAN NOT NULL DEFAULT 0, meta JSON, note TEXT, photo BLOB, price NUMERIC, anything, total_cents INTEGER GENERATED ALWAYS AS (CAST(total * 100 AS INTEGER)) VIRTUAL)",
  'CREATE TABLE order_items(order_id INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(order_id, sku)) WITHOUT ROWID',
  'CREATE TABLE kv(k TEXT PRIMARY KEY, v BLOB)',
  'CREATE TABLE "odd name"("first name" TEXT, "2nd" BOOL)',
  'CREATE VIEW open_orders AS SELECT id, status, total * 2 AS doubled FROM orders WHERE status = \'open\'',
  'ANALYZE', // makes sqlite_stat1, which is not an application table
]

describe.skipIf(!engineBinary())('row types from the schema', () => {
  let engine: Engine
  let db: Database
  let text: string

  beforeAll(async () => {
    engine = await startEngine({ schema: SCHEMA, publish: ['orders', 'files'] })
    // A read-only key is enough to read the schema.
    db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.readKey })
    text = generateTypes(await readSchema(db))
  })
  afterAll(async () => {
    await db?.close()
    await engine?.stop()
  })

  test('readSchema reads tables, views and columns, without internal tables', async () => {
    const schema = await readSchema(db)
    expect(schema.tables.map((t) => `${t.kind} ${t.name}`)).toEqual(['table orders', 'table order_items', 'table kv', 'table odd name', 'view open_orders'])
    expect(schema.tables[0]?.columns).toEqual([
      { name: 'id', type: 'INTEGER', notNull: false, pk: 1, hasDefault: false, generated: false },
      { name: 'customer', type: 'INTEGER', notNull: true, pk: 0, hasDefault: false, generated: false },
      { name: 'status', type: 'TEXT', notNull: true, pk: 0, hasDefault: true, generated: false },
      { name: 'total', type: 'REAL', notNull: true, pk: 0, hasDefault: false, generated: false },
      { name: 'paid', type: 'BOOLEAN', notNull: true, pk: 0, hasDefault: true, generated: false },
      { name: 'meta', type: 'JSON', notNull: false, pk: 0, hasDefault: false, generated: false },
      { name: 'note', type: 'TEXT', notNull: false, pk: 0, hasDefault: false, generated: false },
      { name: 'photo', type: 'BLOB', notNull: false, pk: 0, hasDefault: false, generated: false },
      { name: 'price', type: 'NUMERIC', notNull: false, pk: 0, hasDefault: false, generated: false },
      { name: 'anything', type: '', notNull: false, pk: 0, hasDefault: false, generated: false },
      { name: 'total_cents', type: 'INTEGER', notNull: false, pk: 0, hasDefault: false, generated: true },
    ])
    expect((await readSchema(db, { tables: ['kv'] })).tables.map((t) => t.name)).toEqual(['kv'])
    await expect(readSchema(db, { tables: ['nowhere'] })).rejects.toThrow('no table or view named "nowhere"')
  })

  test('generateTypes gives the row, insert and Tables types', () => {
    expect(text).toContain(`export interface Orders {
  id: number
  customer: number
  status: string
  total: number
  paid: number
  meta: unknown
  note: string | null
  photo: Uint8Array | null
  price: number | string | null
  anything: unknown
  total_cents: number | null
}`)
    expect(text).toContain(`export interface NewOrders {
  id?: number
  customer: number
  status?: string
  total: number
  paid?: number
  meta?: unknown
  note?: string | null
  photo?: Uint8Array | null
  price?: number | string | null
  anything?: unknown
}`)
    expect(text).toContain(`export interface OrderItems {
  order_id: number
  sku: string
  qty: number
}`)
    expect(text).toContain(`export interface NewOrderItems {
  order_id: number
  sku: string
  qty?: number
}`)
    expect(text).toContain(`export interface Kv {
  k: string | null
  v: Uint8Array | null
}`)
    expect(text).toContain(`export interface OddName {
  "first name": string | null
  "2nd": number | null
}`)
    expect(text).toContain(`export interface OpenOrders {
  id: number | null
  status: string | null
  doubled: unknown
}`)
    expect(text).not.toContain('NewOpenOrders')
    expect(text).toContain(`export interface Tables {
  orders: Orders
  order_items: OrderItems
  kv: Kv
  "odd name": OddName
  open_orders: OpenOrders
}`)
  })

  test('the types describe what queries return', async () => {
    const admin = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    try {
      await admin.exec("INSERT INTO orders(customer, total, paid, meta, photo, price) VALUES (7, 12.5, 1, '{\"a\":1}', x'0102', 9.99)")
      await admin.exec('INSERT INTO "odd name" VALUES (\'Ada\', 1)')
    } finally {
      await admin.close()
    }
    expect(await db.queryOne('SELECT * FROM orders')).toEqual({
      id: 1, customer: 7, status: 'open', total: 12.5, paid: 1, meta: '{"a":1}', note: null, photo: Uint8Array.of(1, 2), price: 9.99, anything: null, total_cents: 1250,
    })
    // BOOLEAN comes back as a boolean, BOOL as the stored integer.
    expect(await db.queryOne('SELECT * FROM "odd name"')).toEqual({ 'first name': 'Ada', '2nd': 1 })
  })

  test('the generated file type-checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azora-gen-'))
    writeFileSync(join(dir, 'azora-types.ts'), text)
    writeFileSync(
      join(dir, 'use.ts'),
      `import type { NewOrders, OpenOrders, Orders, Tables } from './azora-types.ts'
const o: Orders = { id: 1, customer: 7, status: 'open', total: 1, paid: 0, meta: { a: 1 }, note: null, photo: null, price: '9.99', anything: 1, total_cents: 100 }
const n: NewOrders = { customer: 7, total: 1 }
const t: Tables['open_orders'] = { id: null, status: 'open', doubled: 2 } satisfies OpenOrders
const odd: Tables['odd name'] = { 'first name': null, '2nd': 1 }
// @ts-expect-error a generated column is not inserted
const bad: NewOrders = { customer: 7, total: 1, total_cents: 5 }
// @ts-expect-error status is not nullable
o.status = null
export { bad, n, o, odd, t }
`,
    )
    const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
    const args = [tsc, '--noEmit', '--strict', '--exactOptionalPropertyTypes', '--allowImportingTsExtensions', '--module', 'nodenext', '--target', 'es2022', join(dir, 'use.ts')]
    try {
      execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      throw new Error(`tsc failed:\n${(e as { stdout?: string }).stdout}\n${text}`)
    }
  })

  test('the azora-gen command: write, check, and its errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azora-gen-'))
    const out = join(dir, 'types.ts')
    const run = async (...argv: string[]) => {
      let stdout = ''
      const err: string[] = []
      const io: IO = { out: (t) => (stdout += t), err: (l) => err.push(l) }
      const code = await main(['--env-file', join(dir, 'none.env'), ...argv], io)
      return { code, stdout, err: err.join('\n') }
    }
    const env = join(dir, 'none.env')
    writeFileSync(env, `AZORA_URL=${engine.tcpUrl}?key=${engine.serverKey}\n`)
    const token = ['--token', engine.readKey]

    expect(await run(...token, '--out', out)).toMatchObject({ code: 0, err: `azora-gen: wrote ${out} (5 tables)` })
    expect(readFileSync(out, 'utf8')).toBe(generateTypes(await readSchema(db), { command: `azora-gen --out ${out}` }))
    expect(await run(...token, '--out', out, '--check')).toMatchObject({ code: 0 })
    expect((await run(...token, '--tables', 'kv')).stdout).not.toContain('Orders')

    // The schema moves on: --check notices.
    const admin = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    try {
      await admin.exec('ALTER TABLE kv ADD COLUMN updated_at INTEGER')
    } finally {
      await admin.close()
    }
    expect(await run(...token, '--out', out, '--check')).toMatchObject({ code: 1, err: expect.stringContaining('out of date') })

    expect(await run(...token, '--tables', 'nowhere')).toMatchObject({ code: 1, err: 'azora-gen: no table or view named "nowhere" in the database' })
    expect(await run('--token', 'azk_wrong')).toMatchObject({ code: 1, stdout: '' })
    expect(await run()).toMatchObject({ code: 1, err: expect.stringContaining('no credential') })
    expect(await run(...token, '--url', 'azora://127.0.0.1:1/shop?key=' + engine.serverKey)).toMatchObject({ code: 1, err: expect.stringContaining('cannot reach the database') })
  })
})
