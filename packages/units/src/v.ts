/**
 * Validators for unit arguments. Each one is a JSON Schema (of the subset
 * the engine checks) with the TypeScript type it accepts:
 *
 * ```ts
 * args: { cartId: v.string({ min: 1 }), qty: v.optional(v.int({ min: 1, max: 99 })) }
 * ```
 */

/** A JSON Schema (the subset the engine checks: docs/units.md, Bundle format). */
export type JsonSchema = { [key: string]: unknown }

/** A validator: a JSON Schema, and the type T of the values it accepts. */
export interface Validator<T = unknown, Optional extends boolean = boolean> {
  /** Marks validators (args may also be an object of validators). */
  readonly '~validator': true
  /** The JSON Schema the engine checks. */
  readonly schema: JsonSchema
  /** Whether an object property with this validator may be left out. */
  readonly optional: Optional
  /** Phantom: the accepted type. Not present at runtime. */
  readonly '~types'?: { value: T }
}

/** The type a validator accepts. */
export type Infer<V> = V extends Validator<any, boolean> ? NonNullable<V['~types']>['value'] : never

/** An object of validators: the properties of an object argument. */
export type Shape = { readonly [key: string]: Validator<any, boolean> }

type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** The object type an object of validators accepts (optional validators are optional keys). */
export type InferShape<S extends Shape> = Simplify<
  { -readonly [K in keyof S as S[K] extends Validator<any, true> ? never : K]: Infer<S[K]> } & {
    -readonly [K in keyof S as S[K] extends Validator<any, true> ? K : never]?: Infer<S[K]>
  }
>

/** What `args` accepts: an object of validators, or one validator. */
export type ArgsSpec = Shape | Validator<any, boolean>

/** The arguments type of an args spec. */
export type InferArgs<A> = A extends Validator<any, boolean> ? Infer<A> : A extends Shape ? InferShape<A> : unknown

/** Options every validator takes. */
export interface Described {
  /** Shown in the dashboard and to AI agents. */
  description?: string
}

function make<T, O extends boolean = false>(schema: JsonSchema, o?: Described, optional?: O): Validator<T, O> {
  const s: JsonSchema = { ...schema }
  if (o?.description) s['description'] = o.description
  return { '~validator': true, schema: s, optional: (optional ?? false) as O }
}

function bounds(s: JsonSchema, min: string, max: string, o?: { min?: number; max?: number }): JsonSchema {
  if (o?.min !== undefined) s[min] = o.min
  if (o?.max !== undefined) s[max] = o.max
  return s
}

/** Whether x is a validator (and not an object of validators). */
export function isValidator(x: unknown): x is Validator {
  return typeof x === 'object' && x !== null && (x as { '~validator'?: unknown })['~validator'] === true
}

function objectSchema(shape: Shape): JsonSchema {
  const properties: JsonSchema = {}
  const required: string[] = []
  for (const [k, val] of Object.entries(shape)) {
    if (!isValidator(val)) throw new TypeError(`azora units: property ${JSON.stringify(k)} is not a validator (use v.string(), v.number(), ...)`)
    properties[k] = val.schema
    if (!val.optional) required.push(k)
  }
  const s: JsonSchema = { type: 'object', properties }
  if (required.length > 0) s['required'] = required
  s['additionalProperties'] = false
  return s
}

/** The JSON Schema of an args spec (an object of validators or one validator). */
export function argsSchema(spec: ArgsSpec): JsonSchema {
  return isValidator(spec) ? spec.schema : objectSchema(spec as Shape)
}

type Literal = string | number | boolean | null

/** The validators. */
export const v = {
  /** A string; `min`/`max` bound its length, `pattern` is a regular expression it must match. */
  string(o?: Described & { min?: number; max?: number; pattern?: string | RegExp }): Validator<string, false> {
    const s = bounds({ type: 'string' }, 'minLength', 'maxLength', o)
    if (o?.pattern !== undefined) s['pattern'] = typeof o.pattern === 'string' ? o.pattern : o.pattern.source
    return make(s, o)
  },
  /** A number (integer or not), between `min` and `max` inclusive. */
  number(o?: Described & { min?: number; max?: number }): Validator<number, false> {
    return make(bounds({ type: 'number' }, 'minimum', 'maximum', o), o)
  },
  /** An integer, between `min` and `max` inclusive. */
  int(o?: Described & { min?: number; max?: number }): Validator<number, false> {
    return make(bounds({ type: 'integer' }, 'minimum', 'maximum', o), o)
  },
  boolean(o?: Described): Validator<boolean, false> {
    return make({ type: 'boolean' }, o)
  },
  null(o?: Described): Validator<null, false> {
    return make({ type: 'null' }, o)
  },
  /** Exactly this value. */
  literal<const L extends Literal>(value: L, o?: Described): Validator<L, false> {
    return make({ const: value }, o)
  },
  /** One of these values. */
  enum<const L extends readonly [Literal, ...Literal[]]>(values: L, o?: Described): Validator<L[number], false> {
    return make({ enum: [...values] }, o)
  },
  /** An array of items; `min`/`max` bound its length. */
  array<I extends Validator<any, boolean>>(items: I, o?: Described & { min?: number; max?: number }): Validator<Infer<I>[], false> {
    return make(bounds({ type: 'array', items: items.schema }, 'minItems', 'maxItems', o), o)
  },
  /** An object with these properties and no others. */
  object<S extends Shape>(shape: S, o?: Described): Validator<InferShape<S>, false> {
    return make(objectSchema(shape), o)
  },
  /** An object with any keys, whose values match `values`. */
  record<V extends Validator<any, boolean>>(values: V, o?: Described): Validator<Record<string, Infer<V>>, false> {
    return make({ type: 'object', additionalProperties: values.schema }, o)
  },
  /** An object property that may be left out. */
  optional<T>(inner: Validator<T, boolean>): Validator<T | undefined, true> {
    return { '~validator': true, schema: inner.schema, optional: true }
  },
  /** The value, or null. */
  nullable<T>(inner: Validator<T, boolean>, o?: Described): Validator<T | null, false> {
    return make({ anyOf: [inner.schema, { type: 'null' }] }, o)
  },
  /** Any of these. */
  union<const U extends readonly [Validator<any, boolean>, ...Validator<any, boolean>[]]>(...members: U): Validator<Infer<U[number]>, false> {
    return make({ anyOf: members.map((m) => m.schema) })
  },
  /** Anything. */
  any(o?: Described): Validator<any, false> {
    return make({}, o)
  },
  /** Bytes: a Uint8Array (`{"$bytes": base64}` in JSON). */
  bytes(o?: Described): Validator<Uint8Array, false> {
    return make({ type: 'object', properties: { $bytes: { type: 'string' } }, required: ['$bytes'] }, o)
  },
}
