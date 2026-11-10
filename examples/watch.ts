/**
 * Keeping an aggregate fresh: `watch` tells when tables were written (any
 * table, no rows sent), and the query runs again.
 *
 *   node --env-file=examples/.env examples/watch.ts
 */
import { connectEnv } from '@azora-db/client'

const db = await connectEnv() // AZORA_URL and AZORA_TOKEN

const report = async (): Promise<void> => {
  const rows = await db.query<{ status: string; orders: number; revenue: number }>(
    'SELECT status, count(*) AS orders, round(sum(total), 2) AS revenue FROM orders GROUP BY status ORDER BY status',
  )
  console.log(rows.map((r) => `${r.status}: ${r.orders} (${r.revenue})`).join('   '))
}

await report()
const stop = await db.watch(['orders'], () => void report())

for (const status of ['open', 'paid', 'shipped']) {
  await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [1, status, 10])
  await new Promise((r) => setTimeout(r, 200))
}

await stop()
await db.close()
