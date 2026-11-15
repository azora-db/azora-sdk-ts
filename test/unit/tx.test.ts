import { afterEach, describe, expect, test } from 'vitest'
import { Writer } from '../../src/codec.ts'
import {
  AzoraError, ClosedError, connect, TxExpiredError, UnknownOutcomeError, type ConnectOptions, type Database, type Transaction,
} from '../../src/index.ts'
import { CLIENT_TX, decode, encode, MsgType, type Msg } from '../../src/messages.ts'
import { FakeServer, type FakeConn } from '../helpers/fake-server.ts'
import { until } from '../helpers/wait.ts'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))

describe('transaction messages', () => {
  // The same messages as the Go implementation's sampleMsgs (internal/azp/msg_test.go).
  const vals = [null, -5, 2.5, 'héllo', Uint8Array.of(0, 255)]
  const samples: Array<[Msg, (w: Writer) => void]> = [
    [{ type: MsgType.TxBegin, reqId: 16 }, (w) => w.u(16)],
    [{ type: MsgType.TxBegun, reqId: 16, txId: 2 ** 40, idleMs: 5000 }, (w) => { w.u(16); w.u(2 ** 40); w.u(5000) }],
    [{ type: MsgType.TxStmt, reqId: 17, txId: 2 ** 40, sql: 'SELECT ?', args: vals, query: true }, (w) => { w.u(17); w.u(2 ** 40); w.s('SELECT ?'); w.vals(vals); w.flag(true) }],
    [{ type: MsgType.TxStmt, reqId: 18, txId: 3, sql: 'DELETE FROM t', args: null, query: false }, (w) => { w.u(18); w.u(3); w.s('DELETE FROM t'); w.vals(null); w.flag(false) }],
    [{ type: MsgType.TxEnd, reqId: 19, txId: 3, commit: true, mutation: 'm-4' }, (w) => { w.u(19); w.u(3); w.flag(true); w.s('m-4') }],
    [{ type: MsgType.TxEnd, reqId: 20, txId: 3, commit: false, mutation: '' }, (w) => { w.u(20); w.u(3); w.flag(false); w.s('') }],
  ]

  test('type numbers and field order', () => {
    expect([MsgType.TxBegin, MsgType.TxBegun, MsgType.TxStmt, MsgType.TxEnd]).toEqual([29, 30, 31, 32])
    for (const [m, fields] of samples) {
      const w = new Writer()
      w.byte(m.type)
      fields(w)
      const want = hex(w.finish())
      expect(hex(encode(m)), `type ${m.type}`).toBe(want)
      expect(decode(unhex(want))).toEqual(m)
    }
    // Spelled out for the fixed-size ones.
    expect(hex(encode((samples[0] as [Msg, unknown])[0]))).toBe('1d10')
    expect(hex(encode((samples[1] as [Msg, unknown])[0]))).toBe('1e108080808080208827')
  })

  test('every strict prefix and any trailing byte is refused', () => {
    for (const [m] of samples) {
      const b = encode(m)
      for (let n = 0; n < b.length; n++) expect(() => decode(b.subarray(0, n)), `type ${m.type} cut to ${n}`).toThrow(/malformed/)
      expect(() => decode(Uint8Array.of(...b, 0))).toThrow(/trailing/)
    }
    expect(() => decode(Uint8Array.of(MsgType.TxEnd, 1, 1, 2, 0))).toThrow(/bad flag 2/)
  })

  test('Welcome carries the idle lease as a trailing field, only when set', () => {
    const old: Msg = { type: MsgType.Welcome, sessionId: 's1', serverTimeMs: 0, heartbeatMs: 15000, maxMessage: 1 << 20, principal: 'p', scopes: ['read'], maxSubscriptions: 100 }
    const ob = encode(old)
    expect(hex(encode({ ...old, txIdleMs: 0 }))).toBe(hex(ob)) // byte for byte the older layout
    const nb = encode({ ...old, txIdleMs: 5000 })
    expect(hex(nb)).toBe(hex(ob) + '8827') // the field is appended
    expect(decode(nb)).toEqual({ ...old, txIdleMs: 5000 })
    expect(decode(ob)).toEqual({ ...old, txIdleMs: 0 }) // an older engine's Welcome
    expect(() => decode(Uint8Array.of(...ob, 0))).toThrow(/tx idle 0 is not sent/)
    expect(() => decode(Uint8Array.of(...nb, 1))).toThrow(/trailing/)
  })
})

