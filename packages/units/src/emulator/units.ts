/** The units of a module as the engine loads them: their definitions, argument checks and callers. */
import { isUnitDefinition, isUnitName } from '../define.ts'
import type { Caller } from './runtime.ts'
import { compileSchema, takesObject, validate, type Schema } from './schema.ts'
import { TABLE_PREFIX } from './sql.ts'
import type { Kind, Runs, TestAuth } from './types.ts'

// The engine's errors around a unit (Go's sentinel errors).

export type FailCode = 'not_found' | 'permission_denied' | 'invalid' | 'resource_exhausted'
const PREFIX: Record<FailCode, string> = {
  not_found: 'not found',
  permission_denied: 'permission denied',
  invalid: 'invalid',
  resource_exhausted: 'limit exceeded',
}

/** A failure around the unit: the caller gets an AzoraError with code and message. */
export class Failure extends Error {
  readonly code: FailCode
  constructor(code: FailCode, message: string) {
    super(message)
    this.code = code
  }
  /** As the run log and job errors show it. */
  get text(): string {
    return `${PREFIX[this.code]}: ${this.message}`
  }
}

export const q = (s: string): string => JSON.stringify(s)

// Units.

export interface Def {
  name: string
  kind: Kind
  runs: Runs
  internal: boolean
  /** The scope a credential needs ('' for schedule and onChange units). */
  access: string
  /** How it answers plain HTTP: '' (not), 'auth' or 'public'. */
  http: '' | 'auth' | 'public'
  handler: (ctx: unknown, args: unknown) => unknown
  schema: Schema | null
  table: string
  ops: string[]
  batch: number
}

export function load(units: Record<string, unknown>): Map<string, Def> {
  const out = new Map<string, Def>()
  const problems: string[] = []
  for (const name of Object.keys(units)) {
    const d = units[name]
    if (!isUnitDefinition(d)) continue // helpers, constants
    const o = d as unknown as Record<string, unknown>
    const fail = (m: string): void => void problems.push(`unit ${name}: ${m}`)
    if (!isUnitName(name)) {
      fail('the name must be 1-64 letters, digits or _, starting with a letter')
      continue
    }
    const kind = o['kind'] as Kind
    if (!['query', 'mutation', 'action', 'schedule', 'onChange'].includes(kind)) {
      fail(`unknown kind ${q(String(kind))}`)
      continue
    }
    if (typeof o['handler'] !== 'function') {
      fail('handler must be a function')
      continue
    }
    let schema: Schema | null
    try {
      schema = compileSchema(o['args'])
    } catch (e) {
      fail((e as Error).message)
      continue
    }
    const trigger = kind === 'schedule' || kind === 'onChange'
    const mode = (o['mode'] as string | undefined) || 'mutation'
    if (trigger && mode !== 'mutation' && mode !== 'action') {
      fail('mode must be "mutation" or "action"')
      continue
    }
    const declared = o['access'] == null ? '' : String(o['access'])
    if (!['', 'any', 'read', 'write'].includes(declared)) {
      fail('access must be "any", "read" or "write"')
      continue
    }
    if (trigger && declared !== '') {
      fail(`a ${kind} unit cannot be called, so it takes no access`)
      continue
    }
    const h = o['http']
    if (h !== undefined && h !== null && typeof h !== 'boolean' && h !== 'public') {
      fail('http must be true (callable over HTTP with a credential) or "public" (without one)')
      continue
    }
    const http = h === 'public' ? 'public' : h === true ? 'auth' : ''
    if (http !== '' && (trigger || Boolean(o['internal']))) {
      fail('an internal, schedule or onChange unit cannot be called over HTTP')
      continue
    }
    const def: Def = {
      name,
      kind,
      runs: trigger ? (mode as Runs) : (kind as Runs),
      internal: trigger || Boolean(o['internal']),
      access: trigger ? '' : declared || (kind === 'query' ? 'read' : 'write'),
      http,
      handler: o['handler'] as Def['handler'],
      schema,
      table: '',
      ops: [],
      batch: 100,
    }
    if (kind === 'schedule' && !o['cron'] === !o['every']) {
      fail('a schedule needs exactly one of cron or every')
      continue
    }
    if (kind === 'onChange') {
      def.table = String(o['table'] ?? '')
      if (def.table === '') {
        fail('onChange needs a table')
        continue
      }
      if (def.table.toLowerCase().includes(TABLE_PREFIX)) {
        fail('onChange cannot watch the units tables')
        continue
      }
      def.ops = [...new Set((o['ops'] as string[] | undefined) ?? [])]
      if (def.ops.length === 0) def.ops = ['insert', 'update', 'delete']
      const bad = def.ops.find((op) => !['insert', 'update', 'delete'].includes(op))
      if (bad) {
        fail(`unknown op ${q(bad)} (use insert, update, delete)`)
        continue
      }
      if (o['batch'] != null) {
        const n = Math.trunc(Number(o['batch']))
        if (!(n >= 1 && n <= 1000)) {
          fail('batch must be in [1, 1000]')
          continue
        }
        def.batch = n
      }
    }
    out.set(name, def)
  }
  if (problems.length > 0) throw new Error(`azora units: these units would not deploy: ${problems.join('; ')}`)
  if (out.size === 0)
    throw new Error('azora units: no units (export query, mutation, action, schedule or onChange definitions)')
  return out
}

/** Checks args (JSON text) against u's schema; "" is checked, and passed, as {} when it takes an object. */
export function checkArgs(u: Def, args: string): string {
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch (e) {
      throw new Failure('invalid', `arguments are not valid JSON: ${(e as Error).message}`)
    }
  }
  if (!u.schema) {
    if (args !== '') parse(args)
    return args
  }
  let v: unknown = null
  if (args === '') {
    if (takesObject(u.schema)) {
      args = '{}'
      v = {}
    }
  } else v = parse(args)
  const err = validate(u.schema, v)
  if (err) throw new Failure('invalid', `unit ${u.name}: ${err}`)
  return args
}

/** Unit.Allows: only credentials (a key or a token) are checked. */
export function allows(u: Def, c: Caller): boolean {
  if (c.kind !== 'key' && c.kind !== 'token') return true
  return u.access === 'any' || c.scopes.some((s) => s === u.access || s === 'admin')
}

export const SYSTEM: Caller = { kind: 'system', principal: 'system', subject: '', scopes: [], tables: [], claims: {} }

export function caller(a: TestAuth | undefined): Caller {
  const kind = a?.kind ?? (a?.subject ? 'token' : 'key')
  const principal =
    a?.principal ?? { key: 'key:test', token: a?.subject || 'token:test', admin: 'admin:test', system: 'system' }[kind]
  const scopes = a?.scopes ?? { key: ['read', 'write'], token: ['read', 'write'], admin: ['admin'], system: [] }[kind]
  return {
    kind,
    principal,
    subject: kind === 'token' ? (a?.subject ?? '') : '',
    scopes: [...scopes],
    tables: [...(a?.tables ?? [])],
    claims: { ...a?.claims },
  }
}
