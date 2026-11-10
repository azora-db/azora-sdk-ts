/**
 * The shop's units: functions that run inside the `shop` database. Every
 * export made with a helper is a unit named after the export.
 *
 *   azora-units publish examples/units/units        # or: node --env-file=examples/.env examples/units/shop.ts
 */
import { mutation, onChange, query, schedule, UnitError, v, type BaseCtx } from '@azora-db/units'

export interface Order {
  id: number
  customer: number
  status: string
  total: number
  note: string | null
}

interface Cart {
  id: string
  customer: number
  total: number
  note: string | null
}

/** The signed-in customer: the client token's subject is "user:<id>". */
function customerOf(ctx: BaseCtx): number {
  const m = /^user:(\d+)$/.exec(ctx.auth.subject)
  if (!m) throw new UnitError('permission_denied', 'sign in as a customer (a client token with subject user:<id>)')
  return Number(m[1])
}

/** The caller's orders, newest first. A token limited to its own rows cannot run this SQL itself; the unit can. */
export const myOrders = query({
  description: "The signed-in customer's orders, newest first.",
  handler: (ctx) => ctx.db.all<Order>('SELECT id, customer, status, total, note FROM orders WHERE customer = ? ORDER BY id DESC', customerOf(ctx)),
})

/**
 * Turns a cart into an order, atomically: the order is inserted, the cart
 * deleted and an audit line written, or nothing happens. Customers may
 * only check out their own carts; an API key (a backend) may check out any.
 */
export const checkout = mutation({
  description: 'Turns a cart into an open order.',
  args: { cartId: v.string({ min: 1, max: 64 }) },
  async handler(ctx, { cartId }) {
    const cart = ctx.db.one<Cart>('SELECT id, customer, total, note FROM carts WHERE id = ?', cartId)
    if (!cart) throw new UnitError('not_found', 'no such cart', { cartId })
    if (ctx.auth.kind === 'token' && cart.customer !== customerOf(ctx)) throw new UnitError('permission_denied', 'this cart is not yours')
    const { lastInsertId } = ctx.db.exec("INSERT INTO orders(customer, status, total, note) VALUES (?, 'open', ?, ?)", cart.customer, cart.total, cart.note)
    ctx.db.exec('DELETE FROM carts WHERE id = ?', cartId)
    await ctx.run('audit', { what: 'checkout', detail: `cart ${cartId} -> order ${lastInsertId} by ${ctx.auth.principal}` })
    return { orderId: lastInsertId, total: cart.total }
  },
})

/** Writes an audit line. Internal: clients cannot call it, other units can (ctx.run). */
export const audit = mutation({
  internal: true,
  args: { what: v.string(), detail: v.optional(v.string()) },
  handler: (ctx, { what, detail }) => {
    ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', ctx.now(), what, detail ?? null)
  },
})

/** Every new order gets an audit line, exactly once, in the same transaction as the unit's run. */
export const orderPlaced = onChange<Order>({
  table: 'orders',
  ops: ['insert'],
  handler: (ctx, { changes, gap }) => {
    if (gap) ctx.log.warn('some order changes were dropped before this unit saw them')
    for (const c of changes) {
      if (c.new) ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', ctx.now(), 'order placed', `order ${c.new.id} for customer ${c.new.customer}: ${c.new.total}`)
    }
  },
})

/** A summary line every minute. */
export const stats = schedule({
  every: '1m',
  handler: (ctx) => {
    const open = ctx.db.value<number>("SELECT count(*) FROM orders WHERE status = 'open'") ?? 0
    const revenue = ctx.db.value<number>("SELECT coalesce(sum(total), 0) FROM orders WHERE status <> 'open'") ?? 0
    ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', ctx.now(), 'stats', `${open} open orders, ${revenue} paid`)
  },
})
