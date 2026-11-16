/** The test environment's public types (createTestEnv, its options and answers). */
import type { DatabaseSync } from 'node:sqlite'
import type { UnitJob, UnitRun, Units } from '@azora-db/client'
import type { FileOptions, Row, StoredFile } from '../ctx.ts'

// Types.

export type Kind = 'query' | 'mutation' | 'action' | 'schedule' | 'onChange'
export type Runs = 'query' | 'mutation' | 'action'

/** Who calls (ctx.auth). Left-out fields get defaults from `kind`. */
export interface TestAuth {
  /** Default: "token" when `subject` is given, else "key". */
  kind?: 'key' | 'token' | 'admin' | 'system'
  /** Default: `key:test`, the subject for a token, `admin:test`, `system`. */
  principal?: string
  /** A client token's subject (`"user:42"`). */
  subject?: string
  /** Default: ["read", "write"] for keys and tokens, ["admin"] for admin, [] for system. */
  scopes?: string[]
  tables?: string[]
  claims?: Record<string, unknown>
}

/** A WHATWG fetch: `globalThis.fetch` for real requests, or a mock returning `new Response(...)`. */
export type TestFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; redirect: 'follow' },
) => Promise<Response>

export interface TestEnvOptions {
  /** SQL run once on the empty database (each string may hold several statements). */
  schema?: string | readonly string[]
  /** The caller of `t.call` (default: an API key, `key:test`). */
  auth?: TestAuth
  /** Secrets: `ctx.env`. */
  env?: Record<string, string>
  /** What `ctx.fetch` uses. Without it, ctx.fetch throws. */
  fetch?: TestFetch
  /** The clock's start (unix ms or a Date; default: now). It moves only with `t.advance`. */
  now?: number | Date
  /** Random bytes for ctx.uuid, ctx.crypto.randomBytes, job and mutation ids (default: node:crypto). */
  random?: (n: number) => Uint8Array
  /** Runs of a job before it is marked failed (`units.job_attempts`, default 5). */
  jobAttempts?: number
  /** The engine's per-call limits (defaults: the engine's). */
  limits?: {
    maxStatements?: number
    maxRows?: number
    maxValueBytes?: number
    maxFileBytes?: number
    maxJobs?: number
    fetchCalls?: number
    fetchBytes?: number
  }
  /** Called with every ctx.log line as it is written. */
  onLog?: (line: TestLogLine) => void
}

