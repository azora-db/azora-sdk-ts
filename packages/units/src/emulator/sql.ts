/**
 * SQL as the engine lets units run it: the statement check of
 * internal/units/engine.go (checkSQL, with internal/sqlite/statement.go's
 * scanners) and the value conversions of internal/units/values.go.
 */
import { bytesOf, engineStringify } from './json.ts'

/** The prefix of the engine's own tables, which units cannot use. */
export const TABLE_PREFIX = 'azora_units'

const DENIED = new Set(['attach', 'detach', 'vacuum', 'begin', 'commit', 'end', 'rollback', 'savepoint', 'release', 'pragma'])

function isWord(c: string): boolean {
  return /^[A-Za-z0-9_]$/.test(c)
}

/** The lower-cased first keyword, after whitespace, comments and opening parentheses. */
export function firstKeyword(q: string): string {
  let i = 0
  while (i < q.length) {
    const c = q[i]!
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '(') i++
    else if (c === '-' && q[i + 1] === '-') {
      while (i < q.length && q[i] !== '\n') i++
    } else if (c === '/' && q[i + 1] === '*') {
      const end = q.indexOf('*/', i + 2)
      if (end < 0) return ''
      i = end + 2
    } else {
      let j = i
      while (j < q.length && isWord(q[j]!)) j++
      return q.slice(i, j).toLowerCase()
    }
  }
  return ''
}

/** Whether s is only whitespace, ';' and complete comments. */
function onlyTrivia(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ';') continue
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) return false
      i = end + 1
    } else return false
  }
  return true
}

/** Whether q may hold more than one statement (a ';' outside quotes and comments followed by more). */
export function isMultiStatement(q: string): boolean {
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!
    if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < q.length && q[i] !== c) i++
    } else if (c === '[') {
      while (i < q.length && q[i] !== ']') i++
    } else if (c === '-' && q[i + 1] === '-') {
      while (i < q.length && q[i] !== '\n') i++
    } else if (c === '/' && q[i + 1] === '*') {
      const end = q.indexOf('*/', i + 2)
      if (end < 0) return true
      i = end + 1
    } else if (c === ';') return !onlyTrivia(q.slice(i + 1))
  }
  return false
}

/** Why a unit may not run q, or null when it may. */
export function checkSQL(q: string): string | null {
  if (isMultiStatement(q)) return 'one statement per call (use ctx.db.batch for several)'
  const kw = firstKeyword(q)
  if (kw === '') return 'empty statement'
  if (DENIED.has(kw)) return `${kw.toUpperCase()} statements cannot run in a unit`
  if (q.toLowerCase().includes(TABLE_PREFIX)) return `units cannot use the ${TABLE_PREFIX}* tables`
  return null
}

/** A value node:sqlite binds. */
export type Bound = null | bigint | number | string | Uint8Array

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/**
 * A statement argument: integers bind as INTEGER (bigints within 64
 * bits), other numbers as REAL, booleans as 1/0, Dates as unix ms, bytes
 * as BLOB, null/undefined as NULL, arrays and objects as JSON text.
 */
export function sqlArg(v: unknown): Bound {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'number':
      return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 2 ** 63 ? BigInt(v) : v
    case 'bigint':
      if (v < INT64_MIN || v > INT64_MAX) throw new Error(`bigint ${v} does not fit in a 64-bit integer`)
      return v
    case 'string':
      return v
    case 'boolean':
      return v ? 1n : 0n
    case 'object': {
      if (v instanceof Date) {
        const t = v.getTime()
        if (Number.isNaN(t)) throw new Error('an invalid Date')
        return BigInt(t)
      }
      const b = bytesOf(v)
      if (b) return new Uint8Array(b)
      return engineStringify(v)
    }
  }
  throw new Error(`cannot use a ${typeof v} as a SQL argument`)
}

/** A column value as units see it: integers beyond 2^53 as bigint, blobs as Uint8Array. */
export function jsValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v > 2n ** 53n || v < -(2n ** 53n) ? v : Number(v)
  if (v instanceof Uint8Array) return new Uint8Array(v)
  return v
}

/** A row from node:sqlite (null prototype, bigints) as a plain object of unit values. */
export function rowObject(r: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(r)) o[k] = jsValue(r[k])
  return o
}
