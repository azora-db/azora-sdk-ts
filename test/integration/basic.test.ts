import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { AzoraError, connect, HandshakeError, sql, type Database } from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'

describe.skipIf(!engineBinary())('queries and writes', () => {
  let engine: Engine
  let db: Database

  beforeAll(async () => {
    engine = await startEngine()
    db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey, storageUrl: engine.httpUrl })
  })
  afterAll(async () => {
    await db?.close()
    await engine?.stop()
  })

  test('session describes the connection', () => {
    expect(db.connected).toBe(true)
    expect(db.session).toMatchObject({ mode: 'IK', serverKey: engine.serverKey, fingerprint: engine.fingerprint })
    expect(db.session?.scopes.sort()).toEqual(['ddl', 'read', 'write'])
  })

  test('every value type round-trips', async () => {
    const big = 9007199254740993n
    const blob = Uint8Array.of(0, 1, 254, 255)
    const row = await db.queryOne(
      'SELECT ? AS i, ? AS neg, ? AS big, ? AS f, ? AS s, ? AS b, ? AS n, ? AS t, ? AS empty, ? AS min',
      [42, -7, big, 2.5, 'héllo 🌍', blob, null, true, new Uint8Array(0), -(2n ** 63n)],
    )
    expect(row).toEqual({ i: 42, neg: -7, big, f: 2.5, s: 'héllo 🌍', b: blob, n: null, t: 1, empty: new Uint8Array(0), min: -(2n ** 63n) })
  })

  test('exec, queryValue, sql tag and batch', async () => {
    const r = await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [1, 'open', 10.5])
    expect(r).toMatchObject({ rowsAffected: 1, replayed: false })
    const id = r.lastInsertId
    expect(await db.queryValue(sql`SELECT status FROM orders WHERE id = ${id}`)).toBe('open')
    const b = await db.batch([
      ['UPDATE orders SET status = ? WHERE id = ?', ['paid', id]],
      sql`INSERT INTO items(order_id, sku, qty) VALUES (${id}, ${'A-1'}, ${3})`,
      'INSERT INTO plain(v) VALUES (\'x\')',
    ])
    expect(b.rowsAffected).toBe(3) // the total over the statements
    expect(await db.query('SELECT o.status, i.sku, i.qty FROM orders o JOIN items i ON i.order_id = o.id WHERE o.id = ?', [id])).toEqual([
      { status: 'paid', sku: 'A-1', qty: 3 },
    ])
    expect(await db.queryOne('SELECT * FROM orders WHERE id = -1')).toBeUndefined()
    expect(await db.queryValue('SELECT id FROM orders WHERE id = -1')).toBeUndefined()
  })

  test('a failing batch changes nothing', async () => {
    const before = await db.queryValue<number>('SELECT count(*) FROM plain')
    await expect(db.batch(['INSERT INTO plain(v) VALUES (\'kept?\')', 'INSERT INTO nowhere VALUES (1)'])).rejects.toMatchObject({ code: 'invalid' })
    expect(await db.queryValue('SELECT count(*) FROM plain')).toBe(before)
  })

  test('the same mutation id applies once', async () => {
    const mutationId = 'test-' + Date.now()
    const a = await db.exec('INSERT INTO plain(v) VALUES (?)', ['once'], { mutationId })
    const b = await db.exec('INSERT INTO plain(v) VALUES (?)', ['once'], { mutationId })
    expect(a.replayed).toBe(false)
    expect(b).toMatchObject({ replayed: true, lastInsertId: a.lastInsertId })
    expect(await db.queryValue('SELECT count(*) FROM plain WHERE v = ?', ['once'])).toBe(1)
  })

  test('results larger than one frame, and maxRows', async () => {
    const text = 'x'.repeat(1000)
    const rows = await db.queryRaw(
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) SELECT i, ? AS pad FROM n',
      [text],
    )
    expect(rows.rows.length).toBe(2000)
    expect(rows.rows[1999]).toEqual([2000, text])
    expect(rows.truncated).toBe(false)
    const cut = await db.queryRaw('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT i FROM n', [], { maxRows: 7 })
    expect(cut.rows.length).toBe(7)
    expect(cut.truncated).toBe(true)
    const large = 'y'.repeat(300_000)
    expect(await db.queryValue('SELECT length(?)', [large])).toBe(300_000)
    expect(await db.queryValue('SELECT ?', [large])).toBe(large)
  })

  test('schema changes and errors', async () => {
    await db.exec('CREATE TABLE scratch(id INTEGER PRIMARY KEY, v TEXT UNIQUE)')
    await db.exec('INSERT INTO scratch(v) VALUES (?)', ['a'])
    const dup = await db.exec('INSERT INTO scratch(v) VALUES (?)', ['a']).catch((e: unknown) => e)
    expect(dup).toBeInstanceOf(AzoraError)
    expect((dup as AzoraError).code).toBe('invalid')
    await expect(db.query('SELECT * FROM nowhere')).rejects.toThrow(/invalid: .*no such table: nowhere/)
    await expect(db.query('SELECT FROM')).rejects.toMatchObject({ code: 'invalid' })
    await expect(db.query('SELEC 1')).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(db.query('ATTACH DATABASE \'x\' AS y')).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(db.exec('SELECT 1', [{} as never])).rejects.toThrow(/argument 1/)
    await db.exec('DROP TABLE scratch')
  })

  test('many concurrent requests', async () => {
    const out = await Promise.all(Array.from({ length: 500 }, (_, i) => db.queryValue<number>('SELECT ? * 2', [i])))
    expect(out).toEqual(Array.from({ length: 500 }, (_, i) => i * 2))
  })

  test('timeouts and abort signals', async () => {
    const slow = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000000) SELECT count(*) FROM n'
    await expect(db.query(slow, [], { timeoutMs: 30 })).rejects.toThrow(/did not finish within 30 ms/)
    const ac = new AbortController()
    const p = db.query(slow, [], { signal: ac.signal })
    ac.abort(new Error('nope'))
    await expect(p).rejects.toThrow('nope')
    expect(await db.ping()).toBeGreaterThan(0)
  })

  test('other handshakes and transports', async () => {
    const cases: Array<[string, string]> = [
      [`${engine.tcpUrl}?fp=${engine.fingerprint}`, 'XX'],
      [`${engine.tcpUrl}?plaintext=1`, 'plaintext'],
      [`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, 'IK'],
      [`azora+ws://127.0.0.1:${new URL(engine.httpUrl).port}?db=shop&fp=${engine.fingerprint}`, 'XX'],
      [`${engine.wsUrl}?db=shop&plaintext=1`, 'plaintext'],
    ]
    for (const [url, mode] of cases) {
      const c = await connect(url, { apiKey: engine.readKey })
      expect(c.session?.mode).toBe(mode)
      expect(await c.queryValue('SELECT 7')).toBe(7)
      await expect(c.exec('INSERT INTO plain(v) VALUES (1)')).rejects.toMatchObject({ code: 'permission_denied' })
      await c.close()
    }
  })

  test('connection failures are reported clearly', async () => {
    const wrongKey = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk'
    await expect(connect(`${engine.tcpUrl}?key=${wrongKey}`, { apiKey: engine.apiKey })).rejects.toBeInstanceOf(HandshakeError)
    await expect(connect(`${engine.tcpUrl}?fp=azp1-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa`, { apiKey: engine.apiKey })).rejects.toThrow(/fingerprint/)
    await expect(connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: 'azk_nope_nope' })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(connect(`azora://127.0.0.1:${engine.port}/nosuchdb?key=${engine.serverKey}`, { apiKey: engine.apiKey })).rejects.toBeInstanceOf(AzoraError)
    await expect(connect('azora://127.0.0.1:1/shop?plaintext=1', { apiKey: 'x', timeoutMs: 2000 })).rejects.toThrow()
    await expect(connect('http://x/shop', { apiKey: 'x' })).rejects.toThrow(/unsupported scheme/)
    await expect(connect(engine.tcpUrl, { apiKey: 'x' })).rejects.toThrow(/serverKey/)
  })

  test('close rejects calls in flight and later ones', async () => {
    const c = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    const pending = c.query('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000000) SELECT count(*) FROM n')
    const closing = c.close()
    await expect(pending).rejects.toThrow(/closed/)
    await closing
    await expect(c.query('SELECT 1')).rejects.toThrow(/closed/)
    expect(c.closed).toBe(true)
  })
})
