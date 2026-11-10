/**
 * Row filters of table subscriptions. The server evaluates them on every
 * change with SQLite's comparison rules and no type conversion: NULL
 * matches only `isNull`, numbers compare numerically, text byte-wise, and
 * `qty = '5'` never matches the integer 5.
 */
import { type InputValue, toValue } from './codec.ts'
import type { WireFilter } from './messages.ts'

/** A row predicate: build one with the functions below or {@link parseFilter}. */
export interface Filter {
  /** `=` `!=` `<` `<=` `>` `>=` `in` `not_in` `is_null` `not_null` `prefix` `and` `or` `not` */
  op: string
  col?: string
  val?: InputValue
  vals?: readonly InputValue[]
  args?: readonly Filter[]
}

const MAX_DEPTH = 16
const MAX_VALUES = 1000

export const eq = (col: string, val: InputValue): Filter => ({ op: '=', col, val })
export const ne = (col: string, val: InputValue): Filter => ({ op: '!=', col, val })
export const lt = (col: string, val: InputValue): Filter => ({ op: '<', col, val })
export const lte = (col: string, val: InputValue): Filter => ({ op: '<=', col, val })
export const gt = (col: string, val: InputValue): Filter => ({ op: '>', col, val })
export const gte = (col: string, val: InputValue): Filter => ({ op: '>=', col, val })
/** The column equals one of the values. */
export const inList = (col: string, vals: readonly InputValue[]): Filter => ({ op: 'in', col, vals })
export const notInList = (col: string, vals: readonly InputValue[]): Filter => ({ op: 'not_in', col, vals })
export const isNull = (col: string): Filter => ({ op: 'is_null', col })
export const notNull = (col: string): Filter => ({ op: 'not_null', col })
/** The column is text starting with prefix. */
export const startsWith = (col: string, prefix: string): Filter => ({ op: 'prefix', col, val: prefix })
export const and = (...args: Filter[]): Filter => ({ op: 'and', args })
export const or = (...args: Filter[]): Filter => ({ op: 'or', args })
export const not = (arg: Filter): Filter => ({ op: 'not', args: [arg] })

/** A filter that could not be parsed or encoded. */
export class FilterError extends Error {
  override name = 'FilterError'
}

/** @internal Converts a filter to its wire form, normalizing its values. */
export function toWireFilter(f: Filter | string | null | undefined, depth = 0): WireFilter | null {
  if (f == null) return null
  if (typeof f === 'string') {
    const parsed = parseFilter(f)
    return parsed ? toWireFilter(parsed) : null
  }
  if (depth > MAX_DEPTH) throw new FilterError('filter nested deeper than 16')
  return {
    op: f.op,
    col: f.col ?? '',
    val: toValue(f.val),
    vals: f.vals ? f.vals.map(toValue) : null,
    args: (f.args ?? []).map((a) => toWireFilter(a, depth + 1) as WireFilter),
  }
}

type TokenKind = 'eof' | 'ident' | 'value' | 'op' | '(' | ')' | ','
interface Token {
  kind: TokenKind
  text: string
  val?: InputValue
  pos: number
}

const isIdentChar = (c: number): boolean =>
  c === 95 || c >= 0x80 || (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)

/**
 * Parses filter text, the same small SQL subset the server and the CLI
 * accept: comparisons (`=` `==` `!=` `<>` `<` `<=` `>` `>=`), `^=` (starts
 * with), `IN (…)`, `NOT IN (…)`, `IS [NOT] NULL`, `AND`, `OR`, `NOT` and
 * parentheses, over integers, floats, `'text'`, `x'hex'` blobs and
 * `TRUE`/`FALSE`. Column names may be double-quoted. Empty text is no
 * filter (null).
 */
