/**
 * The ctx object a unit receives (docs/units.md, The ctx API). These are
 * types only: the engine supplies the object.
 */

/** A value read from SQLite: integers are numbers (bigint beyond 2^53), blobs Uint8Array. */
export type SqlValue = null | number | bigint | string | Uint8Array

/**
 * What a statement argument may be: booleans are stored as 1/0, Dates as
 * unix milliseconds, and a `ctx.storage.upload(...)` is stored as a file
 * whose id takes its place.
 */
export type SqlArg = SqlValue | boolean | undefined | Date | FileUpload

/** A stored file. */
export interface StoredFile {
  id: string
  bucket: string
  /** The file's path in its bucket ("" for none). */
  path: string
  name: string
  contentType: string
  size: number
  sha256: string
  metadata: { [key: string]: string }
  /** Image dimensions, when the file is an image. */
  width?: number
  height?: number
  /** Unix milliseconds. */
  createdAt: number
}

/** Options of a file a unit stores. */
export interface FileOptions {
  /** Default: the bucket named `default`. */
  bucket?: string
  /** A key unique within the bucket (`"invoices/2026/7.pdf"`). */
  path?: string
  /** The file name (the download name; the type is detected from it and the content). */
  name?: string
  contentType?: string
  metadata?: { [key: string]: string }
  /** Replace the content of the file at `path` (its id stays). */
  overwrite?: boolean
  /** Keep the file when no row references it any more (`put` always keeps). */
  keep?: boolean
}

/**
 * A file waiting to be stored: pass it as a statement argument, once. The
 * file is stored in the statement's transaction and the argument becomes
 * its id, so the file exists if and only if the row does.
 */
export interface FileUpload {
  readonly '~upload': true
}

/** What a signed upload link may store (the grant of `ctx.storage.uploadUrl`). */
export interface UploadGrant {
  bucket?: string
  path?: string
  overwrite?: boolean
  /** Comma-separated content types (`"image/png,image/jpeg"`, `"image/*"`). */
  allowed_types?: string
  max_size?: number
  keep?: boolean
  metadata?: { [key: string]: string }
  /** Store the new file's id in this row's column, in the upload's transaction. */
  table?: string
  column?: string
  /** The column that identifies the row (default `rowid`) and its value. */
  key?: string
  key_value?: string
}

/** Reading files: `ctx.storage` in every unit. Calls are synchronous (`await` works too). */
export interface StorageReader {
  /** The file, or null when there is none with that id. */
  stat(id: string): StoredFile | null
  /** The file at a path of a bucket (default bucket `default`), or null. */
  statPath(path: string, bucket?: string): StoredFile | null
  /** The content (at most `units.max_file_bytes`; check `stat(id).size` first for large files). */
  read(id: string): Uint8Array
  /** The content as UTF-8 text. */
  text(id: string): string
  /**
   * A signed download link, valid for `ttl` seconds (default: the
   * server's). `download` serves the file as an attachment, under that
   * name when it is a string.
   */
  url(id: string, opts?: { ttl?: number; download?: boolean | string }): string
}

/** Reading and writing files: `ctx.storage` in mutations and actions. */
export interface Storage extends StorageReader {
  /**
   * A file for a statement argument:
   * `ctx.db.exec('UPDATE users SET avatar = ? WHERE id = ?', ctx.storage.upload(bytes, { name }), id)`.
   * It belongs to the rows that reference it, and is deleted with the last of them unless `keep`.
   */
  upload(content: string | Uint8Array, opts?: FileOptions): FileUpload
  /**
   * Stores a file on its own, kept until deleted. In a mutation it is
   * part of the transaction: a mutation that throws stores nothing. In an
   * action it is stored at once (inside `ctx.db.tx`, use `upload` with
   * the callback's db instead).
   */
  put(content: string | Uint8Array, opts?: FileOptions): StoredFile
  /**
   * Deletes a file, in the transaction like `put`. False when there is
   * none. A file rows still reference is refused unless `force`, which
   * sets those columns to NULL.
   */
  delete(id: string, opts?: { force?: boolean }): boolean
  /**
   * A signed upload link: whoever holds it can upload one file under the
   * grant, without a credential. This is how a unit lets its caller
   * upload after checking what the caller may do.
   */
  uploadUrl(grant?: UploadGrant, opts?: { ttl?: number }): { url: string; expiresAt: number }
}

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
  /**
   * An API key, a client token, the dashboard or admin API, a schedule,
   * onChange or job run, or `public`: an HTTP request without a
   * credential to a unit declared `http: 'public'`.
   */
  kind: 'key' | 'token' | 'admin' | 'system' | 'public'
  /** `key:<name>`, the token's subject, `admin:<id>`, `system`, or `job:<id>` in a job. */
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

/**
 * What started a run: a client's `call`, a `schedule`, a `change`
 * (onChange), a `job` (`ctx.scheduler`), `admin` (the admin API and the
 * dashboard), `cli` (`azora-units call`, `db.unitsAdmin.call`) or `mcp`
 * (an AI agent).
 */
export type UnitTrigger = 'call' | 'schedule' | 'change' | 'job' | 'admin' | 'cli' | 'mcp'

