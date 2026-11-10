/**
 * An in-memory copy of a subscription's rows, built by applying its
 * updates. Tables are keyed by lowercased name, rows by primary key.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { Writer, toValue, type InputValue, type Value } from './codec.ts'
import type { Change, Update } from './types.ts'

interface ReplicaRow {
  key: Value[]
  row: Value[]
  keyFloats: number[] | undefined
  rowFloats: number[] | undefined
  hash: bigint | undefined // computed on demand
}

interface ReplicaTable {
  name: string
  columns: readonly string[]
  pk: readonly string[]
  rows: Map<string, ReplicaRow>
}

const MASK64 = (1n << 64n) - 1n

/**
 * A string that identifies primary key values: integers and floats of the
 * same value are the same key, as they are for SQLite.
 */
export function keyString(key: readonly InputValue[]): string {
  if (key.length === 1) {
    const v = key[0]
    if (typeof v === 'number' || typeof v === 'bigint') return 'n' + v
    if (typeof v === 'string') return 's' + v
  }
  let out = ''
  for (const raw of key) {
    const v = toValue(raw)
    if (v === null) out += 'z|'
    else if (typeof v === 'number' || typeof v === 'bigint') out += 'n' + v + '|'
    else if (typeof v === 'string') out += 's' + v.length + ':' + v + '|'
    else if (typeof v === 'boolean') out += 'n' + (v ? 1 : 0) + '|'
    else {
      out += 'b'
      for (const b of v) out += b.toString(16).padStart(2, '0')
      out += '|'
    }
  }
  return out
}

/**
 * Hashes one row the way the server's checksums do: the first 8 bytes,
 * little-endian, of SHA-256 over the lowercased table name, then the key
 * values and the row values (each list prefixed with its length). The
 * float lists name integral values stored as floats (see Change).
 */
export function rowHash(
  table: string,
  key: readonly Value[],
  row: readonly Value[],
  keyFloats?: readonly number[],
  rowFloats?: readonly number[],
): bigint {
  const w = new Writer(64 + row.length * 12)
  w.s(table.toLowerCase())
  const put = (vs: readonly Value[], floats?: readonly number[]): void => {
    w.u(vs.length)
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i] as Value
      if (floats && typeof v === 'number' && floats.includes(i)) w.float(v)
      else w.val(v)
    }
  }
  put(key, keyFloats)
  put(row, rowFloats)
  const d = sha256(w.bytes())
  let out = 0n
  for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(d[i] as number)
  return out
}

/** An in-memory copy of a subscription's rows. */
export class Replica {
  private tables = new Map<string, ReplicaTable>()

  /**
   * Applies an update: `reset` drops every row first; inserts and updates
   * store the new row, deletes remove it.
   */
  apply(u: Update): void {
    if (u.reset) this.tables = new Map()
    for (const c of u.changes) this.applyChange(c)
  }

  /** Applies one change. */
  applyChange(c: Change): void {
    const k = c.table.toLowerCase()
    let t = this.tables.get(k)
    if (!t) {
      t = { name: c.table, columns: c.columns, pk: c.pk, rows: new Map() }
      this.tables.set(k, t)
    }
    if (c.columns.length > 0) {
      t.columns = c.columns
      t.pk = c.pk
    }
    const key = keyString(c.key)
    if (c.op === 'delete') {
      t.rows.delete(key)
    } else if (c.new) {
      t.rows.set(key, { key: c.key, row: c.new, keyFloats: c.keyFloats, rowFloats: c.newFloats, hash: undefined })
    }
  }

  /** The row of table with the given primary key values. */
  get(table: string, ...key: InputValue[]): Value[] | undefined {
    return this.tables.get(table.toLowerCase())?.rows.get(keyString(key))?.row
  }

  /** Iterates a table's rows as [key, row] pairs, in insertion order. */
  *rows(table: string): IterableIterator<[Value[], Value[]]> {
    const t = this.tables.get(table.toLowerCase())
    if (!t) return
    for (const r of t.rows.values()) yield [r.key, r.row]
  }

  /** The number of rows of table (of every table when omitted). */
  size(table?: string): number {
    if (table !== undefined) return this.tables.get(table.toLowerCase())?.rows.size ?? 0
    let n = 0
    for (const t of this.tables.values()) n += t.rows.size
    return n
  }

  /** The lowercased names of the tables with rows, sorted. */
  tableNames(): string[] {
    const out: string[] = []
    for (const [k, t] of this.tables) if (t.rows.size > 0) out.push(k)
    return out.sort()
  }

  /** The column names of a table's rows (from the last change applied) and its primary key columns. */
  columns(table: string): { columns: readonly string[]; pk: readonly string[] } {
    const t = this.tables.get(table.toLowerCase())
    return { columns: t?.columns ?? [], pk: t?.pk ?? [] }
  }

  /**
   * The row count and the sum (mod 2^64) of the protocol's row hash over
   * every row: what `Subscription.verify` compares with the server.
   */
  checksum = (): { rows: number; sum: bigint } => {
    let rows = 0
    let sum = 0n
    for (const t of this.tables.values()) {
      for (const r of t.rows.values()) {
        rows++
        r.hash ??= rowHash(t.name, r.key, r.row, r.keyFloats, r.rowFloats)
        sum += r.hash
      }
    }
    return { rows, sum: sum & MASK64 }
  }

  /** Drops every row. */
  clear(): void {
    this.tables = new Map()
  }
}