/** A line a unit logged. */
export interface TestLogLine {
  at: number
  /** The unit of the run (the outermost one: ctx.run logs into its caller's run). */
  unit: string
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Options of `t.call`. */
export interface TestCallOptions {
  /** Call as someone else than the env's `auth`. */
  auth?: TestAuth
  /**
   * How the call arrives: `client` (default: `db.call`, internal units
   * refused, trigger `call`), `cli` (`azora-units call`,
   * `db.unitsAdmin.call`: internal units allowed, trigger `cli`) or
   * `admin` (the admin API and dashboard: as an admin, internal units
   * allowed, trigger `admin`).
   */
  as?: 'client' | 'cli' | 'admin'
  /** The call's mutation id (default: a fresh one, as the SDK sends; "" for cli and admin). */
  mutationId?: string
}

/** A row change for `t.change`; `key` defaults to the row's primary key, `seq` to a counter. */
export interface TestChange {
  op: 'insert' | 'update' | 'delete'
  key?: Record<string, unknown>
  old?: Record<string, unknown> | null
  new?: Record<string, unknown> | null
  seq?: number
}

/** `t.db`: the database as a test sees it (no SQL check; values as units see them). */
export interface TestDb {
  all<T = Row>(sql: string, ...args: unknown[]): T[]
  one<T = Row>(sql: string, ...args: unknown[]): T | null
  value<T = unknown>(sql: string, ...args: unknown[]): T | null
  exec(sql: string, ...args: unknown[]): { rowsAffected: number; lastInsertId: number }
  /** The node:sqlite database itself. */
  readonly raw: DatabaseSync
}

export type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never
export type CallableName<M> = unknown extends M
  ? string
  : {
      [K in keyof M]: [BrandOf<M[K]>] extends [never]
        ? never
        : BrandOf<M[K]> extends { kind: 'query' | 'mutation' | 'action' }
          ? K
          : never
    }[keyof M] &
      string
export type CallRest<M, N> = unknown extends M
  ? [args?: unknown, opts?: TestCallOptions]
  : N extends keyof M
    ? BrandOf<M[N]> extends { args: infer A }
      ? undefined extends A
        ? [args?: A, opts?: TestCallOptions]
        : [args: A, opts?: TestCallOptions]
      : never
    : never
export type CallResult<M, N, R> = unknown extends M
  ? R
  : N extends keyof M
    ? BrandOf<M[N]> extends { result: infer X }
      ? Awaited<X>
      : never
    : never

/**
 * A local test environment (see {@link createTestEnv}). M is the type of
 * the units module: it types `call` and `units`.
 */
export interface TestEnv<M = unknown> {
  /**
   * Calls a unit as a client does (`db.call`): arguments and result go
   * through JSON (blobs as Uint8Array), a thrown UnitError rejects with
   * @azora-db/client's `UnitError`, a failure around the unit (no such
   * unit, an internal unit, arguments that do not match) with its
   * `AzoraError`.
   */
  call<N extends CallableName<M>, R = unknown>(name: N, ...rest: CallRest<M, N>): Promise<CallResult<M, N, R>>
  /** The units as functions, like `db.units` (`t.units.checkout({ cartId })`). */
  readonly units: Units<M>
  /** The database, to set up and inspect state (no SQL check). */
  readonly db: TestDb
  /** Runs a schedule unit once, as the engine does on its schedule; rejects like `call` when it fails. */
  runSchedule(name: string): Promise<void>
  /**
   * Runs an onChange unit with these changes (those of its `ops`, in
   * batches of its `batch`). Writes do not trigger onChange units by
   * themselves here: call this with the changes to test.
   */
  change(name: string, changes: readonly TestChange[], o?: { gap?: boolean }): Promise<void>
  /** The jobs waiting (the next due first), then the failed ones. */
  jobs(filter?: { state?: 'pending' | 'failed'; unit?: string }): UnitJob[]
  /** Runs the jobs due now (and those they schedule for now); resolves with how many ran. */
  runJobs(): Promise<number>
  /** Moves the clock ms ahead, running each job when it falls due (retries included); resolves with how many ran. */
  advance(ms: number): Promise<number>
  /** The clock (unix ms): `ctx.now()`. */
  now(): number
  /** Removes a job, waiting or failed (`azora-units jobs cancel`). */
  cancelJob(id: string): boolean
  /** Makes a failed job wait again, due now, its attempts reset (`azora-units jobs retry`). */
  retryJob(id: string): void
  /** The run log, oldest first (`azora-units logs`). */
  runs(filter?: { unit?: string; status?: string }): UnitRun[]
  /** Every ctx.log line, oldest first. */
  logs(filter?: { unit?: string }): TestLogLine[]
  /**
   * Sends an HTTP request to a unit that declares `http`, as the server
   * would answer it at `/units/v1/<database>/<unit>`. Without `auth` the
   * request has no credential (the caller is `public`).
   */
  request(name: string, init?: TestRequest): Promise<TestResponse>
  /** The files units see through `ctx.storage`: seed them before a call, look at them after. */
  readonly storage: TestStorage
  /** Closes the database. */
  close(): void
}

/** A request of `t.request`. */
export interface TestRequest {
  /** Default: POST with a body, GET without. */
  method?: string
  /** What follows the unit's name in the URL (`"/items/7"`). */
  path?: string
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  /** A string or bytes as they are; anything else is sent as JSON. */
  body?: unknown
  /** The credential the request carries (default: none). */
  auth?: TestAuth
  /** The client's address (default 127.0.0.1). */
  ip?: string
}

/** The answer of `t.request`. */
export interface TestResponse {
  status: number
  /** Lower-case names. */
  headers: Record<string, string>
  /** The body as text. */
  body: string
  bytes: Uint8Array
  /** The body parsed as JSON. */
  json(): unknown
}

/** `t.storage`: the test's own access to the stored files. */
export interface TestStorage {
  /** Stores a file (kept until deleted), as a unit's `ctx.storage.put` does. */
  put(content: string | Uint8Array, opts?: FileOptions): StoredFile
  stat(id: string): StoredFile | null
  /** The content, or null when there is no such file. */
  read(id: string): Uint8Array | null
  text(id: string): string | null
  /** Every file, oldest first. */
  list(): StoredFile[]
}
