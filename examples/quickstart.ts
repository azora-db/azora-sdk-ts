/**
 * Quickstart: connect, read, write, and run several statements atomically.
 *
 *   pnpm dev:engine                                          # terminal 1
 *   node --env-file=examples/.env examples/quickstart.ts     # terminal 2
 */
import { connectEnv, sql } from '@azora-db/client'

interface Order {
  id: number
  customer: number
  status: string
  total: number
  note: string | null
}

// Two values: AZORA_URL says where the database is (public), AZORA_TOKEN who you are (private).
const db = await connectEnv()
console.log(`connected as ${db.session?.principal} (${db.session?.mode}, scopes: ${db.session?.scopes.join(', ')})`)

// Reads return objects keyed by column name.
const open = await db.query<Order>('SELECT * FROM orders WHERE status = ? ORDER BY total DESC', ['open'])
console.log(`${open.length} open orders, largest: ${open[0]?.note} (${open[0]?.total})`)

// The sql tag turns interpolated values into arguments: nothing is spliced into the text.
const customer = 42
const spent = await db.queryValue<number>(sql`SELECT coalesce(sum(total), 0) FROM orders WHERE customer = ${customer}`)
console.log(`customer ${customer} has spent ${spent}`)

// A write applies exactly once, even if the connection drops while it is in flight.
const { lastInsertId } = await db.exec('INSERT INTO orders(customer, status, total, note) VALUES (?, ?, ?, ?)', [customer, 'open', 75.25, 'Footrest'])
console.log(`created order ${lastInsertId}`)

// batch runs statements in one transaction: all of them apply, or none.
const paid = await db.batch([
  sql`UPDATE orders SET status = 'paid' WHERE id = ${lastInsertId}`,
  sql`UPDATE orders SET note = note || ' (paid)' WHERE id = ${lastInsertId}`,
])
console.log(`batch changed ${paid.rowsAffected} rows`)

// A failing statement rolls the whole batch back.
try {
  await db.batch(['DELETE FROM orders', 'INSERT INTO no_such_table VALUES (1)'])
} catch (e) {
  console.log(`batch refused: ${(e as Error).message}`)
}
console.log(`orders are still there: ${await db.queryValue('SELECT count(*) FROM orders')}`)

await db.close()
