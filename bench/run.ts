/**
 * Benchmarks against a local engine it starts itself, with the engine's
 * per-connection request rate limit (realtime.message_rate, 1,000/s by
 * default) lifted so the numbers measure the SDK and the engine, not the
 * limit:
 *
 *   pnpm bench
 *
 * Numbers depend on the machine; the engine and the client share it here.
 */
import { connect, type Database } from '@azora-db/client'
import { DEFAULT_SCHEMA, startEngine } from '../test/helpers/engine.ts'

const engine = await startEngine({ schema: DEFAULT_SCHEMA, realtime: { message_rate: 100_000_000, message_burst: 100_000_000 } })
const url = `${engine.tcpUrl}?key=${engine.serverKey}`
const ws = `${engine.wsUrl}?db=shop&key=${engine.serverKey}`
const apiKey = engine.apiKey

async function rate(name: string, seconds: number, concurrency: number, fn: () => Promise<unknown>): Promise<void> {
  const end = performance.now() + seconds * 1000
  let n = 0
  const lat: number[] = []
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        const t = performance.now()
        await fn()
        lat.push(performance.now() - t)
        n++
      }
    }),
  )
  lat.sort((a, b) => a - b)
  const p = (q: number): string => (lat[Math.floor(lat.length * q)] ?? 0).toFixed(2)
  console.log(`${name.padEnd(46)} ${Math.round(n / seconds).toLocaleString('en-US').padStart(9)} /s   p50 ${p(0.5)} ms   p99 ${p(0.99)} ms`)
}

const db = await connect(url, { apiKey })
await db.exec('CREATE TABLE IF NOT EXISTS bench(id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c REAL)')
await db.exec('DELETE FROM bench')
for (let i = 0; i < 10; i++) {
  await db.batch(Array.from({ length: 1000 }, (_, j) => ['INSERT INTO bench(a, b, c) VALUES (?, ?, ?)', [i * 1000 + j, `row number ${i * 1000 + j}`, j / 7]] as const))
}
const point = (d: Database) => () => d.queryOne('SELECT * FROM bench WHERE id = ?', [1 + Math.floor(Math.random() * 10_000)])

console.log(`node ${process.version}, engine and client on one machine\n`)
await rate('point read, TCP, 1 at a time', 3, 1, point(db))
await rate('point read, TCP, 64 concurrent', 3, 64, point(db))
const pooled = await connect(url, { apiKey, pool: 4 })
await rate('point read, TCP pool of 4, 64 concurrent', 3, 64, point(pooled))
await pooled.close()
const web = await connect(ws, { apiKey })
await rate('point read, WebSocket, 64 concurrent', 3, 64, point(web))
await web.close()
const plain = await connect(url.replace(/\?.*/, '?plaintext=1'), { apiKey })
await rate('point read, TCP plaintext, 64 concurrent', 3, 64, point(plain))
await plain.close()
await rate('1,000-row read as objects', 3, 4, () => db.query('SELECT * FROM bench LIMIT 1000'))
await rate('1,000-row read as arrays (queryRaw)', 3, 4, () => db.queryRaw('SELECT * FROM bench LIMIT 1000'))
await rate('single-row write (exactly once), 16 concurrent', 3, 16, () => db.exec('UPDATE bench SET a = a + 1 WHERE id = ?', [1 + Math.floor(Math.random() * 10_000)]))
await rate('10-statement batch', 3, 4, () => db.batch(Array.from({ length: 10 }, (_, j) => ['UPDATE bench SET c = ? WHERE id = ?', [j, j + 1]] as const)))

// Change latency: commit on one connection to delivery on a live query of another.
const live = await db.live('orders', { where: "status = 'bench'" })
const writer = await connect(url, { apiKey })
const lat: number[] = []
for (let i = 0; i < 300; i++) {
  const seen = new Promise<void>((resolve) => {
    const off = live.subscribe(() => {
      off()
      resolve()
    })
  })
  const t = performance.now()
  await writer.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [i, 'bench', i])
  await seen
  lat.push(performance.now() - t)
}
lat.sort((a, b) => a - b)
console.log(`${'write to live-query delivery (incl. the write)'.padEnd(46)} p50 ${lat[150]!.toFixed(2)} ms   p99 ${lat[297]!.toFixed(2)} ms`)
await writer.exec("DELETE FROM orders WHERE status = 'bench'")
await live.close()
await writer.close()
await db.exec('DROP TABLE bench')
console.log(`\nrequests the server rate-limited: ${db.stats.rateLimited}`)
await db.close()
await engine.stop()
