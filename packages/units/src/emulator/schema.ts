/**
 * Argument schemas as the engine checks them: the JSON Schema subset of
 * internal/units/schema.go, with its error messages. Values are parsed
 * JSON (blobs still `{"$bytes"}` objects).
 */

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])
const KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'pattern', 'description', 'title', 'default', '$schema', 'examples',
])
const MAX_DEPTH = 32

/** A compiled schema. */
export interface Schema {
  types: string[]
  properties: Map<string, Schema> | null
  required: string[]
  addl: Schema | null
  noAddl: boolean
  items: Schema | null
  enum: unknown[] | null
  hasConst: boolean
  constant: unknown
  anyOf: Schema[] | null
  minimum: number | null
  maximum: number | null
  minLength: number | null
  maxLength: number | null
  minItems: number | null
  maxItems: number | null
  pattern: RegExp | null
  patternText: string
}

/** Compiles a definition's `args` (null: anything); throws what a deploy would refuse. */
export function compileSchema(raw: unknown): Schema | null {
  if (raw === null || raw === undefined) return null
  return compile(JSON.parse(JSON.stringify(raw)) as unknown, '', 0)
}

function compile(v: unknown, path: string, depth: number): Schema {
  if (depth > MAX_DEPTH) throw new Error(`args schema: nested deeper than ${MAX_DEPTH}`)
  const where = path === '' ? 'args' : path
  const s: Schema = {
    types: [], properties: null, required: [], addl: null, noAddl: false, items: null, enum: null, hasConst: false, constant: undefined, anyOf: null,
    minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, patternText: '',
  }
  if (typeof v === 'boolean') {
    if (v) return s
    throw new Error(`args schema ${where}: false schemas are not supported`)
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`args schema ${where}: must be an object`)
  const m = v as Record<string, unknown>
  for (const k of Object.keys(m)) if (!KEYS.has(k)) throw new Error(`args schema ${where}: unsupported keyword ${JSON.stringify(k)}`)
  const t = m['type']
  if (typeof t === 'string') s.types = [t]
  else if (Array.isArray(t)) {
    for (const x of t) {
      if (typeof x !== 'string') throw new Error(`args schema ${where}: type must be a string or a list of strings`)
      s.types.push(x)
    }
  } else if (t !== undefined && t !== null) throw new Error(`args schema ${where}: type must be a string or a list of strings`)
  for (const x of s.types) if (!TYPES.has(x)) throw new Error(`args schema ${where}: unknown type ${JSON.stringify(x)}`)
  if ('properties' in m) {
    const p = m['properties']
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error(`args schema ${where}: properties must be an object`)
    s.properties = new Map()
    for (const [k, sub] of Object.entries(p)) s.properties.set(k, compile(sub, `${path}.${k}`, depth + 1))
  }
  if ('required' in m) {
    const r = m['required']
    if (!Array.isArray(r)) throw new Error(`args schema ${where}: required must be a list`)
    for (const x of r) {
      if (typeof x !== 'string') throw new Error(`args schema ${where}: required must list strings`)
      s.required.push(x)
    }
  }
  const a = m['additionalProperties']
  if (typeof a === 'boolean') s.noAddl = !a
  else if (a !== undefined && a !== null) s.addl = compile(a, `${path}.*`, depth + 1)
  if ('items' in m) s.items = compile(m['items'], `${path}[]`, depth + 1)
  if ('enum' in m) {
    if (!Array.isArray(m['enum'])) throw new Error(`args schema ${where}: enum must be a list`)
    s.enum = m['enum']
  }
  if ('const' in m) {
    s.hasConst = true
    s.constant = m['const']
  }
  if ('anyOf' in m) {
    const list = m['anyOf']
    if (!Array.isArray(list) || list.length === 0) throw new Error(`args schema ${where}: anyOf must be a non-empty list`)
    s.anyOf = list.map((sub, i) => compile(sub, `${path}|${i}`, depth + 1))
  }
  const num = (k: string): number | null => {
    if (!(k in m)) return null
    if (typeof m[k] !== 'number') throw new Error(`args schema ${where}: ${k} must be a number`)
    return m[k] as number
  }
  const count = (k: string): number | null => {
    if (!(k in m)) return null
    const n = m[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new Error(`args schema ${where}: ${k} must be a non-negative integer`)
    return n
  }
  s.minimum = num('minimum')
  s.maximum = num('maximum')
  s.minLength = count('minLength')
  s.maxLength = count('maxLength')
  s.minItems = count('minItems')
  s.maxItems = count('maxItems')
  if ('pattern' in m) {
    const p = m['pattern']
    if (typeof p !== 'string') throw new Error(`args schema ${where}: pattern must be a string`)
    try {
      s.pattern = new RegExp(p, 'u')
    } catch {
      try {
        s.pattern = new RegExp(p)
      } catch (e) {
        throw new Error(`args schema ${where}: pattern: ${(e as Error).message}`)
      }
    }
    s.patternText = p
  }
  return s
}

function jsonType(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  return 'unknown'
}

/** JSON with object keys sorted, as Go prints values. */
function compact(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(compact).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${compact(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
  if (typeof a === 'object' && a !== null) {
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return false
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    const kx = Object.keys(x)
    return kx.length === Object.keys(y).length && kx.every((k) => k in y && equal(x[k], y[k]))
  }
  return a === b
}

function fmt(n: number): string {
  return String(n)
}

/** Why v does not match s ("args.cartId: is required"), or null. */
export function validate(s: Schema | null, v: unknown, path = 'args'): string | null {
  if (!s) return null
  if (s.types.length > 0) {
    const t = jsonType(v)
    if (!s.types.some((want) => want === t || (want === 'number' && t === 'integer'))) return `${path}: must be ${s.types.join(' or ')}, got ${t}`
  }
  if (s.hasConst && !equal(v, s.constant)) return `${path}: must be ${compact(s.constant)}`
  if (s.enum && !s.enum.some((e) => equal(v, e))) return `${path}: must be one of ${s.enum.map(compact).join(', ')}`
  if (s.anyOf) {
    let first: string | null = null
    let ok = false
    for (const sub of s.anyOf) {
      const err = validate(sub, v, path)
      if (err === null) {
        ok = true
        break
      }
      first ??= err
    }
    if (!ok) return first
  }
  if (typeof v === 'number') {
    if (s.minimum !== null && v < s.minimum) return `${path}: must be >= ${fmt(s.minimum)}`
    if (s.maximum !== null && v > s.maximum) return `${path}: must be <= ${fmt(s.maximum)}`
  } else if (typeof v === 'string') {
    const n = [...v].length
    if (s.minLength !== null && n < s.minLength) return `${path}: must be at least ${s.minLength} characters`
    if (s.maxLength !== null && n > s.maxLength) return `${path}: must be at most ${s.maxLength} characters`
    if (s.pattern && !s.pattern.test(v)) return `${path}: must match ${s.patternText}`
  } else if (Array.isArray(v)) {
    if (s.minItems !== null && v.length < s.minItems) return `${path}: must have at least ${s.minItems} items`
    if (s.maxItems !== null && v.length > s.maxItems) return `${path}: must have at most ${s.maxItems} items`
    if (s.items) {
      for (let i = 0; i < v.length; i++) {
        const err = validate(s.items, v[i], `${path}[${i}]`)
        if (err) return err
      }
    }
  } else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    for (const r of s.required) if (!Object.hasOwn(o, r)) return `${path}.${r}: is required`
    for (const k of Object.keys(o).sort()) {
      const sub = s.properties?.get(k)
      if (sub) {
        const err = validate(sub, o[k], `${path}.${k}`)
        if (err) return err
        continue
      }
      if (s.noAddl) return `${path}.${k}: is not an allowed argument`
      if (s.addl) {
        const err = validate(s.addl, o[k], `${path}.${k}`)
        if (err) return err
      }
    }
  }
  return null
}

/** Whether "no arguments" is checked, and passed, as {} (the schema takes an object). */
export function takesObject(s: Schema): boolean {
  return s.types.length === 0 ? s.properties !== null : s.types.includes('object')
}
