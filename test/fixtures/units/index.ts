/** Units for the integration tests: the example shop's, and a few that probe the engine. */
import { mutation, query, UnitError, v } from '@azora-db/units'

export * from '../../../examples/units/units/index.ts'

/** Returns its argument (blobs included). */
export const echo = query({ args: v.any(), handler: (_ctx, a) => a })

/** Who called, as the unit sees it. */
export const whoami = query({
  handler: (ctx) => ({ kind: ctx.auth.kind, principal: ctx.auth.principal, subject: ctx.auth.subject, unit: ctx.unit.name, trigger: ctx.unit.trigger }),
})

/** Counts its runs: a retried call with the same mutation id must not count twice. */
export const bump = mutation({
  args: { by: v.int({ min: 1 }) },
  handler: (ctx, { by }) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET n = n + excluded.n', by)
    return { n: ctx.db.value<number>('SELECT n FROM counter WHERE id = 1'), mutationId: ctx.unit.mutationId }
  },
})

/** Writes, then throws: the write must roll back. */
export const boom = mutation({
  handler: (ctx) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (99, 1)')
    throw new Error('boom')
  },
})

/** Throws a UnitError with data. */
export const refuse = query({ handler: () => { throw new UnitError('conflict', 'already paid', { order: 7 }) } })

/** Whether a secret is set (never its value). */
export const hasSecret = query({ args: { name: v.string() }, handler: (ctx, { name }) => ctx.env[name] !== undefined })
