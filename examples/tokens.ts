/**
 * What a browser or mobile app does: connect with a short-lived token
 * minted by your backend. This token is pinned to customer 42's orders,
 * so the server filters every subscription and refuses SQL.
 *
 *   node --env-file=examples/.env examples/tokens.ts
 */
import { connect, isCode } from '@azora-db/client'

// Your backend returns a fresh token for the signed-in user; here the
// dev engine minted one (`azora realtime token create shop --sub user:42
// --table orders --filter "orders: customer = 42"`).
const fetchToken = async (): Promise<string> => process.env['AZORA_TOKEN_CUSTOMER42']!

// The function runs on every (re)connect and when the server says the
// token expired, so the connection outlives any single token.
const app = await connect(process.env['AZORA_WS_URL']!, { token: fetchToken })
console.log(`connected as ${app.session?.principal}, scopes: ${app.session?.scopes.join(', ')}`)

const mine = await app.live<{ id: number; customer: number; status: string; total: number }>('orders')
console.log(`this user sees ${mine.size} orders, all theirs: ${mine.rows.every((o) => o.customer === 42)}`)
mine.subscribe(({ changes }) => {
  for (const c of changes) console.log(`  ${c.op} order #${c.key[0]} (customer ${c.row?.customer ?? c.previous?.customer})`)
})

// The backend (API key) writes orders for two customers; only customer 42's arrives.
const backend = await connect(process.env['AZORA_URL']!, { apiKey: process.env['AZORA_API_KEY']! })
await backend.exec('INSERT INTO orders(customer, status, total, note) VALUES (?, ?, ?, ?)', [7, 'open', 15, 'not yours'])
await backend.exec('INSERT INTO orders(customer, status, total, note) VALUES (?, ?, ?, ?)', [42, 'open', 15, 'yours'])
await new Promise((r) => setTimeout(r, 300))

// SQL is refused for a token limited to tables or filters.
try {
  await app.query('SELECT * FROM orders')
} catch (e) {
  console.log(`SQL with this token: ${isCode(e, 'permission_denied') ? 'permission denied, as intended' : e}`)
}

await mine.close()
await app.close()
await backend.close()
