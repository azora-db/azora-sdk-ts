/**
 * Units end to end: publish the shop's units, then call them as a backend
 * (the API key) and as a signed-in customer (a client token pinned to
 * customer 42's rows, which cannot run SQL but can call units), schedule
 * jobs, and read the run log. shop.test.ts tests the same units locally,
 * without an engine (pnpm test in this directory).
 *
 *   pnpm install && pnpm build                                       # once
 *   pnpm dev:engine                                                  # terminal 1
 *   node --env-file=examples/.env examples/units/shop.ts             # terminal 2
 */
import { connect, connectEnv, isCode, UnitError } from '@azora-db/client'
import { publishUnits } from '@azora-db/units/tools'

type Shop = typeof import('./units/index.ts')

// The backend: AZORA_TOKEN is an API key with the ddl scope, which publishing needs.
const backend = await connectEnv<Shop>()
const published = await publishUnits(backend, new URL('./units', import.meta.url).pathname, { note: 'examples/units/shop.ts' })
console.log(
  published.unchanged
    ? `units unchanged: version ${published.version} is active`
    : `published version ${published.version}: ${published.units.map((u) => `${u.name} (${u.kind}${u.internal ? ', internal' : ''})`).join(', ')}`,
)

// Two carts: one of customer 42's, one of customer 7's.
const run = Date.now().toString(36)
await backend.batch([
  ['INSERT INTO carts(id, customer, total, note) VALUES (?, 42, 89.5, ?)', [`c42-${run}`, 'Monitor light bar']],
  ['INSERT INTO carts(id, customer, total, note) VALUES (?, 7, 12, ?)', [`c7-${run}`, 'Cable ties']],
])

// The customer's app: the same public URL, a client token for user:42.
const app = await connect<Shop>(process.env['AZORA_URL']!, { token: process.env['AZORA_TOKEN_CUSTOMER42']! })
console.log(`\nconnected as ${app.session?.principal} (scopes: ${app.session?.scopes.join(', ')})`)

try {
  await app.query('SELECT * FROM orders')
} catch (e) {
  console.log(`db.query with this token: ${isCode(e, 'permission_denied') ? 'refused, as intended' : e}`)
}

// Units are typed from ./units/index.ts: checkout takes { cartId: string } and returns { orderId, total }.
const { orderId, total } = await app.units.checkout({ cartId: `c42-${run}` })
console.log(`db.units.checkout with this token: order ${orderId} (${total})`)

try {
  await app.units.checkout({ cartId: `c7-${run}` })
} catch (e) {
  if (!(e instanceof UnitError)) throw e
  console.log(`someone else's cart: ${e.code}: ${e.message}`)
}

const mine = await app.units.myOrders()
console.log(`myOrders: ${mine.length} orders, all customer 42's: ${mine.every((o) => o.customer === 42)}`)

// The backend may check out any cart; myOrders needs a customer.
const other = await backend.units.checkout({ cartId: `c7-${run}` })
console.log(`\nthe backend checked out customer 7's cart: order ${other.orderId}`)
try {
  await backend.units.myOrders()
} catch (e) {
  if (e instanceof UnitError) console.log(`myOrders with the API key: ${e.code}: ${e.message}`)
}

// Jobs: remindCart schedules cartReminder (ctx.scheduler). One now, which
// the engine runs within a second; one in an hour, which waits (and is
// cancelled here, as `npx azora-units jobs cancel <id>` would).
await backend.batch([['INSERT INTO carts(id, customer, total, note) VALUES (?, 42, 30, ?)', [`r42-${run}`, 'Desk lamp']]])
const now = await app.units.remindCart({ cartId: `r42-${run}`, minutes: 0 })
const later = await app.units.remindCart({ cartId: `r42-${run}`, minutes: 60 })
console.log(`\nscheduled reminders: ${now.jobId} (now) and ${later.jobId} (in an hour)`)
const { jobs, pending } = await backend.unitsAdmin.jobs.list()
for (const j of jobs) console.log(`  ${j.id} ${j.unit} ${j.state}, due ${new Date(j.runAt).toISOString()} (from ${j.source}, by ${j.createdBy})`)
console.log(`  ${pending} waiting; cancelling the later one: ${await backend.unitsAdmin.jobs.cancel(later.jobId)}`)

// The checkout's audit line, the onChange unit's and the reminder job's arrive in the audit table.
await new Promise((r) => setTimeout(r, 1500))
const lines = await backend.query<{ what: string; detail: string }>('SELECT what, detail FROM audit ORDER BY id DESC LIMIT 5')
console.log('\naudit:')
for (const l of lines.reverse()) console.log(`  ${l.what}: ${l.detail}`)

// The run log (also: npx azora-units logs).
const runs = await backend.unitsAdmin.runs({ limit: 6 })
console.log('\nrecent runs:')
for (const r of runs.reverse()) console.log(`  ${r.status.padEnd(8)} ${r.unit} (${r.trigger}, ${r.principal}, ${r.durationMs} ms)${r.error ? `: ${r.error}` : ''}`)

await app.close()
await backend.close()
