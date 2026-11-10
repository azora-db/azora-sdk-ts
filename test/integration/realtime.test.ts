import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  and, connect, eq, gt, Replica, RetryVerifyError, type Database, type LiveEvent, type Subscription, type Update, type VerifyResult,
} from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

interface Order {
  id: number
  customer: number
  status: string
  total: number
  note: string | null
}

/** Verifies a replica against the server, applying pending updates as Subscription.verify asks. */
async function verified(sub: Subscription, rep: Replica): Promise<VerifyResult> {
  for (;;) {
    try {
      return await sub.verify(rep.checksum)
    } catch (e) {
      if (!(e instanceof RetryVerifyError)) throw e
      rep.apply(await sub.next())
    }
  }
}

describe.skipIf(!engineBinary())('subscriptions and live queries', () => {
  let engine: Engine
  let db: Database
  const insert = (customer: number, status: string, total: number, note: string | null = null) =>
    db.exec('INSERT INTO orders(customer, status, total, note) VALUES (?, ?, ?, ?)', [customer, status, total, note])

  beforeAll(async () => {
    engine = await startEngine()
    db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    for (let i = 1; i <= 20; i++) await insert(i % 4, i % 2 ? 'open' : 'paid', i * 10)
  })
  afterAll(async () => {
    await db?.close()
    await engine?.stop()
  })

  test('a filtered table subscription: snapshot, then changes', async () => {
    const sub = await db.subscribe({ table: 'orders', where: and(eq('status', 'paid'), gt('total', 100)) })
    const snap = await sub.next()
    expect(snap).toMatchObject({ reset: true, snapshot: true })
    expect(snap.changes.map((c) => c.key[0])).toEqual([12, 14, 16, 18, 20])
    expect(snap.changes[0]).toMatchObject({ op: 'insert', table: 'orders', columns: ['id', 'customer', 'status', 'total', 'note'], pk: ['id'], seq: 0 })
    expect(snap.changes[0]?.new).toEqual([12, 0, 'paid', 120, null])
    expect(snap.checkpoint).toBeGreaterThan(0)

    const { lastInsertId: id } = await insert(9, 'paid', 500, 'big')
    await insert(9, 'open', 900) // does not match
    await db.exec('UPDATE orders SET total = total + 1 WHERE id = ?', [id])
    await db.exec('UPDATE orders SET status = ? WHERE id = ?', ['open', id]) // leaves the filter
    await db.exec('UPDATE orders SET status = ? WHERE id = ?', ['paid', 11]) // 11 has total 110: enters it
    await db.exec('DELETE FROM orders WHERE id = ?', [12])
    const seen: string[] = []
    while (seen.length < 5) {
      const u = await sub.next()
      expect(u.reset).toBe(false)
      for (const c of u.changes) seen.push(`${c.op} ${c.key[0]}`)
    }
    expect(seen).toEqual([`insert ${id}`, `update ${id}`, `delete ${id}`, 'insert 11', 'delete 12'])
    expect(sub.checkpoint.checkpoint).toBeGreaterThan(snap.checkpoint)
    await sub.close()
    await expect(sub.next()).rejects.toThrow(/closed/)
  })

  test('filter text is the same as a built filter', async () => {
    const a = await db.subscribe({ table: 'orders', where: "status = 'open' AND customer IN (1, 3) AND note IS NULL" })
    const snap = await a.next()
    const want = await db.query<Order>("SELECT id FROM orders WHERE status = 'open' AND customer IN (1, 3) AND note IS NULL ORDER BY id")
    expect(snap.changes.map((c) => c.key[0])).toEqual(want.map((o) => o.id))
    await a.close()
    await expect(db.subscribe({ table: 'orders', where: 'nope = 1' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(db.subscribe({ table: 'plain' })).rejects.toThrow(/invalid|not published/)
  })

  test('row, database and for-await subscriptions', async () => {
    const row = await db.subscribe({ table: 'orders', key: [1] })
    expect((await row.next()).changes.map((c) => c.key)).toEqual([[1]])
    await db.exec('UPDATE orders SET note = ? WHERE id = 1', ['hello'])
    await db.exec('UPDATE orders SET note = ? WHERE id = 2', ['other row'])
    const u = await row.next()
    expect(u.changes).toHaveLength(1)
    expect(u.changes[0]).toMatchObject({ op: 'update', key: [1] })
    expect(u.changes[0]?.old?.[4]).toBeNull()
    expect(u.changes[0]?.new?.[4]).toBe('hello')
    await row.close()

    const all = await db.subscribe({})
    const tables = new Set<string>()
    let updates = 0
    setTimeout(() => void db.exec('INSERT INTO items(order_id, sku, qty) VALUES (1, ?, 2)', ['sku-' + Date.now()]), 20)
    for await (const up of all) {
      updates++
      for (const c of up.changes) tables.add(c.table)
      if (tables.has('items')) break // closes the subscription
    }
    expect(updates).toBeGreaterThanOrEqual(1)
    expect([...tables]).toContain('orders')
    expect(all.closed).toBe(true)
  })

  test('a replica verifies against the server, floats included', async () => {
    const sub = await db.subscribe({ table: 'orders' })
    const rep = new Replica()
    rep.apply(await sub.next())
    expect(rep.size('orders')).toBe(await db.queryValue('SELECT count(*) FROM orders'))
    expect(rep.get('orders', 3)).toEqual([3, 3, 'open', 30, null]) // total is a REAL holding 30.0
    expect(await verified(sub, rep)).toMatchObject({ match: true, serverRows: rep.size() })
    await insert(5, 'open', 12.5)
    await db.exec('UPDATE orders SET total = 77 WHERE id = 3')
    const res = await verified(sub, rep)
    expect(res.match).toBe(true)
    expect(rep.get('orders', 3)?.[3]).toBe(77)
    // A local row that differs is caught.
    rep.applyChange({ seq: 0, table: 'orders', op: 'update', key: [3], new: [3, 3, 'open', 78, null], old: null, columns: [], pk: [], tv: 0 })
    expect((await verified(sub, rep)).match).toBe(false)
    await sub.close()
  })

  test('live query: ordered rows, typed events, stable identities', async () => {
    const live = await db.live<Order>('orders', { where: eq('customer', 2), orderBy: ['total', 'desc'] })
    const first = live.rows
    expect(first.length).toBeGreaterThan(0)
    expect(first.map((o) => o.total)).toEqual([...first.map((o) => o.total)].sort((a, b) => b - a))
    expect(live.rows).toBe(first) // same array until something changes
    const events: LiveEvent<Order>[] = []
    const off = live.subscribe((ev) => events.push(ev))
    const { lastInsertId: id } = await insert(2, 'open', 1e6)
    await until(() => events.length === 1, 'the insert event')
    expect(events[0]?.changes).toEqual([{ op: 'insert', key: [id], row: live.get(id), previous: undefined }])
    expect(live.rows[0]).toMatchObject({ id, total: 1e6 })
    expect(live.rows).not.toBe(first)
    const untouched = live.rows[1]
    await db.batch([
      ['UPDATE orders SET status = ? WHERE id = ?', ['paid', id]],
      ['DELETE FROM orders WHERE id = ?', [first[first.length - 1]?.id]],
    ])
    await until(() => events.length === 2, 'the batch event')
    // One transaction is one event: listeners never see half of it.
    expect(events[1]?.changes.map((c) => c.op).sort()).toEqual(['delete', 'update'])
    expect(live.get(id)?.status).toBe('paid')
    expect(live.rows[1]).toBe(untouched)
    expect((await live.verify()).match).toBe(true)
    off()
    await live.close()
    expect(live.error).toBeNull()
  })

  test('live query over a composite key, a single row, and a mapper', async () => {
    await db.batch([
      ['INSERT OR REPLACE INTO items(order_id, sku, qty) VALUES (?, ?, ?)', [7, 'b', 1]],
      ['INSERT OR REPLACE INTO items(order_id, sku, qty) VALUES (?, ?, ?)', [7, 'a', 2]],
    ])
    const items = await db.live('items', { where: eq('order_id', 7), map: (r) => `${r['sku']}x${r['qty']}` })
    expect(items.rows).toEqual(['ax2', 'bx1']) // primary key order
    expect(items.get(7, 'a')).toBe('ax2')
    await db.exec('UPDATE items SET qty = 5 WHERE order_id = 7 AND sku = ?', ['b'])
    await until(() => items.get(7, 'b') === 'bx5', 'the update')
    await items.close()

    const one = await db.live<Order>('orders', { key: [4] })
    expect(one.rows.map((o) => o.id)).toEqual([4])
    await db.exec('DELETE FROM orders WHERE id = 4')
    await until(() => one.size === 0, 'the delete')
    await one.close()
  })

  test('live events as an async iterator', async () => {
    const live = await db.live<Order>('orders', { where: eq('customer', 3) })
    const got: number[] = []
    const reader = (async () => {
      for await (const ev of live) {
        got.push(ev.rows.length)
        if (got.length === 3) break
      }
    })()
    await until(() => got.length === 1, 'the initial event')
    await insert(3, 'open', 1)
    await until(() => got.length === 2, 'the first change')
    await insert(3, 'open', 2)
    await reader
    expect(got).toEqual([got[0], (got[0] as number) + 1, (got[0] as number) + 2])
    await live.close()
  })

  test('watch reports written tables, published or not', async () => {
    const seen: string[][] = []
    const stop = await db.watch(['plain', 'kv'], (tables) => seen.push(tables))
    await db.exec('INSERT INTO plain(v) VALUES (?)', ['w'])
    await until(() => seen.length >= 1, 'the plain notification')
    await insert(1, 'open', 1) // not watched
    await db.exec('INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)', ['a', Uint8Array.of(1)])
    await until(() => seen.flat().includes('kv'), 'the kv notification')
    expect(seen.flat().sort()).toEqual(['kv', 'plain'])
    await stop()
  })

  test('resync takes a new snapshot', async () => {
    const live = await db.live<Order>('orders', { where: eq('customer', 1) })
    const resets: boolean[] = []
    live.subscribe((ev) => resets.push(ev.reset))
    const before = live.rows.length
    live.resync()
    await until(() => resets.includes(true), 'the reset event')
    expect(live.rows.length).toBe(before)
    expect(db.stats.resyncs).toBeGreaterThanOrEqual(1)
    await live.close()
  })

  test('resuming from a stored checkpoint skips the snapshot', async () => {
    const a = await db.subscribe({ table: 'orders' })
    const snap: Update = await a.next()
    await a.close()
    await insert(6, 'open', 66)
    await insert(6, 'open', 67)
    const b = await db.subscribe({ table: 'orders', since: snap.checkpoint, epoch: snap.epoch })
    const u = await b.next()
    expect(u).toMatchObject({ reset: false, snapshot: false })
    expect(u.changes.map((c) => c.new?.[3])).toEqual([66, 67])
    await b.close()
    const c = await db.subscribe({ table: 'orders', noSnapshot: true })
    await insert(6, 'open', 68)
    expect((await c.next()).changes.map((x) => x.new?.[3])).toEqual([68])
    await c.close()
  })
})
