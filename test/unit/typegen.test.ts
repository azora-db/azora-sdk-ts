import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { columnKind, generateTypes, readSchema, typeName, TypegenError, type Schema, type TableSchema } from '../../src/typegen.ts'
import { main, settings, type IO, type SchemaSource } from '../../src/typegen-cli.ts'

const table = (name: string, columns: TableSchema['columns'], kind: TableSchema['kind'] = 'table'): TableSchema => ({ name, kind, columns })

/** The body of `export interface <name> { … }` in generated text, one property per entry. */
function body(text: string, name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n?\\}`).exec(text)
  if (!m) throw new Error(`no interface ${name} in:\n${text}`)
  return (m[1] ?? '').split('\n').filter((l) => l !== '').map((l) => l.trim())
}

describe('columnKind', () => {
  test.each([
    ['INTEGER', 'integer'], ['INT', 'integer'], ['bigint', 'integer'], ['UNSIGNED BIG INT', 'integer'], ['TINYINT(1)', 'integer'],
    ['REAL', 'real'], ['DOUBLE PRECISION', 'real'], ['float', 'real'],
    ['TEXT', 'text'], ['VARCHAR(255)', 'text'], ['NCHAR(5)', 'text'], ['CLOB', 'text'],
    ['BLOB', 'blob'], ['blob', 'blob'],
    ['BOOLEAN', 'integer'], [' boolean ', 'integer'], ['BOOL', 'integer'],
    ['JSON', 'json'], ['jsonb', 'json'],
    ['NUMERIC', 'numeric'], ['DECIMAL(10,2)', 'numeric'], ['DATETIME', 'numeric'], ['DATE', 'numeric'],
    ['', 'any'], ['  ', 'any'],
    // SQLite's order: INT wins over CHAR ("CHARINT"), and a POINT is an integer.
    ['CHARINT', 'integer'], ['POINT', 'integer'], ['FLOATING POINT', 'integer'],
  ])('%s -> %s', (declared, kind) => {
    expect(columnKind(declared)).toBe(kind)
  })
})

describe('typeName', () => {
  test.each([
    ['orders', 'Orders'], ['order_items', 'OrderItems'], ['OrderItems', 'OrderItems'], ['order-items v2', 'OrderItemsV2'],
    ['__x', 'X'], ['2fa_codes', '_2faCodes'], ['été', 'T'], ['---', 'Table'], ['userID', 'UserID'],
  ])('%s -> %s', (name, want) => {
    expect(typeName(name)).toBe(want)
  })
})

describe('generateTypes', () => {
  test('every column kind, nullable and not', () => {
    const kinds = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'BOOLEAN', 'BOOL', 'JSON', 'NUMERIC', '']
    const text = generateTypes({
      tables: [table('t', [...kinds.map((type, i) => ({ name: `a${i}`, type, notNull: true })), ...kinds.map((type, i) => ({ name: `b${i}`, type }))])],
    })
    expect(body(text, 'T')).toEqual([
      'a0: number', 'a1: number', 'a2: string', 'a3: Uint8Array', 'a4: number', 'a5: number', 'a6: unknown', 'a7: number | string', 'a8: unknown',
      'b0: number | null', 'b1: number | null', 'b2: string | null', 'b3: Uint8Array | null', 'b4: number | null', 'b5: number | null', 'b6: unknown',
      'b7: number | string | null', 'b8: unknown',
    ])
  })

  test('bigint option types integers number | bigint', () => {
    const text = generateTypes({ tables: [table('t', [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'n', type: 'BIGINT' }, { name: 'r', type: 'REAL', notNull: true }])] }, { bigint: true })
    expect(body(text, 'T')).toEqual(['id: number | bigint', 'n: number | bigint | null', 'r: number'])
    expect(text).toContain('// Integer columns are number | bigint')
  })

  test('primary keys: rowid alias, text key, composite key, WITHOUT ROWID', () => {
    const text = generateTypes({
      tables: [
        table('orders', [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'status', type: 'TEXT', notNull: true }]),
        // A TEXT PRIMARY KEY of an ordinary table accepts NULL.
        table('kv', [{ name: 'k', type: 'TEXT', pk: 1 }, { name: 'v', type: 'BLOB' }]),
        // INT is not INTEGER: no rowid alias.
        table('legacy', [{ name: 'id', type: 'INT', pk: 1 }]),
        // A composite key of an ordinary table: the INTEGER part is no alias either.
        table('pairs', [{ name: 'a', type: 'INTEGER', pk: 1 }, { name: 'b', type: 'INTEGER', pk: 2 }]),
        // WITHOUT ROWID: pragma_table_xinfo reports the key NOT NULL.
        table('items', [{ name: 'order_id', type: 'INTEGER', notNull: true, pk: 1 }, { name: 'sku', type: 'TEXT', notNull: true, pk: 2 }, { name: 'qty', type: 'INTEGER', notNull: true }]),
      ],
    })
    expect(body(text, 'Orders')).toEqual(['id: number', 'status: string'])
    expect(body(text, 'NewOrders')).toEqual(['id?: number', 'status: string'])
    expect(body(text, 'Kv')).toEqual(['k: string | null', 'v: Uint8Array | null'])
    expect(body(text, 'NewKv')).toEqual(['k?: string | null', 'v?: Uint8Array | null'])
    expect(body(text, 'Legacy')).toEqual(['id: number | null'])
    expect(body(text, 'Pairs')).toEqual(['a: number | null', 'b: number | null'])
    expect(body(text, 'Items')).toEqual(['order_id: number', 'sku: string', 'qty: number'])
    expect(body(text, 'NewItems')).toEqual(['order_id: number', 'sku: string', 'qty: number'])
  })

  test('insert types: defaults and nullable optional, generated left out', () => {
    const text = generateTypes({
      tables: [
        table('t', [
          { name: 'id', type: 'INTEGER', pk: 1 },
          { name: 'name', type: 'TEXT', notNull: true },
          { name: 'status', type: 'TEXT', notNull: true, hasDefault: true },
          { name: 'note', type: 'TEXT' },
          { name: 'total', type: 'REAL', generated: true },
          { name: 'doc', type: 'JSON', notNull: true },
        ]),
      ],
    })
    expect(body(text, 'T')).toEqual(['id: number', 'name: string', 'status: string', 'note: string | null', 'total: number | null', 'doc: unknown'])
    expect(body(text, 'NewT')).toEqual(['id?: number', 'name: string', 'status?: string', 'note?: string | null', 'doc: unknown'])
  })

  test('views get a row type and no insert type', () => {
    const text = generateTypes({ tables: [table('open_orders', [{ name: 'id', type: 'INTEGER' }, { name: 'n', type: '' }], 'view')] })
    expect(body(text, 'OpenOrders')).toEqual(['id: number | null', 'n: unknown'])
    expect(text).toContain('/** A row of the view `open_orders`. */')
    expect(text).not.toContain('NewOpenOrders')
    expect(body(text, 'Tables')).toEqual(['open_orders: OpenOrders'])
  })

  test('names: quoting, collisions and the reserved Tables', () => {
    const text = generateTypes({
      tables: [
        table('order_items', [{ name: 'first name', type: 'TEXT' }, { name: '2nd', type: 'TEXT' }, { name: 'a"b', type: 'TEXT' }, { name: '$ok_1', type: 'TEXT' }]),
        table('OrderItems', [{ name: 'x', type: 'TEXT' }]),
        table('new_order_items', [{ name: 'x', type: 'TEXT' }]),
        table('tables', [{ name: 'x', type: 'TEXT' }]),
        table('my-table */', [{ name: 'x', type: 'TEXT' }]),
      ],
    })
    expect(body(text, 'OrderItems')).toEqual(['"first name": string | null', '"2nd": string | null', '"a\\"b": string | null', '$ok_1: string | null'])
    expect(body(text, 'Tables')).toEqual([
      'order_items: OrderItems', 'OrderItems: OrderItems_2', 'new_order_items: NewOrderItems', 'tables: Tables_2', '"my-table */": MyTable',
    ])
    // The insert types give way to the table of the same name.
    expect(text).toContain('export interface NewOrderItems_2 {')
    expect(text).toContain('export interface NewOrderItems_2_2 {')
    expect(text).toContain('`my-table *\\/`')
    const names = [...text.matchAll(/export interface (\S+) /g)].map((m) => m[1])
    expect(new Set(names).size).toBe(names.length)
  })

  test('header, order and determinism', () => {
    const schema: Schema = {
      tables: [table('zebra', [{ name: 'z', type: 'TEXT' }, { name: 'a', type: 'TEXT' }]), table('apple', [{ name: 'id', type: 'INTEGER', pk: 1 }])],
    }
    const text = generateTypes(schema, { command: 'azora-gen --out src/azora-types.ts' })
    expect(text).toBe(generateTypes(structuredClone(schema), { command: 'azora-gen --out src/azora-types.ts' }))
    expect(text.split('\n').slice(0, 2)).toEqual([
      '// Generated by azora-gen from the database schema. Do not edit: changes are lost.',
      '// Regenerate with: azora-gen --out src/azora-types.ts',
    ])
    expect(text.indexOf('interface Zebra')).toBeLessThan(text.indexOf('interface Apple'))
    expect(body(text, 'Zebra')).toEqual(['z: string | null', 'a: string | null'])
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/) // no date: the same schema gives the same file
  })

  test('the whole file for a small schema', () => {
    const text = generateTypes({ tables: [table('orders', [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'note', type: 'TEXT' }])] }, { command: 'azora-gen' })
    expect(text).toBe(`// Generated by azora-gen from the database schema. Do not edit: changes are lost.
