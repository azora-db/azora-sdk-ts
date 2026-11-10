import { afterEach, describe, expect, test } from 'vitest'
import {
  AzoraError, ClosedError, connect, ResyncError, TimeoutError, UnknownOutcomeError, type ConnectOptions, type Database, type Update,
} from '../../src/index.ts'
import { MsgType, Op, type Msg } from '../../src/messages.ts'
import { FakeServer, type FakeConn } from '../helpers/fake-server.ts'
import { until } from '../helpers/wait.ts'

type Req<T extends number> = Extract<Msg, { type: T }>
const result = (reqId: number, rows: Array<Array<number | string | null>> = [], extra: Partial<Req<typeof MsgType.Result>> = {}): Msg => ({
  type: MsgType.Result, reqId, columns: ['v'], rows, truncated: false, rowsAffected: 0, lastInsertId: 0, replayed: false, ...extra,
})
const error = (reqId: number, code: string, retryAfterMs = 0, fatal = false): Msg => ({ type: MsgType.Error, reqId, code, message: code, fatal, retryAfterMs })

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

/** Answers queries with [[sql]] and writes with rowsAffected 1. */
function echo(m: Msg, c: FakeConn): void {
  if (m.type === MsgType.Query) c.send(result(m.reqId, [[m.sql]]))
  else if (m.type === MsgType.Exec || m.type === MsgType.Tx) c.send(result(m.reqId, [], { rowsAffected: 1 }))
}

