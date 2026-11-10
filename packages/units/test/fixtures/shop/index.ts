import { mutation, onChange, query, schedule, UnitError, v } from '@azora-db/units'
import { TAX } from './tax.ts'

export const myOrders = query({
  description: 'the caller’s orders',
  handler: (ctx) => ctx.db.all('SELECT * FROM orders WHERE customer = ?', ctx.auth.subject),
})

export const checkout = mutation({
  args: { cartId: v.string({ min: 1 }), note: v.optional(v.string()) },
  handler(ctx, { cartId }) {
    const cart = ctx.db.one<{ owner: string; total: number }>('SELECT * FROM carts WHERE id = ?', cartId)
    if (!cart) throw new UnitError('not_found', 'no such cart', { cartId })
    const { lastInsertId } = ctx.db.exec('INSERT INTO orders(customer, total) VALUES (?, ?)', cart.owner, cart.total * (1 + TAX))
    return { orderId: lastInsertId }
  },
})

export const audit = mutation({ internal: true, args: { what: v.string() }, handler: (ctx, { what }) => ctx.db.exec('INSERT INTO audit(what) VALUES (?)', what) })
export const nightly = schedule({ cron: '0 3 * * *', handler: () => {} })
export const paid = onChange({ table: 'orders', ops: ['update'], mode: 'action', handler: async () => {} })
export const notAUnit = 42
