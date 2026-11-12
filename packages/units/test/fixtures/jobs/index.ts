/** Units that schedule each other with a scheduler typed from this module (type tests). */
import { action, mutation, v, type Scheduler } from '@azora-db/units'

type Units = typeof import('./index.ts')

export const placeOrder = mutation({
  args: { cartId: v.string() },
  handler(ctx, { cartId }) {
    const scheduler = ctx.scheduler as Scheduler<Units>
    // Annotated: the id flows into the result, and the scheduler's type reads this module's.
    const reminder: string = scheduler.after(24 * 3600e3, 'remindUnpaid', { orderId: 1 })
    scheduler.at(new Date(), 'tick')
    // @ts-expect-error orderId is a number
    scheduler.after(0, 'remindUnpaid', { orderId: 'x' })
    // @ts-expect-error remindUnpaid takes arguments
    scheduler.after(0, 'remindUnpaid')
    // @ts-expect-error no such unit
    scheduler.after(0, 'nope')
    return { cartId, reminder }
  },
})

export const remindUnpaid = action({ internal: true, args: { orderId: v.number() }, handler: async () => {} })

export const tick = mutation({ internal: true, handler: (ctx) => ctx.unit.job?.attempt ?? 0 })