// Regenerate with: azora-gen
//
// Integer columns are typed number; the SDK returns a bigint for values beyond
// 2^53 - 1 (generate with --bigint when the database stores such values).

/** A row of the table \`orders\`. */
export interface Orders {
  id: number
  note: string | null
}

/** What an insert into \`orders\` takes. */
export interface NewOrders {
  id?: number
  note?: string | null
}

/** Every table and view, by name. */
export interface Tables {
  orders: Orders
}
`)
  })
})

describe('readSchema', () => {
  const rows = [
    { tbl: 'orders', kind: 'table', name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
    { tbl: 'orders', kind: 'table', name: 'status', type: 'TEXT', notnull: 1, dflt_value: "'open'", pk: 0, hidden: 0 },
    { tbl: 'orders', kind: 'table', name: 'double', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0, hidden: 2 },
    { tbl: 'sqlite_stat1', kind: 'table', name: 'tbl', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
    { tbl: 'azora_files', kind: 'table', name: 'key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
    { tbl: 'search', kind: 'table', name: 'body', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
    { tbl: 'search', kind: 'table', name: 'rank', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 1 },
    { tbl: 'v', kind: 'view', name: 'n', type: null, notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  ]
  const db = { query: async () => rows } as unknown as Parameters<typeof readSchema>[0]

  test('groups columns, skips internal tables and hidden columns', async () => {
    expect(await readSchema(db)).toEqual({
      tables: [
        {
          name: 'orders',
          kind: 'table',
          columns: [
            { name: 'id', type: 'INTEGER', notNull: false, pk: 1, hasDefault: false, generated: false },
            { name: 'status', type: 'TEXT', notNull: true, pk: 0, hasDefault: true, generated: false },
            { name: 'double', type: 'INTEGER', notNull: false, pk: 0, hasDefault: false, generated: true },
          ],
        },
        { name: 'search', kind: 'table', columns: [{ name: 'body', type: '', notNull: false, pk: 0, hasDefault: false, generated: false }] },
        { name: 'v', kind: 'view', columns: [{ name: 'n', type: '', notNull: false, pk: 0, hasDefault: false, generated: false }] },
      ],
    })
  })

  test('tables option: a subset in schema order, internal tables when named, unknown names refused', async () => {
    expect((await readSchema(db, { tables: ['v', 'orders', 'azora_files'] })).tables.map((t) => t.name)).toEqual(['orders', 'azora_files', 'v'])
    await expect(readSchema(db, { tables: ['orders', 'nope'] })).rejects.toThrow(new TypegenError('no table or view named "nope" in the database'))
  })
})

describe('azora-gen', () => {
  const schema: Schema = { tables: [table('orders', [{ name: 'id', type: 'INTEGER', pk: 1 }, { name: 'n', type: 'BIGINT' }])] }
  const run = async (argv: string[], source: SchemaSource = async () => schema) => {
    let out = ''
    const err: string[] = []
    const io: IO = { out: (t) => (out += t), err: (l) => err.push(l) }
    const code = await main(argv, io, source)
    return { code, out, err: err.join('\n') }
  }

  test('prints to stdout without --out', async () => {
    const r = await run([])
    expect(r.code).toBe(0)
    expect(r.out).toBe(generateTypes(schema, { command: 'azora-gen' }))
  })

  test('--out writes, --check compares', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'azora-gen-')), 'nested', 'types.ts')
    expect(await run(['--out', out, '--check'])).toMatchObject({ code: 1, err: expect.stringContaining('does not exist') })
    expect(await run(['--out', out, '--bigint'])).toMatchObject({ code: 0, out: '', err: expect.stringContaining('wrote') })
    const text = readFileSync(out, 'utf8')
    expect(text).toContain(`// Regenerate with: azora-gen --out ${out} --bigint`)
    expect(text).toContain('n: number | bigint | null')
    expect(await run(['--out', out, '--bigint', '--check'])).toMatchObject({ code: 0, err: expect.stringContaining('up to date') })
    expect(await run(['--out', out, '--bigint'])).toMatchObject({ code: 0, err: expect.stringContaining('no change') })
    // Another schema (here: other flags) no longer matches the file, and --check leaves it alone.
    expect(await run(['--out', out, '--check'])).toMatchObject({ code: 1, err: expect.stringContaining('out of date') })
    writeFileSync(out, text + '// edited\n')
    expect(await run(['--out', out, '--bigint', '--check'])).toMatchObject({ code: 1 })
    expect(readFileSync(out, 'utf8')).toBe(text + '// edited\n')
  })

  test('--tables reaches the source and the header', async () => {
    let seen: string[] | undefined
    const r = await run(['--tables', 'orders, items,'], async (_f, tables) => ((seen = tables), schema))
    expect(seen).toEqual(['orders', 'items'])
    expect(r.out).toContain('// Regenerate with: azora-gen --tables orders,items')
  })

  test('usage errors exit 2, failures exit 1', async () => {
    expect(await run(['--nope'])).toMatchObject({ code: 2, err: expect.stringContaining('--help') })
    expect(await run(['--check'])).toMatchObject({ code: 2, err: expect.stringContaining('--check needs --out') })
    expect(await run(['--tables', ','])).toMatchObject({ code: 2 })
    expect(await run([], async () => ({ tables: [] }))).toMatchObject({ code: 1, err: 'azora-gen: the database has no tables or views: nothing to generate' })
    expect(await run([], async () => { throw new TypegenError('no table or view named "x" in the database') })).toMatchObject({ code: 1, err: expect.stringContaining('"x"') })
    expect((await run(['--help'])).out).toContain('Usage: azora-gen')
    expect((await run(['--version'])).out).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('settings: flags, then the environment, then the env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azora-gen-'))
    const file = join(dir, 'env')
    writeFileSync(file, 'AZORA_URL=http://file/shop\nAZORA_API_KEY=azk_file\n')
    const base = { check: false, bigint: false }
    expect(settings({ ...base, 'env-file': file }, {})).toEqual({ url: 'http://file/shop', token: 'azk_file' })
    expect(settings({ ...base, 'env-file': file }, { AZORA_URL: 'http://env/shop', AZORA_TOKEN: 'azk_env' })).toEqual({ url: 'http://env/shop', token: 'azk_env' })
    expect(settings({ ...base, 'env-file': file, url: 'http://flag/shop', token: 'azk_flag' }, { AZORA_URL: 'http://env/shop' })).toEqual({ url: 'http://flag/shop', token: 'azk_flag' })
    expect(() => settings({ ...base, 'env-file': join(dir, 'missing') }, {})).toThrow(/no env file/)
    writeFileSync(file, 'AZORA_URL=http://file/shop\n')
    expect(() => settings({ ...base, 'env-file': file }, {})).toThrow(/no credential: pass --token or set AZORA_TOKEN/)
    expect(() => settings({ ...base, 'env-file': file, token: 't' }, { AZORA_URL: '' })).not.toThrow()
  })
})
