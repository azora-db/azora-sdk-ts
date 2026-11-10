import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connect, type Database } from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

interface Order {
  id: number
  customer: number
  status: string
  total: number
}

describe.skipIf(!engineBinary())('reconnects, credentials and pools', () => {
  let engine: Engine

  beforeAll(async () => {
    engine = await startEngine({
      tokens: {
        reader: ['--sub', 'user:42', '--scope', 'read', '--ttl', '1h', '--table', 'orders', '--filter', 'orders: customer = 42'],
      },
    })
  })
  afterAll(async () => {
    await engine?.stop()
  })

  for (const transport of ['tcp', 'websocket'] as const) {
    test(`a server restart loses and duplicates nothing (${transport})`, async () => {
      const url = transport === 'tcp' ? `${engine.tcpUrl}?key=${engine.serverKey}` : `${engine.wsUrl}?db=shop&key=${engine.serverKey}`
      const events: string[] = []
      const db = await connect(url, {
        apiKey: engine.apiKey,
        reconnectMinMs: 20,
        reconnectMaxMs: 200,
        onConnect: () => events.push('connect'),
        onDisconnect: () => events.push('disconnect'),
        onError: () => {},
      })
      const tag = `restart-${transport}`
      const live = await db.live<Order>('orders', { where: `status = '${tag}'` })
      let resets = 0
      live.subscribe((ev) => {
        if (ev.reset) resets++
      })
      for (let i = 0; i < 20; i++) await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [i, tag, i])
      await until(() => live.size === 20, 'the first 20 rows')

      await engine.stop()
      await until(() => !db.connected, 'the disconnect')
      // Writes made while the server is down wait for it and then apply once.
      const queued = Array.from({ length: 10 }, (_, i) =>
        db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [100 + i, tag, 100 + i]),
      )
      const read = db.queryValue<number>('SELECT 1')
      await new Promise((r) => setTimeout(r, 150))
      await engine.start()
      const results = await Promise.all(queued)
      expect(results.every((r) => r.rowsAffected === 1)).toBe(true)
      expect(await read).toBe(1)
      for (let i = 0; i < 5; i++) await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [200 + i, tag, 200 + i])

      await until(() => live.size === 35, 'all 35 rows')
      const want = await db.query<Order>('SELECT id, customer, status, total, note FROM orders WHERE status = ? ORDER BY id', [tag])
      expect(want).toHaveLength(35)
      expect(live.rows).toEqual(want)
      expect(resets).toBe(0) // resumed from its checkpoint: no new snapshot
      expect((await live.verify()).match).toBe(true)
      expect(events.slice(0, 3)).toEqual(['connect', 'disconnect', 'connect'])
      expect(db.stats).toMatchObject({ connected: true, disconnects: 1 })
      await db.close()
    })
  }

  test('a write retried with the same id across a restart applies once', async () => {
    const db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey, reconnectMinMs: 20, reconnectMaxMs: 100, onError: () => {} })
    const mutationId = `persisted-${Date.now()}`
    const first = await db.exec('INSERT INTO plain(v) VALUES (?)', ['exactly-once'], { mutationId })
    await engine.restart()
    // The application "restarted" too and replays its queue with the id it had stored.
    const again = await db.exec('INSERT INTO plain(v) VALUES (?)', ['exactly-once'], { mutationId })
    expect(again).toMatchObject({ replayed: true, lastInsertId: first.lastInsertId })
    expect(await db.queryValue('SELECT count(*) FROM plain WHERE v = ?', ['exactly-once'])).toBe(1)
    await db.close()
  })

  test('a token with a pinned filter sees only its rows and cannot run SQL', async () => {
    const admin = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    await admin.batch([
      ['INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [42, 'mine', 1]],
      ['INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [43, 'theirs', 2]],
    ])
    const user = await connect(`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, { token: engine.tokens['reader'] as string })
    expect(user.session).toMatchObject({ principal: 'user:42', scopes: ['read'] })
    const mine = await user.live<Order>('orders')
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.every((o) => o.customer === 42)).toBe(true)
    const before = mine.size
    await admin.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [43, 'theirs', 3])
    await admin.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [42, 'mine', 4])
    await until(() => mine.size === before + 1, 'the row of customer 42')
    expect(mine.rows.every((o) => o.customer === 42)).toBe(true)
    await expect(user.query('SELECT * FROM orders')).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(user.exec('DELETE FROM orders')).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(user.subscribe({ table: 'items' })).rejects.toMatchObject({ code: 'permission_denied' })
    await mine.close()
    await user.close()
    await admin.close()
  })

  test('an expired token is refreshed on the open connection', async () => {
    // Tokens are minted by the CLI, which needs the data-root lock: stop the server for it.
    await engine.stop()
    const mint = (ttl: string): string =>
      (JSON.parse(engine.cli('realtime', 'token', 'create', 'shop', '--sub', 'user:7', '--scope', 'read,write', '--ttl', ttl, '--json')) as { token: string }).token
    const short = mint('3s')
    const long = mint('1h')
    await engine.start()
    let calls = 0
    const db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, {
      token: () => (++calls === 1 ? short : long),
      onError: () => {},
    })
    expect(calls).toBe(1)
    const session = db.session?.sessionId
    const live = await db.live<Order>('orders', { where: "status = 'refresh'" })
    await new Promise((r) => setTimeout(r, 3600)) // the first token expires
    await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [7, 'refresh', 1])
    await until(() => live.size === 1, 'the change after the refresh')
    expect(calls).toBe(2)
    expect(db.stats.credentialRefreshes).toBe(1)
    expect(db.session?.sessionId).toBe(session) // same connection
    expect(db.stats.disconnects).toBe(0)
    await db.close()
  }, 20_000)

  test('setCredential swaps the credential in place', async () => {
    const db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.readKey })
    await expect(db.exec('INSERT INTO plain(v) VALUES (1)')).rejects.toMatchObject({ code: 'permission_denied' })
    await db.setCredential(engine.apiKey)
    expect((await db.exec('INSERT INTO plain(v) VALUES (?)', ['swapped'])).rowsAffected).toBe(1)
    await expect(db.setCredential('azk_bad_bad')).rejects.toMatchObject({ code: 'unauthenticated' })
    await db.close()
  })

  test('a pool spreads requests over its connections', async () => {
    const db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey, pool: 4 })
    expect(db.stats.connects).toBe(4)
    const sessions = new Set<number>()
    const out = await Promise.all(
      Array.from({ length: 400 }, async (_, i) => {
        const v = await db.queryValue<number>('SELECT ? + 1', [i])
        sessions.add(v as number)
        return v
      }),
    )
    expect(out).toEqual(Array.from({ length: 400 }, (_, i) => i + 1))
    const live = await db.live('orders', { where: "status = 'pool'" })
    await db.exec('INSERT INTO orders(customer, status, total) VALUES (1, ?, 1)', ['pool'])
    await until(() => live.size === 1, 'the change on the pooled client')
    await db.close()
    expect(db.closed).toBe(true)
  })
})