describe('requests', () => {
  test('hello carries the database, credential and client name', async () => {
    const s = new FakeServer()
    s.onMessage = echo
    const db = await client(s, { clientName: 'my-app/2' })
    expect(s.last.received[0]).toMatchObject({ type: MsgType.Hello, version: 1, database: 'shop', credential: 'k', client: 'my-app/2' })
    expect(await db.queryValue('SELECT 1')).toBe('SELECT 1')
    expect(db.session).toMatchObject({ mode: 'plaintext', principal: 'test', serverKey: '' })
  })

  test('a read is sent again when its connection drops', async () => {
    const s = new FakeServer()
    let first = true
    s.onMessage = (m, c) => {
      if (first) {
        first = false
        c.drop()
      } else echo(m, c)
    }
    const db = await client(s)
    expect(await db.queryValue('SELECT 2')).toBe('SELECT 2')
    expect(s.accepted).toBe(2)
    expect(db.stats).toMatchObject({ retries: 1, connects: 2, disconnects: 1 })
  })

  test('a write is resent with the same mutation id; a schema change is not resent', async () => {
    const s = new FakeServer()
    const ids: string[] = []
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.Exec) return
      ids.push(m.mutationId)
      if (ids.length === 1 || m.sql.includes('CREATE')) c.drop()
      else c.send(result(m.reqId, [], { rowsAffected: 1, replayed: true }))
    }
    const db = await client(s)
    expect(await db.exec('INSERT INTO t VALUES (?)', [1])).toMatchObject({ rowsAffected: 1, replayed: true })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^m-[0-9a-f]{32}$/)
    expect(ids[1]).toBe(ids[0])
    await expect(db.exec('  -- add a table\n CREATE TABLE x(id)')).rejects.toBeInstanceOf(UnknownOutcomeError)
    expect(ids[2]).toBe('') // no mutation id: the server could not deduplicate it
  })

  test('rate limits wait for the hint; unavailable backs off; other errors are final', async () => {
    const s = new FakeServer()
    const seen: Record<string, number> = {}
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.Query) return
      const n = (seen[m.sql] = (seen[m.sql] ?? 0) + 1)
      if (m.sql === 'limited' && n < 3) c.send(error(m.reqId, 'resource_exhausted', 15))
      else if (m.sql === 'reopening' && n < 4) c.send(error(m.reqId, 'unavailable'))
      else if (m.sql === 'down') c.send(error(m.reqId, 'unavailable'))
      else if (m.sql === 'bad') c.send(error(m.reqId, 'invalid'))
      else echo(m, c)
    }
    const db = await client(s)
    const start = Date.now()
    expect(await db.queryValue('limited')).toBe('limited')
    expect(Date.now() - start).toBeGreaterThanOrEqual(28)
    expect(db.stats.rateLimited).toBe(2)
    expect(await db.queryValue('reopening')).toBe('reopening')
    await expect(db.query('down')).rejects.toMatchObject({ code: 'unavailable' })
    expect(seen['down']).toBe(6) // the first try and five retries
    const bad = await db.query('bad').catch((e: unknown) => e)
    expect(bad).toBeInstanceOf(AzoraError)
    expect(seen['bad']).toBe(1)
  })

  test('GoAway: answers in flight arrive, then the client reconnects after the hint', async () => {
    const s = new FakeServer()
    s.onMessage = (m, c) => {
      if (m.type === MsgType.Query && m.sql === 'slow') {
        c.send({ type: MsgType.GoAway, reason: 'deploy', retryAfterMs: 30 })
        setTimeout(() => c.send(result(m.reqId, [['late']])), 20)
      } else echo(m, c)
    }
    const db = await client(s)
    const start = Date.now()
    expect(await db.queryValue('slow')).toBe('late')
    expect(await db.queryValue('next')).toBe('next') // waits for the new connection
    expect(Date.now() - start).toBeGreaterThanOrEqual(30)
    expect(s.accepted).toBe(2)
  })

  test('a silent server is pinged, then replaced', async () => {
    const s = new FakeServer()
    s.heartbeatMs = 30
    let pings = 0
    s.onMessage = (m, c) => {
      if (m.type === MsgType.Ping) pings++
      else echo(m, c)
    }
    const reasons: string[] = []
    const db = await client(s, { onDisconnect: (e) => reasons.push(e.message) })
    await until(() => s.accepted >= 2, 'the reconnect', 2000)
    expect(pings).toBeGreaterThanOrEqual(1)
    expect(reasons[0]).toMatch(/no traffic from the server/)
    expect(await db.queryValue('alive')).toBe('alive')
  })

  test('a server ping is answered', async () => {
    const s = new FakeServer()
    const db = await client(s)
    s.last.send({ type: MsgType.Ping, nonce: 77 })
    await until(() => s.last.received.some((m) => m.type === MsgType.Pong && m.nonce === 77), 'the pong')
    expect(db.connected).toBe(true)
  })

  test('a refused credential fails connect, and later calls fail fast', async () => {
    const s = new FakeServer()
    s.refuseHello = () => 'unauthenticated'
    await expect(client(s)).rejects.toMatchObject({ code: 'unauthenticated' })
    let ok = true
    s.refuseHello = () => (ok ? undefined : 'unauthenticated')
    s.onMessage = echo
    const db = await client(s)
    ok = false // the key was revoked: the next Hello is refused
    s.last.drop()
    await until(() => db.stats.connectFailures >= 1, 'the refused reconnect')
    const start = Date.now()
    await expect(db.query('x')).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(Date.now() - start).toBeLessThan(500) // no waiting for the request timeout
    ok = true
    await until(() => db.connected, 'the reconnect once the key works again')
    expect(await db.queryValue('y')).toBe('y')
  })

  test('an expired credential is refreshed and the request sent again', async () => {
    const s = new FakeServer()
    let current = 'token-1'
    s.onMessage = (m, c) => {
      if (m.type === MsgType.Auth) {
        current = m.credential
        c.send({ type: MsgType.OK, reqId: m.reqId })
      } else if (m.type === MsgType.Query) {
        if (current === 'token-1') c.send(error(m.reqId, 'unauthenticated'))
        else echo(m, c)
      }
    }
    let n = 0
    const db = await client(s, { apiKey: '', token: () => `token-${++n}` })
    expect(await db.queryValue('q')).toBe('q')
    expect(n).toBe(2)
    expect(db.stats.credentialRefreshes).toBe(1)
    // Without a provider the error is final.
    const s2 = new FakeServer()
    s2.onMessage = (m, c) => m.type === MsgType.Query && c.send(error(m.reqId, 'unauthenticated'))
    await expect((await client(s2)).query('q')).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test('timeouts say when the client was not connected; close ends calls', async () => {
    const s = new FakeServer()
    const db = await client(s)
    s.down = true
    s.last.drop()
    await until(() => db.stats.connectFailures >= 1, 'a failed reconnect')
    const err = await db.query('x', [], { timeoutMs: 30 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as Error).message).toMatch(/not connected: fake: connection refused/)
    const waiting = db.query('y')
    await db.close()
    await expect(waiting).rejects.toBeInstanceOf(ClosedError)
    await expect(db.exec('z')).rejects.toBeInstanceOf(ClosedError)
  })

  test('options are validated before connecting', async () => {
    const s = new FakeServer()
    await expect(connect({ transport: s.transport, allowPlaintext: true, apiKey: 'k' })).rejects.toThrow(/database/)
    await expect(connect({ transport: s.transport, database: 'd', allowPlaintext: true })).rejects.toThrow(/credential/)
    await expect(connect({ transport: s.transport, database: 'd', allowPlaintext: true, apiKey: 'k', token: 't' })).rejects.toThrow(/one of/)
    await expect(connect({ transport: s.transport, database: 'd', apiKey: 'k' })).rejects.toThrow(/serverKey/)
    await expect(connect({ transport: s.transport, database: 'd', apiKey: 'k', allowPlaintext: true, pool: 0 })).rejects.toThrow(/pool/)
    expect(s.accepted).toBe(0)
  })
})

