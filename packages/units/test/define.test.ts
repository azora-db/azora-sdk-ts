import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  action, isUnitDefinition, isUnitName, mutation, onChange, query, schedule, UnitError, v, type JobInfo, type MutationCtx, type QueryCtx, type UnitBrand,
} from '../src/index.ts'

type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never

describe('definitions', () => {
  test('are the plain objects of the bundle format', () => {
    const handler = (): number => 1
    expect(query({ handler })).toEqual({ '~azora': 1, kind: 'query', handler, args: null, internal: false, description: '' })
    expect(mutation({ args: { a: v.string() }, internal: true, description: 'd', handler })).toEqual({
      '~azora': 1, kind: 'mutation', handler, internal: true, description: 'd',
      args: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    })
    expect(action({ args: v.string(), handler })).toMatchObject({ '~azora': 1, kind: 'action', args: { type: 'string' }, internal: false })
    expect(schedule({ cron: '0 3 * * *', handler })).toEqual({
      '~azora': 1, kind: 'schedule', handler, args: null, internal: true, description: '', mode: 'mutation', cron: '0 3 * * *', every: '',
    })
    expect(schedule({ every: '1h30m', mode: 'action', handler })).toMatchObject({ mode: 'action', cron: '', every: '1h30m', internal: true })
    expect(onChange({ table: 'orders', handler })).toEqual({
      '~azora': 1, kind: 'onChange', handler, args: null, internal: true, description: '', mode: 'mutation', table: 'orders',
      ops: ['insert', 'update', 'delete'], batch: 100,
    })
    expect(onChange({ table: 'orders', ops: ['update'], batch: 10, mode: 'action', handler })).toMatchObject({ ops: ['update'], batch: 10, mode: 'action' })
    expect(isUnitDefinition(query({ handler }))).toBe(true)
    expect(isUnitDefinition({ kind: 'query' })).toBe(false)
  })

  test('mistakes fail at definition time', () => {
    const handler = (): void => {}
    expect(() => query({} as never)).toThrow(/needs a handler/)
    expect(() => schedule({ handler })).toThrow(/one of cron or every/)
    expect(() => schedule({ cron: '* * * * *', every: '5m', handler })).toThrow(/one of cron or every/)
    expect(() => schedule({ every: 'often', handler })).toThrow(/not a duration/)
    expect(() => onChange({ table: '', handler })).toThrow(/needs a table/)
    expect(() => onChange({ table: 't', batch: 0, handler })).toThrow(/batch 0/)
    expect(() => onChange({ table: 't', ops: ['upsert' as never], handler })).toThrow(/unknown op "upsert"/)
  })

  test('unit names', () => {
    for (const n of ['a', 'checkout', 'my_orders2', 'A'.repeat(64)]) expect(isUnitName(n), n).toBe(true)
    for (const n of ['', '1a', '_a', 'a-b', 'A'.repeat(65), 'é']) expect(isUnitName(n), n).toBe(false)
  })

  test('UnitError carries code, message, data and its name', () => {
    const e = new UnitError('not_found', 'no such cart', { cartId: 'c1' })
    expect(e).toBeInstanceOf(Error)
    expect(e).toMatchObject({ name: 'UnitError', code: 'not_found', message: 'no such cart', data: { cartId: 'c1' } })
    expect(Object.hasOwn(e, 'name')).toBe(true) // survives a renamed class
  })

  test('handler args are typed from the validators, the brand from the handler', () => {
    const checkout = mutation({
      args: { cartId: v.string(), qty: v.optional(v.int()) },
      handler(ctx, args) {
        expectTypeOf(ctx).toEqualTypeOf<MutationCtx>()
        expectTypeOf(args).toEqualTypeOf<{ cartId: string; qty?: number | undefined }>()
        return { orderId: 1 }
      },
    })
    expectTypeOf<BrandOf<typeof checkout>>().toEqualTypeOf<UnitBrand<'mutation', { cartId: string; qty?: number | undefined }, { orderId: number }, false>>()

    const asyncQuery = query({
      handler: async (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<QueryCtx>()
        return ctx.db.all<{ id: number }>('SELECT id FROM t')
      },
    })
    expectTypeOf<BrandOf<typeof asyncQuery>>().toEqualTypeOf<UnitBrand<'query', unknown, { id: number }[], false>>()

    const helper = mutation({ internal: true, handler: (_ctx, a: { n: number }) => a.n })
    expectTypeOf<BrandOf<typeof helper>>().toEqualTypeOf<UnitBrand<'mutation', { n: number }, number, true>>()

    const act = action({ args: v.string(), handler: async (ctx, url) => (await ctx.fetch(url)).status })
    expectTypeOf<BrandOf<typeof act>>().toEqualTypeOf<UnitBrand<'action', string, number, false>>()

    // A query's ctx cannot write; ctx in a schedule follows its mode.
    // @ts-expect-error exec is not on a query's db
    query({ handler: (ctx) => ctx.db.exec('DELETE FROM t') })
    schedule({ every: '5m', mode: 'action', handler: (ctx) => void ctx.fetch('https://example.com') })
    // @ts-expect-error fetch is for actions
    schedule({ every: '5m', handler: (ctx) => void ctx.fetch('https://example.com') })
    onChange<{ id: number; status: string }>({
      table: 'orders',
      handler: (_ctx, { changes, gap }) => {
        expectTypeOf(changes[0]!.new).toEqualTypeOf<{ id: number; status: string } | null>()
        expectTypeOf(gap).toEqualTypeOf<boolean>()
      },
    })
  })
})

describe('jobs', () => {
  test('ctx.scheduler is on mutations and actions, typed by name and arguments when given the module', async () => {
    const jobs = await import('./fixtures/jobs/index.ts')
    type Units = typeof jobs
    type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never
    expectTypeOf<BrandOf<Units['placeOrder']>['result']>().toEqualTypeOf<{ cartId: string; reminder: string }>()
    mutation({
      handler(ctx) {
        expectTypeOf(ctx.scheduler.after(1000, 'anything', { any: 'thing' })).toEqualTypeOf<string>()
        expectTypeOf(ctx.scheduler.at(Date.now(), 'x')).toEqualTypeOf<string>()
        expectTypeOf(ctx.scheduler.cancel('job_x')).toEqualTypeOf<boolean>()
        expectTypeOf(ctx.unit.job).toEqualTypeOf<JobInfo | null>()
        expectTypeOf(ctx.unit.trigger).toEqualTypeOf<'call' | 'schedule' | 'change' | 'job' | 'admin' | 'cli' | 'mcp'>()
      },
    })
    action({ handler: (ctx) => void ctx.scheduler.after(0, 'x') })
    // @ts-expect-error queries cannot schedule
    query({ handler: (ctx) => ctx.scheduler.after(0, 'x') })
  })
})
