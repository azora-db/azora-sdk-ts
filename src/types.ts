/** Public data types of queries and subscriptions. */
import type { InputValue, Value } from './codec.ts'
import type { Filter } from './filter.ts'

/** One row as an object keyed by column name. */
export type Row = Record<string, Value>

/** A statement with its arguments (see the `sql` tag). */
export interface Statement {
  sql: string
  args?: readonly InputValue[]
}

/** The rows of a query. */
export interface QueryResult {
  columns: string[]
  /** Rows as arrays, in column order. */
  rows: Value[][]
  /** The server's row limit cut the result. */
  truncated: boolean
}

/** What a write did. */
export interface ExecResult {
  rowsAffected: number
  lastInsertId: number | bigint
  /**
   * The write was answered from its first run: the same mutation id had
   * already been applied (for example before a reconnect).
   */
  replayed: boolean
}

/** A change operation. */
export type Operation = 'insert' | 'update' | 'delete'

/**
 * One row change. `key` holds the primary key values; `new` the row after
 * an insert or update, `old` the row before an update or delete (both
 * positional, matching `columns`). Snapshot rows are inserts with `seq` 0.
 */
export interface Change {
  seq: number
  table: string
  op: Operation
  key: Value[]
  new: Value[] | null
  old: Value[] | null
  /** Column names of `new` and `old`; shared between changes, do not modify. */
  columns: readonly string[]
  /** Primary key column names. */
  pk: readonly string[]
  /** @internal The table version the row is laid out in. */
  tv: number
  /** @internal Positions of integral floats (see Reader.lastFloats). */
  keyFloats?: number[]
  /** @internal */
  newFloats?: number[]
}

/**
 * What a subscription delivers: a consistent step. Apply `changes` in
 * order, after dropping your copy of the subscription's rows when `reset`
 * is set; you are then at `checkpoint`. Store `epoch` and `checkpoint` to
 * resume in a later process.
 */
export interface Update {
  /** Drop every row of this subscription before applying `changes`. */
  reset: boolean
  /** `changes` are the subscription's current rows (inserts). */
  snapshot: boolean
  changes: Change[]
  /** The consistent point reached. */
  checkpoint: number
  epoch: bigint
  /**
   * Changed tables (notify subscriptions); `*` means any table may have
   * changed (missed signals, for example after a reconnect).
   */
  tables: string[]
}

/** What a subscription covers. */
export type SubscriptionKind = 'database' | 'table' | 'row' | 'files' | 'notify'

/** Describes a subscription. */
export interface SubscribeSpec {
  /**
   * Defaults from the other fields: `row` with `table` and `key`, `table`
   * with `table`, `notify` with `tables`, `files` with `bucket` or
   * `pathPrefix`, else `database` (every published table).
   */
  kind?: SubscriptionKind
  /** The table of a table or row subscription. */
  table?: string
  /** A row subscription's primary key values, in key order; a files subscription's object id. */
  key?: readonly InputValue[]
  /** Filters a table subscription: a {@link Filter} or filter text (`"status = 'paid' AND total > 100"`). */
  where?: Filter | string
  /** Limits the operations delivered (default: all). */
  ops?: readonly Operation[]
  /**
   * Resume from a checkpoint the application stored (`Update.checkpoint`
   * and `Update.epoch`); without `since` the subscription starts with a
   * snapshot of the matching rows (unless `noSnapshot`).
   */
  since?: number
  epoch?: bigint
  /** Skip the initial snapshot: only changes from now on. */
  noSnapshot?: boolean
  /** Narrow a files subscription. */
  bucket?: string
  pathPrefix?: string
  /** Narrows a notify subscription (empty: every table). */
  tables?: readonly string[]
  /**
   * Make `next()` reject with ResyncError when the resume point is gone,
   * instead of taking a new snapshot automatically.
   */
  manualResync?: boolean
}

/** Compares the server's checksum of a subscription's rows with the application's. */
export interface VerifyResult {
  /** Equal row counts and sums. */
  match: boolean
  /** Where the server computed its checksum. */
  checkpoint: number
  epoch: bigint
  serverRows: number
  serverSum: bigint
  localRows: number
  localSum: bigint
}

/** Counters of a client. */
export interface Stats {
  connected: boolean
  /** Established sessions, sessions that ended, failed attempts. */
  connects: number
  disconnects: number
  connectFailures: number
  /** Requests sent again after their connection dropped. */
  retries: number
  /** Requests the server asked to retry later. */
  rateLimited: number
  /** Subscriptions that took a new snapshot. */
  resyncs: number
  /** Credentials sent to an open session. */
  credentialRefreshes: number
  /** Open subscriptions. */
  subscriptions: number
}
