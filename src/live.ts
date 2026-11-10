/**
 * Live queries: a table (or a filtered part of it, or one row) kept up to
 * date locally. The rows are always a consistent state of the database:
 * they change only at checkpoints, which end on transaction boundaries.
 */
import type { InputValue, Value } from './codec.ts'
import { ClosedError } from './errors.ts'
import type { Filter } from './filter.ts'
import { keyString, rowHash } from './replica.ts'
import type { Subscription } from './subscription.ts'
import type { Change, Operation, Row, Update, VerifyResult } from './types.ts'
import type { CallOptions } from './util.ts'

/** Options of `db.live()`. */
export interface LiveOptions<T> {
  /** Keeps only matching rows: a {@link Filter} or filter text. */
  where?: Filter | string
  /** Follows one row, by primary key values (in key order). */
  key?: readonly InputValue[]
  /**
   * Orders `rows`: a column name, `[column, 'desc']`, several of those, or
   * a comparator. Default: primary key order.
   */
  orderBy?: string | readonly [string, 'asc' | 'desc'] | ReadonlyArray<string | readonly [string, 'asc' | 'desc']> | ((a: T, b: T) => number)
  /** Converts a row object (column name to value) to the type the application uses. */
  map?: (row: Row) => T
}

/** One row change of a live query. */
export interface LiveChange<T> {
  op: Operation
  /** The primary key values. */
  key: Value[]
  /** The row after the change (undefined for a delete). */
  row: T | undefined
  /** The row before the change (undefined for an insert). */
  previous: T | undefined
}

/** What listeners of a live query receive after every consistent step. */
export interface LiveEvent<T> {
  /** The step replaced everything (first snapshot, or a new one after a resync). */
  reset: boolean
  changes: LiveChange<T>[]
  /** The rows after the step. */
  rows: readonly T[]
}

interface Entry<T> {
  key: Value[]
  values: Value[]
  keyFloats: number[] | undefined
  rowFloats: number[] | undefined
  row: T
}

/** Orders SQLite values: NULL, then numbers, then text, then blobs. */
export function compareValues(a: Value, b: Value): number {
  const rank = (v: Value): number =>
    v === null ? 0 : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? 1 : typeof v === 'string' ? 2 : 3
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  switch (ra) {
    case 1: {
      const x = typeof a === 'boolean' ? Number(a) : (a as number | bigint)
      const y = typeof b === 'boolean' ? Number(b) : (b as number | bigint)
      return x < y ? -1 : x > y ? 1 : 0
    }
    case 2:
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
    case 3: {
      const x = a as Uint8Array
      const y = b as Uint8Array
      const n = Math.min(x.length, y.length)
      for (let i = 0; i < n; i++) {
        const d = (x[i] as number) - (y[i] as number)
        if (d !== 0) return d
      }
      return x.length - y.length
    }
  }
  return 0
}

/**
 * A live, always consistent local view of a table's rows. Create one with
 * `db.live()`; close it when done.
 */
export class LiveQuery<T = Row> implements AsyncIterable<LiveEvent<T>> {
  /** Resolves once the first snapshot is applied (rejects if the subscription fails first). */
  readonly ready: Promise<void>
  readonly table: string

  private readonly sub: Subscription
  private readonly entries = new Map<string, Entry<T>>()
  private readonly listeners = new Set<(ev: LiveEvent<T>) => void>()
  private readonly map: ((row: Row) => T) | undefined
  private readonly compare: ((a: Entry<T>, b: Entry<T>) => number) | undefined
  private sorted: readonly T[] | null = null
  private columns: readonly string[] = []
  private loaded = false
  private failure: Error | null = null
  private pump: Promise<void>

  /** @internal Use `db.live()`. */
  constructor(sub: Subscription, table: string, o: LiveOptions<T>) {
    this.sub = sub
    this.table = table
    this.map = o.map
    this.compare = this.comparator(o.orderBy)
    let resolveReady: () => void = () => {}
    let rejectReady: (e: Error) => void = () => {}
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.ready.catch(() => {}) // observed through `error` and `subscribe` too
    this.pump = this.run(resolveReady, rejectReady)
  }

  private comparator(o: LiveOptions<T>['orderBy']): ((a: Entry<T>, b: Entry<T>) => number) | undefined {
    if (o === undefined) return undefined
    if (typeof o === 'function') return (a, b) => o(a.row, b.row)
    const specs: Array<readonly [string, 'asc' | 'desc']> =
      typeof o === 'string'
        ? [[o, 'asc']]
        : o.length === 2 && typeof o[0] === 'string' && (o[1] === 'asc' || o[1] === 'desc')
          ? [o as readonly [string, 'asc' | 'desc']]
          : (o as ReadonlyArray<string | readonly [string, 'asc' | 'desc']>).map((s) => (typeof s === 'string' ? [s, 'asc'] : s))
    return (a, b) => {
      for (const [col, dir] of specs) {
        const i = this.columns.indexOf(col)
        if (i < 0) continue
        const d = compareValues(a.values[i] ?? null, b.values[i] ?? null)
        if (d !== 0) return dir === 'desc' ? -d : d
      }
      return this.keyOrder(a, b)
    }
  }

