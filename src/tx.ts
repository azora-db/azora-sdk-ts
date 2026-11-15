/** Interactive transactions: `db.tx` and the {@link Transaction} its callback gets. */
import type { Client, TxHandle } from './client.ts'
import { toValue, type InputValue, type Value } from './codec.ts'
import { ClosedError, TxExpiredError } from './errors.ts'
import type { Result } from './messages.ts'
import type { ExecResult, QueryResult, Row, Statement } from './types.ts'
import type { CallOptions } from './util.ts'

/** @internal */
export type Args = readonly InputValue[]

/** @internal */
export function normalize(args: Args | undefined): Value[] | null {
  if (!args || args.length === 0) return null
  const out = new Array<Value>(args.length)
  for (let i = 0; i < args.length; i++) {
    try {
      out[i] = toValue(args[i])
    } catch (e) {
      throw new TypeError(`azora: argument ${i + 1}: ${(e as Error).message}`)
    }
  }
  return out
}

/** @internal Splits the (sql, args?, opts?) | (statement, opts?) call shapes. */
export function unpack<O>(a: string | Statement, b?: Args | O, c?: O): { sql: string; args: Value[] | null; opts: O | undefined } {
  if (typeof a === 'string') {
    if (b !== undefined && !Array.isArray(b)) return { sql: a, args: null, opts: b as O }
    return { sql: a, args: normalize(b as Args | undefined), opts: c }
  }
  return { sql: a.sql, args: normalize(a.args), opts: (b as O | undefined) ?? c }
}

/** @internal */
export function toObjects<T>(columns: readonly string[], rows: readonly Value[][]): T[] {
  const n = columns.length
  const out = new Array<T>(rows.length)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as Value[]
    const obj: Row = {}
    for (let i = 0; i < n; i++) obj[columns[i] as string] = row[i] ?? null
    out[r] = obj as T
  }
  return out
}

/** Options of `db.tx`. */
export interface TxOptions extends CallOptions {
  /**
   * Your own mutation id (at most 128 bytes), sent with the commit: a
   * transaction that ends with an id that already committed is rolled
   * back instead, and `db.tx` resolves as if it had committed. Use it to
   * run a transaction again after an UnknownOutcomeError: with the same
   * id it cannot apply twice (within the server's
   * `realtime.mutation_window`).
   */
  mutationId?: string
}

/**
 * An open interactive transaction, as the callback of `db.tx` gets it. Its
 * reads see its own writes; nobody else sees them before the commit. It
 * lives on one connection and under the server's lease ({@link idleMs}):
 * once the connection or the lease is lost, every call rejects with a
 * {@link TxExpiredError}. After the callback returned or threw, calls
 * reject with a ClosedError.
 *
 * Statements run in the order they are called. Schema changes (CREATE,
 * ALTER, DROP) and BEGIN/COMMIT/ROLLBACK/SAVEPOINT are refused. A statement
 * that fails (a constraint, bad SQL) rejects and leaves the transaction
 * open: catch the error to go on, or let it out to roll back.
 */
export class Transaction {
  /**
   * The server's idle lease in milliseconds: the transaction is rolled
   * back when it stays this long without a statement.
   */
  readonly idleMs: number

  private readonly client: Client
  private readonly handle: TxHandle
  private ended: 'committed' | 'rolled back' | null = null
  private lost: TxExpiredError | null = null

  /** @internal Use `db.tx`. */
  constructor(client: Client, handle: TxHandle) {
    this.client = client
    this.handle = handle
    this.idleMs = handle.idleMs
  }

  /** @internal The callback ended: later calls reject. */
  end(how: 'committed' | 'rolled back'): void {
    this.ended = how
  }

  /** @internal Whether the server is known to have dropped the transaction. */
  get expired(): boolean {
    return this.lost !== null
  }

  private async run(sql: string, args: Value[] | null, query: boolean, opts?: CallOptions): Promise<Result> {
    if (this.ended) throw new ClosedError(`azora: the transaction has ended (${this.ended})`)
    if (this.lost) throw this.lost
    try {
      return await this.client.txStmt(this.handle, sql, args, query, opts)
    } catch (e) {
      if (e instanceof TxExpiredError) this.lost = e
      throw e
    }
  }

  /** Runs a read inside the transaction and returns its rows as objects keyed by column name (at most 10,000). */
  async query<T = Row>(sql: string, args?: Args, opts?: CallOptions): Promise<T[]>
  async query<T = Row>(statement: Statement, opts?: CallOptions): Promise<T[]>
  async query<T = Row>(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<T[]> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.run(sql, args, true, opts)
    return toObjects<T>(r.columns, r.rows)
  }

  /** Runs a read and returns columns and rows as arrays, with `truncated`. */
  async queryRaw(sql: string, args?: Args, opts?: CallOptions): Promise<QueryResult>
  async queryRaw(statement: Statement, opts?: CallOptions): Promise<QueryResult>
  async queryRaw(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<QueryResult> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.run(sql, args, true, opts)
    return { columns: r.columns, rows: r.rows, truncated: r.truncated }
  }

  /** The first row of a read, or undefined when it returns none. */
  async queryOne<T = Row>(sql: string, args?: Args, opts?: CallOptions): Promise<T | undefined>
  async queryOne<T = Row>(statement: Statement, opts?: CallOptions): Promise<T | undefined>
  async queryOne<T = Row>(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<T | undefined> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.run(sql, args, true, opts)
    return toObjects<T>(r.columns, r.rows.slice(0, 1))[0]
  }

  /** The first column of the first row, or undefined when there is no row. */
  async queryValue<T extends Value = Value>(sql: string, args?: Args, opts?: CallOptions): Promise<T | undefined>
  async queryValue<T extends Value = Value>(statement: Statement, opts?: CallOptions): Promise<T | undefined>
  async queryValue<T extends Value = Value>(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<T | undefined> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const row = (await this.run(sql, args, true, opts)).rows[0]
    return row ? ((row[0] ?? null) as T) : undefined
  }

  /**
   * Runs a write inside the transaction. `rowsAffected` and `lastInsertId`
   * are this statement's; `replayed` is always false. Nothing is applied
   * before the commit.
   */
  async exec(sql: string, args?: Args, opts?: CallOptions): Promise<ExecResult>
  async exec(statement: Statement, opts?: CallOptions): Promise<ExecResult>
  async exec(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<ExecResult> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.run(sql, args, false, opts)
    return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId, replayed: r.replayed }
  }
}

/** @internal Begins a transaction on client, runs fn, then commits (fn resolved) or rolls back (fn threw). */
export async function runTx<T>(client: Client, fn: (tx: Transaction) => T | Promise<T>, opts?: TxOptions): Promise<T> {
  const handle = await client.txBegin(opts)
  const tx = new Transaction(client, handle)
  try {
    let value: T
    try {
      value = await fn(tx)
    } catch (e) {
      tx.end('rolled back')
      // Best effort: the server rolls back by itself when the lease runs
      // out or the connection ends, and answers tx_expired once it has.
      if (!tx.expired) await client.txEnd(handle, false, '').catch(() => {})
      throw e
    }
    tx.end('committed')
    await client.txEnd(handle, true, opts?.mutationId ?? '', opts)
    return value
  } finally {
    handle.release()
  }
}
