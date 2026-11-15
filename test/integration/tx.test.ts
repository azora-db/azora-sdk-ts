import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ClosedError, connect, sql, TxExpiredError, type Database, type Transaction } from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'

describe.skipIf(!engineBinary())('interactive transactions', () => {
  let engine: Engine
  let db: Database
  let other: Database

  beforeAll(async () => {
    engine = await startEngine({ realtime: { tx_idle_timeout: '1s', tx_max_duration: '10s' } })
    const url = `${engine.tcpUrl}?key=${engine.serverKey}`
    db = await connect(url, { apiKey: engine.apiKey })
    other = await connect(url, { apiKey: engine.apiKey })
  })
  afterAll(async () => {
    await db?.close()
    await other?.close()
    await engine?.stop()
  })

  const count = (c: Database | Transaction, v: string): Promise<unknown> => c.queryValue('SELECT count(*) FROM plain WHERE v = ?', [v])

  test('the session announces the lease', () => {
    expect(db.session?.txIdleMs).toBe(1000)
  })

  test('commit: read, decide, write, and return the value', async () => {
    const id = await db.tx(async (tx) => {
      expect(tx.idleMs).toBe(1000)
      const r = await tx.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [7, 'open', 20])
      expect(r).toEqual({ rowsAffected: 1, lastInsertId: r.lastInsertId, replayed: false })
      const total = await tx.queryValue<number>(sql`SELECT total FROM orders WHERE id = ${r.lastInsertId}`)
      await tx.exec('INSERT INTO items(order_id, sku, qty) VALUES (?, ?, ?)', [r.lastInsertId, 'A-1', (total ?? 0) / 10])
      return r.lastInsertId
    })
    expect(await other.query('SELECT o.status, i.sku, i.qty FROM orders o JOIN items i ON i.order_id = o.id WHERE o.id = ?', [id])).toEqual([
      { status: 'open', sku: 'A-1', qty: 2 },
    ])
  })

  test('rollback when the callback throws', async () => {
    const boom = new Error('changed my mind')
    await expect(db.tx(async (tx) => {
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['rolled-back'])
      expect(await count(tx, 'rolled-back')).toBe(1)
      throw boom
    })).rejects.toBe(boom)
    expect(await count(db, 'rolled-back')).toBe(0)
    // The writer is free again at once.
    expect((await db.exec('INSERT INTO plain(v) VALUES (?)', ['after-rollback'])).rowsAffected).toBe(1)
  })

  test('reads its own writes; a second client does not see them before the commit', async () => {
    await db.tx(async (tx) => {
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['mine'])
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['mine'])
      expect(await tx.query('SELECT v FROM plain WHERE v = ?', ['mine'])).toEqual([{ v: 'mine' }, { v: 'mine' }])
      expect(await tx.queryOne('SELECT count(*) AS n FROM plain WHERE v = ?', ['mine'])).toEqual({ n: 2 })
      expect(await count(other, 'mine')).toBe(0)
    })
    expect(await count(other, 'mine')).toBe(2)
  })

  test('a failing statement leaves the transaction open; refused statements', async () => {
    await db.tx(async (tx) => {
      await tx.exec('INSERT INTO kv(k, v) VALUES (?, ?)', ['dup', 'a'])
      await expect(tx.exec('INSERT INTO kv(k, v) VALUES (?, ?)', ['dup', 'b'])).rejects.toMatchObject({ code: 'invalid' })
      await expect(tx.exec('CREATE TABLE nope(id)')).rejects.toMatchObject({ code: 'invalid' })
      await expect(tx.exec('COMMIT')).rejects.toMatchObject({ code: 'permission_denied' })
      await expect(tx.query('DELETE FROM kv')).rejects.toMatchObject({ code: 'permission_denied' })
      await tx.exec('INSERT INTO kv(k, v) VALUES (?, ?)', ['dup2', 'c'])
    })
    expect(await db.query('SELECT k FROM kv WHERE k LIKE ? ORDER BY k', ['dup%'])).toEqual([{ k: 'dup' }, { k: 'dup2' }])
  })

  test('the same mutation id commits once', async () => {
    const mutationId = 'tx-' + Date.now()
    const run = (): Promise<void> => db.tx(async (tx) => {
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['once-tx'])
    }, { mutationId })
    await run()
    await run()
    expect(await count(db, 'once-tx')).toBe(1)
  })

  test('transactions of one client run one after the other', async () => {
    await db.exec('INSERT INTO kv(k, v) VALUES (?, ?)', ['counter', 0])
    await Promise.all(Array.from({ length: 10 }, () => db.tx(async (tx) => {
      const n = (await tx.queryValue<number>('SELECT v FROM kv WHERE k = ?', ['counter'])) ?? 0
      await tx.exec('UPDATE kv SET v = ? WHERE k = ?', [n + 1, 'counter'])
    })))
    expect(await db.queryValue('SELECT v FROM kv WHERE k = ?', ['counter'])).toBe(10)
  })

  test('a transaction idle past the lease is rolled back and rejects with TxExpiredError', async () => {
    let kept: Transaction | undefined
    const e = await db.tx(async (tx) => {
      kept = tx
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['expired'])
      await new Promise((r) => setTimeout(r, 1500))
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['expired'])
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TxExpiredError)
    expect(e).toMatchObject({ name: 'TxExpiredError', code: 'tx_expired' })
    expect(await count(db, 'expired')).toBe(0)
    await expect(kept?.query('SELECT 1')).rejects.toBeInstanceOf(ClosedError)
    // Idle before the commit: the commit reports it, and nothing applied.
    await expect(db.tx(async (tx) => {
      await tx.exec('INSERT INTO plain(v) VALUES (?)', ['expired'])
      await new Promise((r) => setTimeout(r, 1500))
    })).rejects.toBeInstanceOf(TxExpiredError)
    expect(await count(db, 'expired')).toBe(0)
    expect(await db.tx((tx) => count(tx, 'expired'))).toBe(0) // the next one works
  })

  test('a read-only credential cannot begin', async () => {
    const reader = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.readKey })
    try {
      await expect(reader.tx((tx) => tx.query('SELECT 1'))).rejects.toMatchObject({ code: 'permission_denied' })
    } finally {
      await reader.close()
    }
  })
})