type Req<T extends number> = Extract<Msg, { type: T }>
const result = (reqId: number, rows: Array<Array<number | string | null>> = [], extra: Partial<Req<typeof MsgType.Result>> = {}): Msg => ({
  type: MsgType.Result, reqId, columns: ['v'], rows, truncated: false, rowsAffected: 0, lastInsertId: 0, replayed: false, ...extra,
})
const error = (reqId: number, code: string, message = code): Msg => ({ type: MsgType.Error, reqId, code, message, fatal: false, retryAfterMs: 0 })

let open: Database[] = []
async function client(server: FakeServer, o: Partial<ConnectOptions> = {}): Promise<Database> {
  const db = await connect({
    database: 'shop', allowPlaintext: true, apiKey: 'k', transport: server.transport, reconnectMinMs: 1, reconnectMaxMs: 5, onError: () => {}, ...o,
  })
  open.push(db)
  return db
}
afterEach(async () => {
  await Promise.all(open.map((d) => d.close()))
  open = []
})

/** A server with interactive transactions: statements answer [[sql]] or rowsAffected 1. */
function txServer(): FakeServer {
  const s = new FakeServer()
  s.txIdleMs = 5000
  let txId = 0
  s.onMessage = (m, c) => {
    if (m.type === MsgType.TxBegin) c.send({ type: MsgType.TxBegun, reqId: m.reqId, txId: ++txId, idleMs: 5000 })
    else if (m.type === MsgType.TxStmt) c.send(m.query ? result(m.reqId, [[m.sql]]) : result(m.reqId, [], { rowsAffected: 1, lastInsertId: 7 }))
    else if (m.type === MsgType.TxEnd) c.send(m.commit ? result(m.reqId, [], { rowsAffected: 2 }) : { type: MsgType.OK, reqId: m.reqId })
    else if (m.type === MsgType.Query) c.send(result(m.reqId, [[m.sql]]))
  }
  return s
}
const txMsgs = (c: FakeConn): Msg[] => c.received.filter((m) => m.type === MsgType.TxBegin || m.type === MsgType.TxStmt || m.type === MsgType.TxEnd)

