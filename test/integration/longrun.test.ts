import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { openChannel } from '../../src/channel.ts'
import { decodeServerKey } from '../../src/config.ts'
import { connect } from '../../src/index.ts'
import { decode, encode, MsgType } from '../../src/messages.ts'
import { connectTCP } from '../../src/platform/tcp.node.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

describe.skipIf(!engineBinary())('long-running connections', () => {
  let engine: Engine

  beforeAll(async () => {
    // Lift the per-connection message rate: the rekey test sends over a million frames.
    engine = await startEngine({ realtime: { message_rate: 100_000_000, message_burst: 100_000_000 } })
  })
  afterAll(async () => {
    await engine?.stop()
  })

  test('both directions rekey after 2^20 frames exactly as the server does', async () => {
    const t = await connectTCP(engine.host, engine.port, new AbortController().signal)
    const ch = await openChannel(t, { serverKey: decodeServerKey(engine.serverKey) })
    let pongs = 0
    let failure: Error | undefined
    const answers: unknown[] = []
    ch.onClose = (e) => (failure = e ?? new Error('closed'))
    ch.onMessage = (raw) => {
      const m = decode(raw)
      if (m.type === MsgType.Pong) pongs++
      else if (m.type !== MsgType.Ping) answers.push(m)
    }
    ch.send(encode({ type: MsgType.Hello, version: 1, database: 'shop', credential: engine.apiKey, client: 'rekey-test' }))
    await until(() => answers.length === 1, 'the welcome')
    // Each ping is one frame out and one pong frame back: past 2^20 both
    // cipher states have rekeyed, and anything after decrypts only if the
    // client derived the same new keys as the server.
    const total = (1 << 20) + 5000
    for (let sent = 0; sent < total; ) {
      const n = Math.min(20_000, total - sent)
      for (let i = 0; i < n; i++) ch.send(encode({ type: MsgType.Ping, nonce: sent + i }))
      sent += n
      await until(() => pongs >= sent - 2000 || failure !== undefined, 'pongs to catch up', 30_000)
      if (failure) throw failure
    }
    await until(() => pongs === total || failure !== undefined, 'every pong', 30_000)
    expect(failure).toBeUndefined()
    ch.send(encode({ type: MsgType.Query, reqId: 1, sql: 'SELECT ?', args: ['after the rekey'], maxRows: 0 }))
    await until(() => answers.length === 2 || failure !== undefined, 'the query after rekeying')
    expect(answers[1]).toMatchObject({ type: MsgType.Result, rows: [['after the rekey']] })
    ch.close()
  }, 180_000)

  test('a crashed server (no goodbye) is survived the same way', async () => {
    const db = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey, reconnectMinMs: 20, reconnectMaxMs: 100, onError: () => {} })
    const live = await db.live('orders', { where: "status = 'crash'" })
    for (let i = 0; i < 10; i++) await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [i, 'crash', i])
    await until(() => live.size === 10, 'the rows before the crash')
    await engine.kill()
    const queued = db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [99, 'crash', 99])
    await until(() => db.stats.connectFailures >= 2, 'failed reconnects while the server is gone')
    await engine.start()
    expect((await queued).rowsAffected).toBe(1)
    await until(() => live.size === 11, 'the row written after the crash')
    expect(await db.queryValue('SELECT count(*) FROM orders WHERE status = ?', ['crash'])).toBe(11)
    expect((await live.verify()).match).toBe(true)
    await db.close()
  }, 60_000)
})