/** The job a run is executing (`ctx.unit.job`). */
export interface JobInfo {
  /** `job_` and 26 characters; also the run's mutation id. */
  id: string
  /** 1 on the first run, 2 on the first retry, ... */
  attempt: number
  /** When the job was scheduled (unix ms). */
  scheduledAt: number
  /** The principal of the run that scheduled it. */
  scheduledBy: string
  /** The unit that scheduled it. */
  source: string
}

/** The run in progress. */
export interface UnitInfo {
  name: string
  kind: UnitKind
  /** What started the run. */
  trigger: UnitTrigger
  /** The call's mutation id ("" for none; the job id in a job). */
  mutationId: string
  /** The deploy version the run is on. */
  deploy: number
  /** The job this run executes, or null when it is not a job. */
  job: JobInfo | null
}

/** `ctx.log`: lines in the run log. */
export interface Log {
  info(...args: unknown[]): void
  /** Same as info. */
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** `ctx.crypto`. Strings are taken as UTF-8. */
export interface Crypto {
  /** SHA-256, hex. */
  sha256(data: string | Uint8Array): string
  /** HMAC-SHA256, hex. */
  hmac(key: string | Uint8Array, data: string | Uint8Array): string
  /** n (at most 65536) random bytes. */
  randomBytes(n: number): Uint8Array
  /** Compares in constant time (for signatures). */
  timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean
}

type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never

/** The arguments a job of unit N of module M takes (left out when the unit takes none). */
type JobArgs<M, N extends keyof M> =
  BrandOf<M[N]> extends { args: infer A } ? (undefined extends A ? [args?: A] : [args: A]) : [args?: unknown]

/**
 * `ctx.scheduler`: runs a mutation or action later, once (docs/units.md,
 * Jobs). In a mutation the job is written in its transaction: it is never
 * scheduled if the mutation throws. Each method returns or takes the job
 * id (`job_` and 26 characters).
 *
 * Unit names are strings and arguments unknown. To have them checked
 * against your units, give the module's type:
 *
 * ```ts
 * type Units = typeof import('./index.ts')
 * const scheduler = ctx.scheduler as Scheduler<Units>
 * scheduler.after(24 * 3600e3, 'remindUnpaid', { orderId })  // name and args checked
 * ```
 */
export interface Scheduler<M = unknown> {
  /** Runs the unit in ms milliseconds (0: as soon as possible; at most 366 days). */
  after<N extends SchedulerName<M>>(ms: number, unit: N, ...args: SchedulerArgs<M, N>): string
  /** Runs the unit at a time (a Date or unix ms; a past time runs it as soon as possible). */
  at<N extends SchedulerName<M>>(when: Date | number, unit: N, ...args: SchedulerArgs<M, N>): string
  /** Removes a waiting job; true if there was one. */
  cancel(id: string): boolean
}

type SchedulerName<M> = unknown extends M ? string : keyof M & string
type SchedulerArgs<M, N> = unknown extends M ? [args?: unknown] : N extends keyof M ? JobArgs<M, N> : [args?: unknown]

/** Options of `ctx.fetch`. */
export interface FetchInit {
  method?: string
  headers?: { [name: string]: string }
  /** A string, bytes, or an object sent as JSON. */
  body?: string | Uint8Array | object
}

/** The headers of a `ctx.fetch` response. */
export interface FetchHeaders {
  /** The header's values joined with ", ", or null. */
  get(name: string): string | null
  has(name: string): boolean
  /** [lower-case name, value] pairs, sorted by name. */
  entries(): [name: string, value: string][]
}

/** The response of `ctx.fetch`. */
export interface FetchResponse {
  status: number
  statusText: string
  ok: boolean
  /** The final URL (after redirects). */
  url: string
  redirected: boolean
  headers: FetchHeaders
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
  bytes(): Promise<Uint8Array>
}

/** The request of a unit called over plain HTTP (`ctx.request`). */
export interface HttpRequest {
  method: string
  /** What follows the unit's name in the URL: "" or "/...". */
  path: string
  /** The first value of each query parameter. */
  query: { [name: string]: string }
  /** Each header under its lower-case name (several values joined with ", "); never the credential. */
  headers: { [name: string]: string }
  /** The body as text, as it came: what a webhook's signature is computed over. */
  body: string
  /** The body's bytes, for content that is not text. */
  bytes: Uint8Array
  /** The client's address. */
  ip: string
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
  /** The database's stored files. */
  readonly storage: StorageReader
  /** The HTTP request, when the unit was called over plain HTTP (it declares `http`); else null. */
  readonly request: HttpRequest | null
}

/** ctx in a query: reads only, one consistent snapshot. */
export interface QueryCtx extends BaseCtx {}

/** ctx in a mutation: one write transaction. */
export interface MutationCtx extends BaseCtx {
  readonly db: Db
  readonly storage: Storage
  /** Jobs: run a mutation or action later, in this mutation's transaction. */
  readonly scheduler: Scheduler
}

/** ctx in an action: no implicit transaction, and fetch. */
export interface ActionCtx extends BaseCtx {
  readonly db: Db
  readonly storage: Storage
  /** Jobs: run a mutation or action later (written at once, or in `ctx.db.tx`). */
  readonly scheduler: Scheduler
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
