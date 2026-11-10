/**
 * The ctx object a unit receives (docs/units.md, The ctx API). These are
 * types only: the engine supplies the object.
 */

/** A value read from SQLite: integers are numbers (bigint beyond 2^53), blobs Uint8Array. */
export type SqlValue = null | number | bigint | string | Uint8Array

/** What a statement argument may be: booleans are stored as 1/0, Dates as unix milliseconds. */
export type SqlArg = SqlValue | boolean | undefined | Date

/** A row as an object keyed by column name. */
export type Row = { [column: string]: SqlValue }

/** What a write returns. */
export interface ExecResult {
  rowsAffected: number
  lastInsertId: number
}

/** A statement of `ctx.db.batch`: `[sql, ...args]`. */
export type BatchStatement = readonly [sql: string, ...args: SqlArg[]]

/** Reads: what every unit can do with `ctx.db`. Calls are synchronous (`await` works too). */
export interface DbReader {
  /** The rows, as objects. */
  all<T = Row>(sql: string, ...args: SqlArg[]): T[]
  /** The first row, or null. */
  one<T = Row>(sql: string, ...args: SqlArg[]): T | null
  /** The first column of the first row, or null. */
  value<T extends SqlValue = SqlValue>(sql: string, ...args: SqlArg[]): T | null
}

/** Reads and writes: `ctx.db` in mutations and actions. */
export interface Db extends DbReader {
  /** Runs a write. In an action it commits on its own (see `tx`). */
  exec(sql: string, ...args: SqlArg[]): ExecResult
  /** Runs several writes, one result each. */
  batch(statements: readonly BatchStatement[]): ExecResult[]
  /**
   * In an action: runs fn in one write transaction (committed when it
   * returns, rolled back when it throws). Elsewhere it runs fn(ctx.db).
   */
  tx<T>(fn: (db: Db) => T): T
}

/** Who called the unit. */
export interface Auth {
  /** An API key, a client token, the dashboard or admin API, or a schedule or onChange run. */
  kind: 'key' | 'token' | 'admin' | 'system'
  /** `key:<name>`, the token's subject, `admin:<id>` or `system`. */
  principal: string
  /** The client token's subject (`"user:42"`), else "". */
  subject: string
  scopes: string[]
  /** A token's table allow-list ([] for none). */
  tables: string[]
  /** The token's custom claims ({} for none). */
  claims: { [claim: string]: unknown }
  /** Whether the caller has the scope. */
  has(scope: string): boolean
}

/** Unit kinds. */
export type UnitKind = 'query' | 'mutation' | 'action' | 'schedule' | 'onChange'

/** The run in progress. */
export interface UnitInfo {
  name: string
  kind: UnitKind
  /** What started the run. */
  trigger: 'call' | 'schedule' | 'change' | 'admin'
  /** The call's mutation id ("" for none). */
  mutationId: string
  /** The deploy version the run is on. */
  deploy: number
}

/** `ctx.log`: lines in the run log. */
export interface Log {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** `ctx.crypto`. */
export interface Crypto {
  /** SHA-256, hex. */
  sha256(data: string | Uint8Array): string
  /** HMAC-SHA256, hex. */
  hmac(key: string | Uint8Array, data: string | Uint8Array): string
  randomBytes(n: number): Uint8Array
}

/** Options of `ctx.fetch`. */
export interface FetchInit {
  method?: string
  headers?: { [name: string]: string }
  /** A string, bytes, or an object sent as JSON. */
  body?: string | Uint8Array | object
}

/** The response of `ctx.fetch`. */
export interface FetchResponse {
  status: number
  ok: boolean
  headers: { [name: string]: string }
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
}

/** What every unit receives. */
export interface BaseCtx {
  readonly db: DbReader
  readonly auth: Auth
  /**
   * Calls another unit (internal ones too), checking its arguments like a
   * call does. A query can run queries, a mutation queries and mutations
   * (in its own transaction), an action anything.
   */
  run<R = unknown>(name: string, args?: unknown): Promise<R>
  /** Secrets (`azora-units secrets set NAME`), undefined when not set. */
  readonly env: { readonly [name: string]: string | undefined }
  readonly log: Log
  /** Unix milliseconds. */
  now(): number
  /** A random UUID v4. */
  uuid(): string
  readonly crypto: Crypto
  readonly unit: UnitInfo
}

/** ctx in a query: reads only, one consistent snapshot. */
export interface QueryCtx extends BaseCtx {}

/** ctx in a mutation: one write transaction. */
export interface MutationCtx extends BaseCtx {
  readonly db: Db
}

/** ctx in an action: no implicit transaction, and fetch. */
export interface ActionCtx extends BaseCtx {
  readonly db: Db
  /** An HTTP request (actions only). */
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>
}

/** The full ctx (an action's). */
export type Ctx = ActionCtx

/** A row change an onChange unit receives. */
export interface Change<T = Row> {
  /** The change's position in the database's change log. */
  seq: number
  op: 'insert' | 'update' | 'delete'
  /** The row's primary key, by column (`{ id: 7 }`). */
  key: Row
  /** The row before (updates and deletes), else null. */
  old: T | null
  /** The row after (inserts and updates), else null. */
  new: T | null
}

/** The argument of an onChange handler. */
export interface ChangeBatch<T = Row> {
  /** At most `batch` changes, in commit order. */
  changes: Change<T>[]
  /** The change log dropped changes this unit had not seen yet. */
  gap: boolean
}