export function parseFilter(src: string): Filter | null {
  let i = 0
  let tok: Token = { kind: 'eof', text: '', pos: 0 }
  const fail = (msg: string, pos = tok.pos): never => {
    throw new FilterError(`filter at ${pos}: ${msg}`)
  }
  const next = (): void => {
    while (i < src.length && ' \t\r\n'.includes(src[i] as string)) i++
    const start = i
    if (i >= src.length) {
      tok = { kind: 'eof', text: '', pos: start }
      return
    }
    const c = src[i] as string
    if (c === '(' || c === ')' || c === ',') {
      i++
      tok = { kind: c, text: c, pos: start }
    } else if (c === "'") {
      let s = ''
      i++
      for (;;) {
        if (i >= src.length) fail('unterminated string', start)
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'"
            i += 2
            continue
          }
          i++
          break
        }
        s += src[i++]
      }
      tok = { kind: 'value', text: s, val: s, pos: start }
    } else if (c === '"') {
      let s = ''
      let j = i + 1
      for (;;) {
        if (j >= src.length) fail('unterminated identifier', start)
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"'
            j += 2
            continue
          }
          break
        }
        s += src[j++]
      }
      i = j + 1
      tok = { kind: 'ident', text: s, pos: start }
    } else if ((c === 'x' || c === 'X') && src[i + 1] === "'") {
      const end = src.indexOf("'", i + 2)
      if (end < 0) fail('unterminated blob', start)
      const hex = src.slice(i + 2, end)
      if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) fail('bad blob', start)
      const b = new Uint8Array(hex.length / 2)
      for (let k = 0; k < b.length; k++) b[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16)
      i = end + 1
      tok = { kind: 'value', text: hex, val: b, pos: start }
    } else if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) {
      let j = i + 1
      while (j < src.length) {
        const d = src[j] as string
        const prev = src[j - 1] as string
        if ('0123456789.eE'.includes(d) || ((d === '-' || d === '+') && (prev === 'e' || prev === 'E'))) j++
        else break
      }
      const text = src.slice(i, j)
      i = j
      tok = { kind: 'value', text, val: parseNumber(text) ?? fail(`bad number "${text}"`, start), pos: start }
    } else if ('=!<>^'.includes(c)) {
      let j = i + 1
      if (j < src.length && '=>'.includes(src[j] as string)) j++
      tok = { kind: 'op', text: src.slice(i, j), pos: start }
      i = j
    } else {
      let j = i
      while (j < src.length && isIdentChar(src.charCodeAt(j))) j++
      if (j === i) fail(`unexpected "${c}"`, start)
      tok = { kind: 'ident', text: src.slice(i, j), pos: start }
      i = j
    }
  }
  // Read through a function: the checker cannot see that next() replaces tok.
  const kind = (): TokenKind => tok.kind
  const kw = (word: string): boolean => kind() === 'ident' && tok.text.toLowerCase() === word

  const value = (): InputValue => {
    if (kind() === 'value') {
      const v = tok.val
      next()
      return v
    }
    if (kw('true')) {
      next()
      return 1
    }
    if (kw('false')) {
      next()
      return 0
    }
    return fail(`expected a value, got "${tok.text}"`)
  }

  const leaf = (): Filter => {
    if (kind() !== 'ident') fail(`expected a column name, got "${tok.text}"`)
    const col = tok.text
    next()
    if (kw('is')) {
      next()
      let negate = false
      if (kw('not')) {
        negate = true
        next()
      }
      if (!kw('null')) fail('expected NULL')
      next()
      return { op: negate ? 'not_null' : 'is_null', col }
    }
    if (kw('in') || kw('not')) {
      let op = 'in'
      if (kw('not')) {
        next()
        if (!kw('in')) fail('expected IN')
        op = 'not_in'
      }
      next()
      if (kind() !== '(') fail('expected (')
      next()
      const vals: InputValue[] = []
      for (;;) {
        vals.push(value())
        if (vals.length > MAX_VALUES) fail(`more than ${MAX_VALUES} values`)
        if (kind() !== ',') break
        next()
      }
      if (kind() !== ')') fail('expected )')
      next()
      return { op, col, vals }
    }
    if (kind() === 'op') {
      let op = tok.text
      if (op === '==') op = '='
      else if (op === '<>') op = '!='
      else if (op === '^=') op = 'prefix'
      else if (!['=', '!=', '<', '<=', '>', '>='].includes(op)) fail(`unknown operator "${op}"`)
      next()
      return { op, col, val: value() }
    }
    return fail(`expected an operator after "${col}"`)
  }

  const unary = (d: number): Filter => {
    if (kw('not')) {
      next()
      return { op: 'not', args: [unary(d + 1)] }
    }
    if (kind() === '(') {
      next()
      const x = or(d + 1)
      if (kind() !== ')') fail('expected )')
      next()
      return x
    }
    return leaf()
  }
  const chain = (word: 'and' | 'or', operand: () => Filter): Filter => {
    const args = [operand()]
    while (kw(word)) {
      next()
      args.push(operand())
    }
    return args.length === 1 ? (args[0] as Filter) : { op: word, args }
  }
  const or = (d: number): Filter => {
    if (d > MAX_DEPTH) fail('nested too deeply')
    return chain('or', () => chain('and', () => unary(d)))
  }

  next()
  if (kind() === 'eof') return null
  const f = or(0)
  if (kind() !== 'eof') fail(`unexpected "${tok.text}"`)
  return f
}

/** Parses a numeric literal: an integer when it has no fraction or exponent and fits 64 bits. */
function parseNumber(text: string): number | bigint | null {
  const s = text.startsWith('+') ? text.slice(1) : text
  if (/^-?\d+$/.test(s)) {
    const b = BigInt(s)
    if (b >= -(1n << 63n) && b < 1n << 63n) return Number.isSafeInteger(Number(b)) ? Number(b) : b
  }
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null
  return Number(s)
}