  private keyOrder(a: Entry<T>, b: Entry<T>): number {
    const n = Math.min(a.key.length, b.key.length)
    for (let i = 0; i < n; i++) {
      const d = compareValues(a.key[i] ?? null, b.key[i] ?? null)
      if (d !== 0) return d
    }
    return a.key.length - b.key.length
  }

  private async run(resolveReady: () => void, rejectReady: (e: Error) => void): Promise<void> {
    try {
      for (;;) {
        const u = await this.sub.next()
        const ev = this.apply(u)
        if (!this.loaded) {
          this.loaded = true
          resolveReady()
        }
        if (ev.reset || ev.changes.length > 0) this.emit(ev)
      }
    } catch (e) {
      if (!(e instanceof ClosedError)) this.failure = e as Error
      rejectReady(e as Error)
      this.emit({ reset: false, changes: [], rows: this.rows })
    }
  }

  private toRow(c: Change, values: Value[]): T {
    const obj: Row = {}
    const cols = c.columns
    for (let i = 0; i < cols.length; i++) obj[cols[i] as string] = values[i] ?? null
    return this.map ? this.map(obj) : (obj as T)
  }

  private apply(u: Update): LiveEvent<T> {
    const changes: LiveChange<T>[] = []
    if (u.reset) this.entries.clear()
    for (const c of u.changes) {
      if (c.columns.length > 0) this.columns = c.columns
      const k = keyString(c.key)
      const prev = this.entries.get(k)
      if (c.op === 'delete') {
        if (!prev) continue
        this.entries.delete(k)
        changes.push({ op: 'delete', key: c.key, row: undefined, previous: prev.row })
      } else if (c.new) {
        const row = this.toRow(c, c.new)
        this.entries.set(k, { key: c.key, values: c.new, keyFloats: c.keyFloats, rowFloats: c.newFloats, row })
        changes.push({ op: prev ? 'update' : 'insert', key: c.key, row, previous: prev?.row })
      }
    }
    if (u.reset || changes.length > 0) this.sorted = null
    return { reset: u.reset, changes, rows: this.rows }
  }

  private emit(ev: LiveEvent<T>): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev)
      } catch (e) {
        queueMicrotask(() => {
          throw e
        })
      }
    }
  }

  /**
   * The current rows, ordered. The array keeps its identity until a row
   * changes, and unchanged rows keep theirs, so it can be handed to UI
   * frameworks as it is.
   */
  get rows(): readonly T[] {
    if (!this.sorted) {
      const es = [...this.entries.values()]
      es.sort(this.compare ?? ((a, b) => this.keyOrder(a, b)))
      this.sorted = Object.freeze(es.map((e) => e.row))
    }
    return this.sorted
  }

  /** The row with the given primary key values. */
  get(...key: InputValue[]): T | undefined {
    return this.entries.get(keyString(key))?.row
  }

  get size(): number {
    return this.entries.size
  }

  /** Whether the first snapshot is applied. */
  get isReady(): boolean {
    return this.loaded
  }

  /** Why the live query stopped, when it failed (not when it was closed). */
  get error(): Error | null {
    return this.failure
  }

  /**
   * Calls listener after every consistent step that changed something, and
   * once when the query stops. Returns the function that removes it.
   */
  subscribe(listener: (ev: LiveEvent<T>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Same as the `rows` getter, bound, for `useSyncExternalStore`. */
  getSnapshot = (): readonly T[] => this.rows

  /** Iterates the events of the query, starting with its current rows, until it is closed. */
  async *[Symbol.asyncIterator](): AsyncGenerator<LiveEvent<T>, void, void> {
    const queue: LiveEvent<T>[] = []
    let wake: (() => void) | null = null
    const off = this.subscribe((ev) => {
      queue.push(ev)
      wake?.()
    })
    try {
      await this.ready
      yield { reset: true, changes: [], rows: this.rows }
      queue.length = 0
      for (;;) {
        const ev = queue.shift()
        if (ev) {
          yield ev
          continue
        }
        if (this.failure) throw this.failure
        if (this.sub.closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = null
      }
    } finally {
      off()
    }
  }

  /**
   * Compares a checksum of the local rows with the server's. It applies
   * what the server has sent meanwhile first, so it waits for the query to
   * be quiet for a moment when the table is being written.
   */
  async verify(opts?: CallOptions): Promise<VerifyResult> {
    await this.ready
    return this.sub.verify(() => {
      let sum = 0n
      for (const e of this.entries.values()) sum += rowHash(this.table, e.key, e.values, e.keyFloats, e.rowFloats)
      return { rows: this.entries.size, sum }
    }, opts)
  }

  /** Drops the local rows and takes a new snapshot (after a verify mismatch). */
  resync(): void {
    this.sub.resync()
  }

  /** The checkpoint the rows are at; see `Subscription.checkpoint`. */
  get checkpoint(): { checkpoint: number; epoch: bigint } {
    return this.sub.checkpoint
  }

  /** Stops the live query. */
  async close(): Promise<void> {
    await this.sub.close()
    await this.pump
  }
}
