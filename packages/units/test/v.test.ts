import { describe, expect, expectTypeOf, test } from 'vitest'
import { argsSchema, v, type Infer, type InferArgs } from '../src/index.ts'

describe('validators', () => {
  test('map to the JSON Schema subset the engine checks', () => {
    expect(v.string().schema).toEqual({ type: 'string' })
    expect(v.string({ min: 1, max: 64, pattern: /^[a-z]+$/, description: 'a slug' }).schema).toEqual({
      type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z]+$', description: 'a slug',
    })
    expect(v.string({ pattern: '^c[0-9]+$' }).schema).toEqual({ type: 'string', pattern: '^c[0-9]+$' })
    expect(v.number({ min: 0, max: 1.5 }).schema).toEqual({ type: 'number', minimum: 0, maximum: 1.5 })
    expect(v.int({ min: 1 }).schema).toEqual({ type: 'integer', minimum: 1 })
    expect(v.boolean().schema).toEqual({ type: 'boolean' })
    expect(v.null().schema).toEqual({ type: 'null' })
    expect(v.literal('paid').schema).toEqual({ const: 'paid' })
    expect(v.enum(['open', 'paid', 3]).schema).toEqual({ enum: ['open', 'paid', 3] })
    expect(v.array(v.int(), { min: 1, max: 10 }).schema).toEqual({ type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 10 })
    expect(v.record(v.number()).schema).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
    expect(v.union(v.string(), v.int()).schema).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] })
    expect(v.nullable(v.string()).schema).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(v.any().schema).toEqual({})
    expect(v.bytes().schema).toEqual({ type: 'object', properties: { $bytes: { type: 'string' } }, required: ['$bytes'] })
    expect(v.optional(v.string()).schema).toEqual({ type: 'string' })
    expect(v.optional(v.string()).optional).toBe(true)
  })

  test('objects list their required keys and allow no others', () => {
    const s = v.object({ id: v.string(), qty: v.optional(v.int()), tags: v.array(v.string()) }).schema
    expect(s).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, qty: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'tags'],
      additionalProperties: false,
    })
    expect(v.object({ a: v.optional(v.string()) }).schema).toEqual({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false })
    expect(() => v.object({ a: 'string' as never })).toThrow(/property "a" is not a validator/)
  })

  test('args: an object of validators is an object schema; one validator is its own schema', () => {
    expect(argsSchema({ cartId: v.string() })).toEqual({
      type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'], additionalProperties: false,
    })
    expect(argsSchema(v.array(v.string()))).toEqual({ type: 'array', items: { type: 'string' } })
    expect(argsSchema({})).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })

  test('types follow the validators', () => {
    expectTypeOf<Infer<ReturnType<typeof v.string>>>().toEqualTypeOf<string>()
    expectTypeOf<Infer<ReturnType<typeof v.bytes>>>().toEqualTypeOf<Uint8Array>()
    const status = v.enum(['open', 'paid'])
    expectTypeOf<Infer<typeof status>>().toEqualTypeOf<'open' | 'paid'>()
    const one = v.literal(7)
    expectTypeOf<Infer<typeof one>>().toEqualTypeOf<7>()
    const u = v.union(v.string(), v.null())
    expectTypeOf<Infer<typeof u>>().toEqualTypeOf<string | null>()
    const shape = { id: v.string(), qty: v.optional(v.int()), items: v.array(v.object({ sku: v.string() })), meta: v.record(v.any()) }
    expectTypeOf<InferArgs<typeof shape>>().toEqualTypeOf<{
      id: string
      items: { sku: string }[]
      meta: Record<string, any>
      qty?: number | undefined
    }>()
    expectTypeOf<InferArgs<ReturnType<typeof v.int>>>().toEqualTypeOf<number>()
  })
})
