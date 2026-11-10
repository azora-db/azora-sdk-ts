/**
 * A live view in the terminal: the open orders, kept up to date while a
 * second connection writes. The view only ever shows consistent states.
 *
 *   node --env-file=examples/.env examples/live-orders.ts
 */
import { connect } from '@azora-db/client'

interface Order {
  id: number
  customer: number
  status: string
  total: number
  note: string | null
}

const url = process.env['AZORA_URL']!
const apiKey = process.env['AZORA_API_KEY']!
const db = await connect(url, { apiKey })

// Rows of `orders` with status = 'open', largest first. `live` resolves once they are loaded.
const open = await db.live<Order>('orders', { where: "status = 'open'", orderBy: ['total', 'desc'] })

const render = (): void => {
  console.log(`\n${open.rows.length} open orders, ${open.rows.reduce((s, o) => s + o.total, 0).toFixed(2)} in total`)
  for (const o of open.rows.slice(0, 6)) console.log(`  #${String(o.id).padEnd(4)} customer ${String(o.customer).padEnd(3)} ${o.total.toFixed(2).padStart(8)}  ${o.note ?? ''}`)
}
render()
open.subscribe(({ changes }) => {
  for (const c of changes) console.log(`  ${c.op.padEnd(6)} #${c.key[0]}${c.op === 'update' ? `: ${c.previous?.total.toFixed(2)} -> ${c.row?.total.toFixed(2)}` : ''}`)
  render()
})

// Someone else changes the data: another connection, as another process would.
const writer = await connect(url, { apiKey })
const notes = ['Laptop stand', 'USB-C dock', 'Desk lamp', 'Webcam', 'Keyboard tray']
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 400))
  const { lastInsertId } = await writer.exec('INSERT INTO orders(customer, status, total, note) VALUES (?, ?, ?, ?)', [100 + i, 'open', 20 + i * 35.5, notes[i]!])
  if (i % 2 === 1) {
    // One transaction, one event: the price change and the payment of another order arrive together.
    await writer.batch([
      ['UPDATE orders SET total = total * 0.9 WHERE id = ?', [lastInsertId]],
      ['UPDATE orders SET status = ? WHERE id = (SELECT min(id) FROM orders WHERE status = ?)', ['paid', 'open']],
    ])
  }
}
await new Promise((r) => setTimeout(r, 300))

// The local rows can be checked against the server at any time.
const check = await open.verify()
console.log(`\nchecksum over ${check.localRows} rows matches the server: ${check.match}`)

await open.close()
await writer.close()
await db.close()
