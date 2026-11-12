/**
 * The shop's units, tested locally: no engine, an in-memory SQLite
 * database with the engine's rules (@azora-db/units/testing).
 *
 *   pnpm build              # once, at the repository root
 *   pnpm test               # here: node --test shop.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UnitError } from '@azora-db/client'
import { createTestEnv } from '@azora-db/units/testing'
import * as units from './units/index.ts'

const schema = [
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)',
  "INSERT INTO carts(id, customer, total, note) VALUES ('c42', 42, 89.5, 'Monitor light bar'), ('c7', 7, 12, 'Cable ties')",
]

/** A signed-in customer 42 (a client token with subject user:42), on a fixed clock. */
const shop = () => createTestEnv(units, { schema, auth: { subject: 'user:42' }, now: Date.UTC(2026, 10, 10, 9, 0) })

test('checkout turns the cart into an order, atomically', async () => {
  const t = shop()
  const { orderId, total } = await t.call('checkout', { cartId: 'c42' })
  assert.equal(total, 89.5)
  assert.deepEqual(t.db.one('SELECT customer, status FROM orders WHERE id = ?', orderId), { customer: 42, status: 'open' })
  assert.equal(t.db.value("SELECT count(*) FROM carts WHERE id = 'c42'"), 0)
  assert.deepEqual(await t.units.myOrders(), [{ id: orderId, customer: 42, status: 'open', total: 89.5, note: 'Monitor light bar' }])
})

test("someone else's cart is refused, and nothing changes", async () => {
  const t = shop()
  await assert.rejects(t.call('checkout', { cartId: 'c7' }), (e) => e instanceof UnitError && e.code === 'permission_denied')
  assert.equal(t.db.value('SELECT count(*) FROM orders'), 0)
  // A backend (an API key) may check out any cart.
  await t.call('checkout', { cartId: 'c7' }, { auth: { kind: 'key', principal: 'key:backend' } })
  assert.equal(t.db.value('SELECT count(*) FROM orders'), 1)
})

test('arguments are checked before the unit runs', async () => {
  const t = shop()
  await assert.rejects(t.call('checkout', { cartId: '' }), /args\.cartId: must be at least 1 characters/)
  assert.equal(t.runs().at(-1)?.status, 'rejected')
})

test('a reminder job runs a day later, unless the cart was checked out', async () => {
  const t = shop()
  const { jobId } = await t.call('remindCart', { cartId: 'c42' })
  assert.equal(t.jobs()[0]?.id, jobId)
  await t.advance(23 * 3600e3)
  assert.equal(t.db.value("SELECT count(*) FROM audit WHERE what = 'reminder'"), 0)
  await t.advance(3600e3)
  assert.equal(t.db.value("SELECT detail FROM audit WHERE what = 'reminder'"), `cart c42 of customer 42 is waiting (${jobId})`)

  await t.call('remindCart', { cartId: 'c42', minutes: 60 })
  await t.call('checkout', { cartId: 'c42' })
  await t.advance(3600e3) // the job runs and finds no cart
  assert.equal(t.db.value("SELECT count(*) FROM audit WHERE what = 'reminder'"), 1)
  assert.deepEqual(t.jobs(), [])
})

test('the schedule and the onChange unit, run by hand', async () => {
  const t = shop()
  await t.runSchedule('stats')
  assert.match(t.db.value<string>("SELECT detail FROM audit WHERE what = 'stats'") ?? '', /^0 open orders/)
  await t.change('orderPlaced', [{ op: 'insert', new: { id: 1, customer: 42, status: 'open', total: 10, note: null } }])
  assert.equal(t.db.value("SELECT detail FROM audit WHERE what = 'order placed'"), 'order 1 for customer 42: 10')
})