describe('db.tx', () => {
  test('begins, runs the statements on the transaction, commits and returns the value', async () => {
    const s = txServer()
    const db = await client(s, { clientName: 'my-app/2' })
    expect(s.last.received[0]).toMatchObject({ type: MsgType.Hello, client: `my-app/2 ${CLIENT_TX}` })
    expect(db.session?.txIdleMs).toBe(5000)
    const out = await db.tx(async (tx) => {
      expect(tx.idleMs).toBe(5000)
      const rows = await tx.query('SELECT a', [1])
      const one = await tx.queryOne({ sql: 'SELECT b', args: [] })
      const v = await tx.queryValue('SELECT c')
      const raw = await tx.queryRaw('SELECT d')
      const w = await tx.exec('INSERT INTO t VALUES (?)', ['x'])
      return { rows, one, v, raw, w }
    }, { mutationId: 'order-1' })
    expect(out).toEqual({
      rows: [{ v: 'SELECT a' }], one: { v: 'SELECT b' }, v: 'SELECT c', raw: { columns: ['v'], rows: [['SELECT d']], truncated: false },
      w: { rowsAffected: 1, lastInsertId: 7, replayed: false },
    })
    expect(txMsgs(s.last)).toMatchObject([
      { type: MsgType.TxBegin },
      { type: MsgType.TxStmt, txId: 1, sql: 'SELECT a', args: [1], query: true },
      { type: MsgType.TxStmt, txId: 1, sql: 'SELECT b', args: null, query: true },
      { type: MsgType.TxStmt, txId: 1, sql: 'SELECT c', query: true },
      { type: MsgType.TxStmt, txId: 1, sql: 'SELECT d', query: true },
      { type: MsgType.TxStmt, txId: 1, sql: 'INSERT INTO t VALUES (?)', args: ['x'], query: false },
      { type: MsgType.TxEnd, txId: 1, commit: true, mutation: 'order-1' },
    ])
    expect(await db.tx(() => 5)).toBe(5) // a synchronous callback, no mutation id
    expect(txMsgs(s.last).at(-1)).toMatchObject({ type: MsgType.TxEnd, txId: 2, commit: true, mutation: '' })
  })

  test('rolls back when the callback throws, and rethrows its error', async () => {
    const s = txServer()
    const db = await client(s)
    const boom = new Error('sold out')
    await expect(db.tx(async (tx) => {
      await tx.exec('UPDATE t SET v = 1')
      throw boom
    })).rejects.toBe(boom)
    expect(txMsgs(s.last).at(-1)).toMatchObject({ type: MsgType.TxEnd, txId: 1, commit: false, mutation: '' })
    // A statement's error leaves the transaction open: caught, the transaction still commits.
    const plain = s.onMessage
    s.onMessage = (m, c) => (m.type === MsgType.TxStmt && m.sql === 'bad' ? c.send(error(m.reqId, 'invalid')) : plain(m, c))
    await db.tx(async (tx) => {
      const e = await tx.exec('bad').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(AzoraError)
      expect(e).not.toBeInstanceOf(TxExpiredError)
      await tx.exec('good')
    })
    expect(txMsgs(s.last).slice(-2)).toMatchObject([{ sql: 'good' }, { type: MsgType.TxEnd, commit: true }])
  })

  test('calls on a transaction that ended reject', async () => {
    const s = txServer()
    const db = await client(s)
    let kept: Transaction | undefined
    await db.tx((tx) => {
      kept = tx
    })
    await expect(kept?.query('SELECT 1')).rejects.toThrow(ClosedError)
    await expect(kept?.exec('DELETE FROM t')).rejects.toThrow(/the transaction has ended \(committed\)/)
    await db.tx((tx) => {
      kept = tx
      throw new Error('no')
    }).catch(() => {})
    await expect(kept?.queryValue('SELECT 1')).rejects.toThrow(/the transaction has ended \(rolled back\)/)
    expect(txMsgs(s.last).filter((m) => m.type === MsgType.TxStmt)).toHaveLength(0)
  })

  test('a server without interactive transactions is refused clearly', async () => {
    const s = txServer()
    s.txIdleMs = 0 // an older engine, or realtime.tx_idle_timeout = 0
    const db = await client(s)
    expect(db.session?.txIdleMs).toBe(0)
    let ran = false
    const e = await db.tx(() => {
      ran = true
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(AzoraError)
    expect(e).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/does not support interactive transactions/) })
    expect(ran).toBe(false)
    expect(txMsgs(s.last)).toHaveLength(0)
    expect(await db.queryValue('SELECT 1')).toBe('SELECT 1')
  })

  test('an expired lease rejects with TxExpiredError, also on commit; a rollback of it is quiet', async () => {
    const s = txServer()
    const plain = s.onMessage
    s.onMessage = (m, c) => {
      if ((m.type === MsgType.TxStmt && m.sql === 'late') || m.type === MsgType.TxEnd) c.send(error(m.reqId, 'tx_expired', 'the transaction was idle for 5s'))
      else plain(m, c)
    }
    const db = await client(s)
    let second: unknown
    const first = await db.tx(async (tx) => {
      await tx.exec('early')
      try {
        await tx.exec('late')
      } catch (e) {
        second = await tx.exec('never sent').catch((x: unknown) => x)
        throw e
      }
    }).catch((x: unknown) => x)
    expect(first).toBeInstanceOf(TxExpiredError)
    expect(first).toMatchObject({ name: 'TxExpiredError', code: 'tx_expired', message: 'tx_expired: the transaction was idle for 5s' })
    expect(second).toBe(first) // fails at once, without asking the server
    expect(txMsgs(s.last).map((m) => (m.type === MsgType.TxStmt ? m.sql : m.type))).toEqual([MsgType.TxBegin, 'early', 'late'])
    // The lease runs out between the last statement and the commit.
    await expect(db.tx((tx) => tx.exec('early'))).rejects.toBeInstanceOf(TxExpiredError)
    // The callback throws and the rollback finds the transaction gone: only the callback's error shows.
    await expect(db.tx(() => {
      throw new Error('mine')
    })).rejects.toThrow('mine')
  })

  test('a dropped connection ends the transaction: nothing is replayed on the new one', async () => {
    const s = txServer()
    const plain = s.onMessage
    s.onMessage = (m, c) => (m.type === MsgType.TxStmt && m.sql === 'drop' ? c.drop() : plain(m, c))
    const db = await client(s)
    let after: unknown
    const e = await db.tx(async (tx) => {
      await tx.exec('first')
      try {
        await tx.exec('drop')
      } catch (err) {
        await until(() => s.accepted === 2 && db.connected, 'the reconnect')
        after = await tx.query('SELECT 1').catch((x: unknown) => x)
        throw err
      }
    }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TxExpiredError)
    expect((e as Error).message).toMatch(/connection that held the transaction was lost/)
    expect(after).toBeInstanceOf(TxExpiredError)
    expect(s.accepted).toBe(2)
    expect(txMsgs(s.last)).toHaveLength(0) // no begin, statement or end reached the new connection
    expect(db.stats.retries).toBe(0)
    expect(await db.tx((tx) => tx.queryValue('again'))).toBe('again') // a new transaction works
  })

  test('a connection lost during the commit is an unknown outcome', async () => {
    const s = txServer()
    const plain = s.onMessage
    s.onMessage = (m, c) => (m.type === MsgType.TxEnd ? c.drop() : plain(m, c))
    const db = await client(s)
    await expect(db.tx((tx) => tx.exec('w'), { mutationId: 'm-9' })).rejects.toBeInstanceOf(UnknownOutcomeError)
    expect(txMsgs(s.conns[0] as FakeConn).at(-1)).toMatchObject({ type: MsgType.TxEnd, commit: true, mutation: 'm-9' })
    await until(() => s.accepted === 2, 'the reconnect')
    expect(txMsgs(s.last)).toHaveLength(0)
  })

  test('one connection runs one transaction at a time; a pool holds one connection per transaction', async () => {
    const s = txServer()
    const db = await client(s)
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const a = db.tx(async (tx) => {
      order.push('a in')
      await gate
      await tx.exec('a')
      order.push('a out')
    })
    const b = db.tx(async (tx) => {
      order.push('b in')
      await tx.exec('b')
    })
    await until(() => order.includes('a in'), 'the first transaction')
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['a in']) // b has not begun
    expect(txMsgs(s.last).filter((m) => m.type === MsgType.TxBegin)).toHaveLength(1)
    // A waiting transaction gives up at its timeout without disturbing the queue.
    await expect(db.tx(() => 1, { timeoutMs: 20 })).rejects.toThrow(/did not finish within 20 ms/)
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['a in', 'a out', 'b in'])

    const p = txServer()
    const pool = await client(p, { pool: 2 })
    let free: () => void = () => {}
    const hold = new Promise<void>((r) => {
      free = r
    })
    let inside = 0
    const both = [0, 1].map(() => pool.tx(async (tx) => {
      inside++
      await hold
      await tx.exec('w')
    }))
    await until(() => inside === 2, 'both transactions open at once')
    expect(p.conns.map((c) => txMsgs(c).length)).toEqual([1, 1])
    free()
    await Promise.all(both)
    expect(p.conns.map((c) => txMsgs(c).map((m) => m.type))).toEqual([
      [MsgType.TxBegin, MsgType.TxStmt, MsgType.TxEnd], [MsgType.TxBegin, MsgType.TxStmt, MsgType.TxEnd],
    ])
  })

  test('close ends a transaction in progress', async () => {
    const s = txServer()
    const db = await client(s)
    const p = db.tx(async (tx) => {
      await db.close()
      await tx.exec('w')
    })
    await expect(p).rejects.toBeInstanceOf(ClosedError)
  })
})