describe('subscriptions', () => {
  const change = (seq: number, id: number, v: string, op: number = Op.Insert) => ({ seq, table: 't', tv: 1, op, key: [id], new: op === Op.Delete ? null : [id, v], old: null })
  const shape: Msg = { type: MsgType.Shape, table: 't', tv: 1, columns: ['id', 'v'], pk: ['id'] }
  const batch = (subId: number, checkpoint: number, changes: ReturnType<typeof change>[], o: { reset?: boolean; snapshot?: boolean } = {}): Msg => ({
    type: MsgType.Batch, subId, snapshot: o.snapshot ?? false, reset: o.reset ?? false, checkpoint, epoch: 9n, tables: [], changes,
  })
  /** Confirms subscriptions and records them. */
  function subscribing(s: FakeServer): Req<typeof MsgType.Subscribe>[] {
    const subs: Req<typeof MsgType.Subscribe>[] = []
    s.onMessage = (m, c) => {
      if (m.type === MsgType.Subscribe) {
        subs.push(m)
        c.send(shape)
        c.send({ type: MsgType.Subscribed, reqId: m.reqId, subId: m.subId })
      }
    }
    return subs
  }
  const keys = (u: Update): string => u.changes.map((c) => `${c.op[0]}${c.key[0]}`).join(' ')

  test('changes are delivered only at checkpoints, merged, and acknowledged', async () => {
    const s = new FakeServer()
    const subs = subscribing(s)
    const db = await client(s)
    const sub = await db.subscribe({ table: 't' })
    const id = (subs[0] as Req<typeof MsgType.Subscribe>).subId
    expect(subs[0]).toMatchObject({ kind: 2, table: 't', since: 0, noSnapshot: false })
    s.last.send(batch(id, 0, [change(0, 1, 'a')], { reset: true, snapshot: true }))
    s.last.send(batch(id, 10, [change(0, 2, 'b')], { snapshot: true }))
    const snap = await sub.next()
    expect(snap).toMatchObject({ reset: true, snapshot: true, checkpoint: 10, epoch: 9n })
    expect(keys(snap)).toBe('i1 i2')
    expect(snap.changes[0]).toMatchObject({ columns: ['id', 'v'], pk: ['id'] })

    let done = false
    const pending = sub.next().then((u) => {
      done = true
      return u
    })
    s.last.send(batch(id, 0, [change(11, 3, 'c')])) // no checkpoint yet: half a transaction
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    expect(sub.buffered).toBeGreaterThan(0)
    s.last.send(batch(id, 12, [change(12, 4, 'd')]))
    expect(keys(await pending)).toBe('i3 i4')
    // Calling next again acknowledged checkpoint 10; three steps arriving together merge.
    await until(() => s.last.received.some((m) => m.type === MsgType.Ack && m.checkpoint === 10), 'the ack of 10')
    s.last.send(batch(id, 13, [change(13, 5, 'e')]))
    s.last.send(batch(id, 14, [change(14, 5, 'f', Op.Update)]))
    s.last.send(batch(id, 15, [change(15, 1, '', Op.Delete)]))
    await new Promise((r) => setTimeout(r, 10))
    const merged = await sub.next()
    expect(keys(merged)).toBe('i5 u5 d1')
    expect(merged.checkpoint).toBe(15)
    expect(sub.checkpoint).toEqual({ checkpoint: 15, epoch: 9n })
    expect(sub.buffered).toBe(0)
  })

  test('after a reconnect it resumes from its checkpoint and skips repeats', async () => {
    const s = new FakeServer()
    const subs = subscribing(s)
    const db = await client(s)
    const sub = await db.subscribe({ table: 't' })
    let id = (subs[0] as Req<typeof MsgType.Subscribe>).subId
    s.last.send(batch(id, 20, [change(0, 1, 'a')], { reset: true, snapshot: true }))
    await sub.next()
    s.last.send(batch(id, 0, [change(21, 2, 'b')])) // incomplete: dropped with the connection
    await new Promise((r) => setTimeout(r, 10))
    s.last.drop()
    await until(() => subs.length === 2, 'the resubscribe')
    expect(subs[1]).toMatchObject({ since: 20, epoch: 9n })
    id = (subs[1] as Req<typeof MsgType.Subscribe>).subId
    expect(id).not.toBe((subs[0] as Req<typeof MsgType.Subscribe>).subId)
    // The server replays from 20; a late batch of the old incarnation is ignored.
    s.last.send(batch((subs[0] as Req<typeof MsgType.Subscribe>).subId, 99, [change(99, 9, 'stale')]))
    s.last.send(batch(id, 22, [change(21, 2, 'b'), change(22, 3, 'c')]))
    s.last.send(batch(id, 23, [change(22, 3, 'c'), change(23, 4, 'd')])) // 22 again after a server-side resume
    await new Promise((r) => setTimeout(r, 10))
    const u = await sub.next()
    expect(keys(u)).toBe('i2 i3 i4')
    expect(u.reset).toBe(false)
  })

  test('a lost resume point takes a new snapshot, or fails with manualResync', async () => {
    const s = new FakeServer()
    const subs = subscribing(s)
    const resyncs: string[] = []
    const db = await client(s, { onResync: (_id, reason) => resyncs.push(reason) })
    const auto = await db.subscribe({ table: 't', since: 5, epoch: 9n })
    const manual = await db.subscribe({ table: 't', since: 5, epoch: 9n, manualResync: true })
    expect(subs[0]).toMatchObject({ since: 5, epoch: 9n })
    for (const m of subs.slice(0, 2)) s.last.send({ type: MsgType.SubEnd, subId: m.subId, code: 'gone', message: 'schema changed' })
    await until(() => subs.length === 3, 'the new subscribe')
    expect(subs[2]).toMatchObject({ since: 0, noSnapshot: false })
    s.last.send(batch((subs[2] as Req<typeof MsgType.Subscribe>).subId, 30, [change(0, 1, 'a')], { reset: true, snapshot: true }))
    expect(await auto.next()).toMatchObject({ reset: true, checkpoint: 30 })
    expect(resyncs).toEqual(['schema changed'])
    const err = await manual.next().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ResyncError)
    expect((err as Error).message).toMatch(/schema changed/)
    expect(db.stats.resyncs).toBe(1)
  })

  test('errors at subscribe time are returned; ended subscriptions report why', async () => {
    const s = new FakeServer()
    let n = 0
    s.onMessage = (m, c) => {
      if (m.type !== MsgType.Subscribe) return
      if (m.table === 'secret') c.send(error(m.reqId, 'permission_denied'))
      else if (m.table === 'busy' && ++n < 3) c.send(error(m.reqId, 'unavailable'))
      else c.send({ type: MsgType.Subscribed, reqId: m.reqId, subId: m.subId })
    }
    const db = await client(s)
    await expect(db.subscribe({ table: 'secret' })).rejects.toMatchObject({ code: 'permission_denied' })
    const busy = await db.subscribe({ table: 'busy' }) // retried until the database is back
    expect(n).toBe(3)
    const sub = s.last.received.filter((m) => m.type === MsgType.Subscribe).at(-1) as Req<typeof MsgType.Subscribe>
    s.last.send({ type: MsgType.SubEnd, subId: sub.subId, code: 'invalid', message: 'column dropped' })
    await expect(busy.next()).rejects.toMatchObject({ code: 'invalid' })
    expect(db.stats.subscriptions).toBe(1)
    await busy.close()
    expect(db.stats.subscriptions).toBe(0)
    await expect(db.subscribe({ kind: 'nope' as never })).rejects.toThrow(/unknown subscription kind/)
  })

  test('notify subscriptions report a star after a reconnect', async () => {
    const s = new FakeServer()
    const subs = subscribing(s)
    const db = await client(s)
    const seen: string[][] = []
    const stop = await db.watch(['a', 'b'], (t) => seen.push(t))
    expect(subs[0]).toMatchObject({ kind: 5, tables: ['a', 'b'] })
    s.last.send({ type: MsgType.Batch, subId: (subs[0] as Req<typeof MsgType.Subscribe>).subId, snapshot: false, reset: false, checkpoint: 3, epoch: 0n, tables: ['a'], changes: [] })
    await until(() => seen.length === 1, 'the notification')
    s.last.drop()
    await until(() => seen.length === 2, 'the star')
    expect(seen).toEqual([['a'], ['*']])
    await stop()
    await until(() => s.last.received.some((m) => m.type === MsgType.Unsubscribe), 'the unsubscribe')
  })

  test('next has one consumer; closing wakes it', async () => {
    const s = new FakeServer()
    subscribing(s)
    const db = await client(s)
    const sub = await db.subscribe({ table: 't' })
    const waiting = sub.next()
    await expect(sub.next()).rejects.toThrow(/one consumer/)
    await sub.close()
    await expect(waiting).rejects.toBeInstanceOf(ClosedError)
    const ac = new AbortController()
    const other = await db.subscribe({ table: 't' })
    const aborted = other.next({ signal: ac.signal })
    ac.abort(new Error('stop waiting'))
    await expect(aborted).rejects.toThrow('stop waiting')
  })
})
