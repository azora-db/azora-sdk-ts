/**
 * The local test environment: a user's units run in Node against an
 * in-memory SQLite database (node:sqlite), with the engine's semantics
 * (internal/units: engine.go, host.go, scheduler.go, jobs.go): kinds and
 * transactions, ctx.run, argument checks, the SQL check, value
 * conversions, the run log, jobs with their retries.
 */
import { createHash, createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { AzoraError, UnitError as CallError, type UnitJob, type UnitRun, type Units } from '@azora-db/client'
import type { Row } from '../ctx.ts'
import { isUnitDefinition, isUnitName } from '../define.ts'
import { bytesOf, clientStringify, engineStringify, parseJSON } from './json.ts'
import { compileSchema, takesObject, validate, type Schema } from './schema.ts'
import { checkSQL, rowObject, sqlArg, TABLE_PREFIX, type Bound } from './sql.ts'

// Types.

type Kind = 'query' | 'mutation' | 'action' | 'schedule' | 'onChange'
type Runs = 'query' | 'mutation' | 'action'

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
export type TestFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; redirect: 'follow' }) => Promise<Response>

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
  limits?: { maxStatements?: number; maxRows?: number; maxValueBytes?: number; maxJobs?: number; fetchCalls?: number; fetchBytes?: number }
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

type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never
type CallableName<M> = unknown extends M
  ? string
  : { [K in keyof M]: [BrandOf<M[K]>] extends [never] ? never : BrandOf<M[K]> extends { kind: 'query' | 'mutation' | 'action' } ? K : never }[keyof M] & string
type CallRest<M, N> = unknown extends M
  ? [args?: unknown, opts?: TestCallOptions]
  : N extends keyof M
    ? BrandOf<M[N]> extends { args: infer A }
      ? undefined extends A
        ? [args?: A, opts?: TestCallOptions]
        : [args: A, opts?: TestCallOptions]
      : never
    : never
type CallResult<M, N, R> = unknown extends M ? R : N extends keyof M ? (BrandOf<M[N]> extends { result: infer X } ? Awaited<X> : never) : never

// The engine's errors around a unit (Go's sentinel errors).

type FailCode = 'not_found' | 'permission_denied' | 'invalid' | 'resource_exhausted'
const PREFIX: Record<FailCode, string> = { not_found: 'not found', permission_denied: 'permission denied', invalid: 'invalid', resource_exhausted: 'limit exceeded' }

/** A failure around the unit: the caller gets an AzoraError with code and message. */
class Failure extends Error {
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

const q = (s: string): string => JSON.stringify(s)

// Units.

interface Def {
  name: string
  kind: Kind
  runs: Runs
  internal: boolean
  handler: (ctx: unknown, args: unknown) => unknown
  schema: Schema | null
  table: string
  ops: string[]
  batch: number
}

function load(units: Record<string, unknown>): Map<string, Def> {
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
    const def: Def = {
      name, kind, runs: trigger ? (mode as Runs) : (kind as Runs), internal: trigger || Boolean(o['internal']),
      handler: o['handler'] as Def['handler'], schema, table: '', ops: [], batch: 100,
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
  if (out.size === 0) throw new Error('azora units: no units (export query, mutation, action, schedule or onChange definitions)')
  return out
}

// node:sqlite.

/** The minimum Node.js versions with node:sqlite without a flag. */
export const NODE_SQLITE = '22.13.0 (or 23.4.0 and later)'

function openSqlite(): typeof import('node:sqlite') {
  let mod: typeof import('node:sqlite') | undefined
  try {
    mod = (process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined) ?? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  } catch {
    mod = undefined
  }
  if (!mod?.DatabaseSync) {
    throw new Error(`@azora-db/units/testing needs node:sqlite, which Node.js has without a flag from ${NODE_SQLITE}; this is Node.js ${process.version}`)
  }
  return mod
}

const INTERNAL_SCHEMA = `
CREATE TABLE ${TABLE_PREFIX}_jobs(id TEXT PRIMARY KEY, unit TEXT NOT NULL, args TEXT NOT NULL, run_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
CREATE TABLE ${TABLE_PREFIX}_results(id TEXT PRIMARY KEY, at INTEGER NOT NULL, unit TEXT NOT NULL, result TEXT NOT NULL);`

interface JobRow {
  id: string
  unit: string
  args: string
  run_at: number
  created_at: number
  created_by: string
  source: string
  attempts: number
  state: 'pending' | 'failed'
  error: string
}

const MAX_JOB_DELAY = 366 * 24 * 3600e3
const MAX_RUN_DEPTH = 8
const MAX_LOG_BYTES = 4 << 10

/** How long a job waits after its n-th failed attempt: 1s, 2s, 4s ... up to an hour. */
export function jobBackoff(n: number): number {
  const k = Math.max(1, n)
  return k > 12 ? 3600e3 : Math.min(2 ** (k - 1) * 1000, 3600e3)
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(b: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const x of b) {
    value = (value << 8) | x
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

/** A string, bytes or nothing as bytes (the engine's bytesArg). */
function bytesArg(v: unknown): Uint8Array {
  if (v === null || v === undefined) return new Uint8Array()
  if (typeof v === 'string') return new TextEncoder().encode(v)
  const b = bytesOf(v)
  if (b) return b
  throw new TypeError('expected a string, Uint8Array or ArrayBuffer')
}

// A run.

/** A transaction a frame holds (the connection has one at a time). */
interface Hold {
  write: boolean
  ended: boolean
  /** It began the connection's transaction (false: it runs inside one already open). */
  own: boolean
}

interface Frame {
  unit: Def
  kind: Runs
  tx: Hold | null
  write: boolean
}

interface Caller {
  kind: 'key' | 'token' | 'admin' | 'system'
  principal: string
  subject: string
  scopes: string[]
  tables: string[]
  claims: Record<string, unknown>
}

interface Request {
  unit: string
  args: string
  mutationId: string
  caller: Caller
  external: boolean
  trigger: string
  noValidate?: boolean
  inTx?: () => void
  afterAction?: () => void
  job?: JobRow
}

interface Answer {
  value: string
  replayed: boolean
  /** What the unit threw; stack (for the run log) only for values that are not a UnitError. */
  err: { code: string; message: string; data: string; stack: string } | null
}

const CODES = new Set(['invalid', 'not_found', 'permission_denied', 'conflict', 'failed'])

/** One run of a unit and everything nested in it (host.go's call). */
class Call {
  stmts = 0
  rows = 0
  fetches = 0
  depth = 0
  logs = ''
  logFull = false
  limitErr: Failure | null = null
  open: Hold[] = []
  writeOpen = 0
  jobsPending: number | null = null

  readonly t: TestEnvImpl
  readonly req: Request
  readonly top: Def

  constructor(t: TestEnvImpl, req: Request, top: Def) {
    this.t = t
    this.req = req
    this.top = top
  }

  /** Raises an error in the unit, as the engine's host functions do. */
  throw(msg: string): never {
    throw new Error(msg)
  }

  limit(msg: string): never {
    this.limitErr ??= new Failure('resource_exhausted', `unit ${this.top.name}: ${msg}`)
    throw new Error(msg)
  }

  log(level: TestLogLine['level'], args: unknown[]): void {
    const message = args
      .map((a) => {
        if (a === undefined) return 'undefined'
        if (typeof a === 'string') return a
        if (typeof a === 'object' && a !== null) {
          const st = (a as { stack?: unknown }).stack
          if (typeof st === 'string') return st
          try {
            return engineStringify(a)
          } catch {
            return String(a)
          }
        }
        return String(a)
      })
      .join(' ')
    const line: TestLogLine = { at: this.t.clock, unit: this.top.name, level, message }
    this.t.logLines.push(line)
    this.t.o.onLog?.(line)
    if (this.logFull) return
    const text = `${level}: ${message}\n`
    if (Buffer.byteLength(this.logs) + Buffer.byteLength(text) > MAX_LOG_BYTES) {
      this.logs += Buffer.from(text).subarray(0, MAX_LOG_BYTES - Buffer.byteLength(this.logs)).toString() + '…\n'
      this.logFull = true
      return
    }
    this.logs += text
  }

  /** The thrown value as the caller sees it (host.go's unitError). */
  unitError(v: unknown): NonNullable<Answer['err']> {
    const ue = { code: 'failed', message: '', data: '', stack: '' }
    if (typeof v !== 'object' || v === null) {
      ue.message = v === undefined ? 'undefined' : String(v)
      return ue
    }
    const o = v as Record<string, unknown>
    const get = (k: string): string => (o[k] === undefined || o[k] === null ? '' : String(o[k]))
    ue.message = get('message') || String(v)
    ue.stack = get('stack')
    if (get('name') === 'UnitError') {
      ue.stack = '' // an answer, not a crash
      if (CODES.has(get('code'))) ue.code = get('code')
      if (o['data'] !== undefined) {
        try {
          const s = engineStringify(o['data'])
          if (Buffer.byteLength(s) <= this.t.limits.maxValueBytes) ue.data = s
        } catch {
          // data that is not JSON is left out
        }
      }
    }
    return ue
  }

  // Transactions on the env's one connection.

  hold(write: boolean): Hold {
    const db = this.t.raw
    const h: Hold = { write, ended: false, own: this.t.txOpen === 0 }
    if (h.own) {
      try {
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
        if (!write) db.exec('PRAGMA query_only = 1')
      } catch (e) {
        this.throw((e as Error).message)
      }
      this.t.txOpen++
    }
    this.open.push(h)
    if (write) this.writeOpen++
    return h
  }

  end(h: Hold, commit: boolean): void {
    if (h.ended) return
    h.ended = true
    if (h.write) this.writeOpen--
    if (!h.own) return
    this.t.txOpen--
    const db = this.t.raw
    if (!h.write) db.exec('PRAGMA query_only = 0')
    if (commit) {
      try {
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } else db.exec('ROLLBACK')
  }

  /** Ends h when v (the callback's result) is known: now for a value, when it settles for a promise. */
  settle(h: Hold, v: unknown): unknown {
    const finish = (): void => {
      if (this.limitErr) {
        this.end(h, false)
        this.throw(this.limitErr.message)
      }
      try {
        this.end(h, true)
      } catch (e) {
        this.throw((e as Error).message)
      }
    }
    if (v instanceof Promise) {
      return v.then(
        (r: unknown) => {
          finish()
          return r
        },
        (e: unknown) => {
          this.end(h, false)
          throw e
        },
      )
    }
    finish()
    return v
  }

  cleanup(): void {
    for (const h of this.open) if (!h.ended) this.end(h, false)
  }

  // Statements.

  check(sql: string): void {
    const why = checkSQL(sql)
    if (why) this.throw(why)
    if (++this.stmts > this.t.limits.maxStatements) this.limit(`more than units.max_statements (${this.t.limits.maxStatements}) statements`)
  }

  sqlArgs(args: unknown[]): Bound[] {
    return args.map((a, i) => {
      try {
        return sqlArg(a)
      } catch (e) {
        return this.throw(`argument ${i + 1}: ${(e as Error).message}`)
      }
    })
  }

  run<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      return this.throw((e as Error).message)
    }
  }

  withRead<T>(f: Frame, fn: () => T): T {
    if (f.tx || this.t.txOpen > 0) return this.run(fn)
    // A read of its own: on a read-only connection, as the engine's are.
    const db = this.t.raw
    db.exec('PRAGMA query_only = 1')
    try {
      return this.run(fn)
    } finally {
      db.exec('PRAGMA query_only = 0')
    }
  }

  withWrite<T>(f: Frame, fn: () => T): T {
    if (f.tx) {
      if (!f.write) this.throw('a query cannot write (make it a mutation)')
      return this.run(fn)
    }
    if (f.kind !== 'action') this.throw('no transaction')
    if (this.writeOpen > 0) this.throw('ctx.db.tx is open: use the db its callback receives')
    if (this.t.txOpen > 0) return this.run(fn)
    // An action outside ctx.db.tx: the write commits on its own.
    const db = this.t.raw
    db.exec('BEGIN IMMEDIATE')
    let ok = false
    try {
      const v = this.run(fn)
      ok = true
      return v
    } finally {
      db.exec(ok ? 'COMMIT' : 'ROLLBACK')
    }
  }

  query(f: Frame, sql: string, args: unknown[], max: number): Record<string, unknown>[] {
    this.check(sql)
    const vals = this.sqlArgs(args)
    return this.withRead(f, () => {
      const st = this.t.raw.prepare(sql)
      st.setReadBigInts(true)
      const rows = max === 1 ? [st.get(...vals)].filter((r) => r !== undefined) : st.all(...vals)
      for (let i = 0; i < rows.length; i++) {
        if (++this.rows > this.t.limits.maxRows) this.limit(`read more than units.max_rows (${this.t.limits.maxRows}) rows`)
      }
      return rows.map((r) => rowObject(r as Record<string, unknown>))
    })
  }

  exec(sql: string, vals: Bound[]): { rowsAffected: number; lastInsertId: number } {
    const r = this.t.raw.prepare(sql).run(...vals)
    return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
  }

  // ctx.

  newDB(f: Frame): Record<string, unknown> {
    const split = (a: unknown[]): [string, unknown[]] => {
      if (typeof a[0] !== 'string') this.throw('the first argument must be a SQL string')
      return [a[0] as string, a.slice(1)]
    }
    const db: Record<string, unknown> = {
      all: (...a: unknown[]) => this.query(f, ...split(a), 0),
      one: (...a: unknown[]) => this.query(f, ...split(a), 1)[0] ?? null,
      value: (...a: unknown[]) => {
        const r = this.query(f, ...split(a), 1)[0]
        if (!r) return null
        const k = Object.keys(r)[0]
        return k === undefined ? null : r[k]
      },
      exec: (...a: unknown[]) => {
        const [sql, args] = split(a)
        this.check(sql)
        const vals = this.sqlArgs(args)
        return this.withWrite(f, () => this.exec(sql, vals))
      },
      batch: (list: unknown) => {
        if (!Array.isArray(list) || !list.every((s) => Array.isArray(s))) this.throw('batch takes a list of [sql, ...args] lists')
        const prepared = (list as unknown[][]).map((s, i) => {
          if (typeof s[0] !== 'string') this.throw(`batch statement ${i + 1}: the first item must be a SQL string`)
          this.check(s[0] as string)
          return { sql: s[0] as string, vals: this.sqlArgs(s.slice(1)) }
        })
        return this.withWrite(f, () =>
          prepared.map((s, i) => {
            try {
              return this.exec(s.sql, s.vals)
            } catch (e) {
              throw new Error(`batch statement ${i + 1}: ${(e as Error).message}`)
            }
          }),
        )
      },
      tx: (fn: unknown) => this.tx(f, fn),
    }
    return db
  }

  tx(f: Frame, fn: unknown): unknown {
    if (typeof fn !== 'function') this.throw('ctx.db.tx takes a function')
    if (f.tx) return (fn as (db: unknown) => unknown)(this.newDB(f))
    if (this.writeOpen > 0) this.throw('ctx.db.tx is already open')
    const h = this.hold(true)
    const inner: Frame = { unit: f.unit, kind: 'mutation', tx: h, write: true }
    let v: unknown
    try {
      v = (fn as (db: unknown) => unknown)(this.newDB(inner))
    } catch (e) {
      this.end(h, false)
      throw e
    }
    return this.settle(h, v)
  }

  runUnit(f: Frame, nameArg: unknown, args: unknown): unknown {
    const name = String(nameArg)
    const u = this.t.units.get(name)
    if (!u) this.throw(`ctx.run: no unit ${q(name)}`)
    if (this.depth >= MAX_RUN_DEPTH) this.throw(`ctx.run: nested deeper than ${MAX_RUN_DEPTH}`)
    const kind = u.runs
    if (f.kind === 'query' && kind !== 'query') this.throw(`ctx.run: a query can only run queries (${name} is a ${kind})`)
    if (f.kind === 'mutation' && kind === 'action') this.throw(`ctx.run: a mutation cannot run an action (${name})`)
    const argsJSON = args === undefined ? '' : engineStringify(args)
    let checked: string
    try {
      checked = checkArgs(u, argsJSON)
    } catch (e) {
      return this.throw(`ctx.run: ${e instanceof Failure ? e.text : (e as Error).message}`)
    }
    const argv = parseJSON(checked)
    this.depth++
    try {
      const child: Frame = { unit: u, kind, tx: null, write: false }
      if (f.tx && kind !== 'action') {
        child.tx = f.tx
        child.write = f.write && kind === 'mutation'
      } else if (kind !== 'action') {
        // A query or a mutation from an action outside a transaction: its own.
        if (kind === 'mutation' && this.writeOpen > 0) this.throw(`ctx.run: ctx.db.tx is open; run ${name} from inside it`)
        const h = this.hold(kind === 'mutation')
        child.tx = h
        child.write = kind === 'mutation'
        let v: unknown
        try {
          v = u.handler.call(undefined, this.newCtx(child), argv)
        } catch (e) {
          this.end(h, false)
          throw e
        }
        return this.settle(h, v)
      }
      return u.handler.call(undefined, this.newCtx(child), argv)
    } finally {
      this.depth--
    }
  }

  newCtx(f: Frame): Record<string, unknown> {
    const t = this.t
    const cl = this.req.caller
    const job = this.req.job
    const env = Object.freeze(Object.fromEntries(Object.keys(t.secrets).sort().map((k) => [k, t.secrets[k]])))
    const log = {
      info: (...a: unknown[]) => this.log('info', a),
      warn: (...a: unknown[]) => this.log('warn', a),
      error: (...a: unknown[]) => this.log('error', a),
      debug: (...a: unknown[]) => this.log('info', a),
    }
    return {
      db: this.newDB(f),
      auth: {
        kind: cl.kind,
        principal: cl.principal,
        subject: cl.subject,
        scopes: [...cl.scopes],
        tables: [...cl.tables],
        claims: JSON.parse(JSON.stringify(cl.claims)) as unknown,
        has: (scope: string) => cl.kind === 'system' || cl.kind === 'admin' || cl.scopes.some((s) => s === scope || s === 'admin'),
      },
      run: (name: unknown, args: unknown) => this.runUnit(f, name, args),
      fetch: (input: unknown, init: unknown) => this.fetch(f, input, init),
      scheduler: {
        after: (delay: unknown, name: unknown, args: unknown) => {
          let ms = this.number('ctx.scheduler.after', delay)
          if (ms < 0) ms = 0
          if (ms > MAX_JOB_DELAY) this.throw('ctx.scheduler.after: a job can be at most 366 days ahead')
          return this.schedule(f, t.clock + Math.trunc(ms), name, args)
        },
        at: (when: unknown, name: unknown, args: unknown) => {
          const at = when instanceof Date ? when.getTime() : Math.trunc(this.number('ctx.scheduler.at', when))
          if (at > t.clock + MAX_JOB_DELAY) this.throw('ctx.scheduler.at: a job can be at most 366 days ahead')
          return this.schedule(f, at, name, args)
        },
        cancel: (id: unknown) => {
          this.jobWriter(f, 'ctx.scheduler.cancel')
          return this.withWrite(f, () => Number(t.raw.prepare(`DELETE FROM ${TABLE_PREFIX}_jobs WHERE id = ? AND state = 'pending'`).run(String(id)).changes) > 0)
        },
      },
      env,
      log,
      now: () => t.clock,
      uuid: () => {
        const b = t.random(16)
        b[6] = (b[6]! & 0x0f) | 0x40
        b[8] = (b[8]! & 0x3f) | 0x80
        const h = hex(b)
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
      },
      crypto: {
        sha256: (data: unknown) => createHash('sha256').update(bytesArg(data)).digest('hex'),
        hmac: (key: unknown, data: unknown) => createHmac('sha256', bytesArg(key)).update(bytesArg(data)).digest('hex'),
        randomBytes: (n: unknown) => {
          const k = Math.trunc(Number(n))
          if (!(k >= 0 && k <= 65536)) this.throw('randomBytes: n must be in [0, 65536]')
          return new Uint8Array(t.random(k))
        },
        timingSafeEqual: (a: unknown, b: unknown) => {
          const x = bytesArg(a)
          const y = bytesArg(b)
          return x.length === y.length && timingSafeEqual(x, y)
        },
      },
      unit: {
        name: f.unit.name,
        kind: f.unit.kind,
        trigger: this.req.trigger,
        mutationId: this.req.mutationId,
        deploy: 1,
        job: job
          ? { id: job.id, attempt: job.attempts + 1, scheduledAt: job.created_at, scheduledBy: job.created_by, source: job.source }
          : null,
      },
    }
  }

  number(what: string, v: unknown): number {
    const n = v === null || v === undefined ? NaN : Number(v)
    if (!Number.isFinite(n)) this.throw(`${what}: expected a number of milliseconds`)
    return n
  }

  jobWriter(f: Frame, what: string): void {
    if (f.kind === 'query' || (f.tx && !f.write)) this.throw(`${what}: a query cannot schedule jobs (make it a mutation or an action)`)
  }

  schedule(f: Frame, atArg: number, nameArg: unknown, args: unknown): string {
    this.jobWriter(f, 'ctx.scheduler')
    if (nameArg === undefined) this.throw('ctx.scheduler: name the unit to run')
    const name = String(nameArg)
    const u = this.t.units.get(name)
    if (!u) this.throw(`ctx.scheduler: no unit ${q(name)}`)
    if (u.kind !== 'mutation' && u.kind !== 'action') this.throw(`ctx.scheduler: ${name} is a ${u.kind}; jobs run mutations and actions`)
    const argsJSON = args === undefined ? '' : engineStringify(args)
    if (Buffer.byteLength(argsJSON) > this.t.limits.maxValueBytes) {
      this.throw(`ctx.scheduler: arguments are ${Buffer.byteLength(argsJSON)} bytes, over units.max_value_bytes (${this.t.limits.maxValueBytes})`)
    }
    let checked: string
    try {
      checked = checkArgs(u, argsJSON)
    } catch (e) {
      return this.throw(`ctx.scheduler: ${e instanceof Failure ? e.text : (e as Error).message}`)
    }
    if (++this.stmts > this.t.limits.maxStatements) this.limit(`more than units.max_statements (${this.t.limits.maxStatements}) statements`)
    const now = this.t.clock
    const at = Math.max(atArg, now)
    const id = 'job_' + base32(this.t.random(16))
    this.withWrite(f, () => {
      const db = this.t.raw
      this.jobsPending ??= Number(db.prepare(`SELECT count(*) AS n FROM ${TABLE_PREFIX}_jobs WHERE state = 'pending'`).get()!['n'])
      if (this.jobsPending >= this.t.limits.maxJobs) this.limit(`more than units.max_jobs (${this.t.limits.maxJobs}) jobs are waiting`)
      db.prepare(`INSERT INTO ${TABLE_PREFIX}_jobs(id, unit, args, run_at, created_at, created_by, source, attempts, state, error) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', '')`).run(
        id, name, checked, at, now, this.req.caller.principal, f.unit.name,
      )
      this.jobsPending++
    })
    return id
  }

  fetch(f: Frame, input: unknown, init: unknown): Promise<unknown> {
    if (f.kind !== 'action') this.throw(`ctx.fetch is only available in actions (${f.unit.name} is a ${f.kind})`)
    if (f.tx || this.writeOpen > 0) this.throw('ctx.fetch cannot run inside a transaction')
    const lim = this.t.limits
    if (++this.fetches > lim.fetchCalls) this.limit(`more than units.fetch.max_calls (${lim.fetchCalls}) requests`)
    let url = String(input)
    if (typeof input === 'object' && input !== null && (input as { url?: unknown }).url !== undefined) url = String((input as { url: unknown }).url)
    let method = 'GET'
    const headers: Record<string, string> = {}
    let body: string | Uint8Array | undefined
    if (typeof init === 'object' && init !== null) {
      const o = init as { method?: unknown; headers?: unknown; body?: unknown }
      if (o.method !== undefined) method = String(o.method).toUpperCase()
      if (typeof o.headers === 'object' && o.headers !== null) {
        for (const [k, v] of Object.entries(o.headers)) headers[k] = String(v)
      }
      if (o.body !== undefined && o.body !== null) {
        const b = bytesOf(o.body)
        if (typeof o.body === 'string') body = o.body
        else if (b) body = b
        else {
          body = engineStringify(o.body)
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
        }
      }
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) this.throw(`ctx.fetch: only http and https URLs (got ${q(url)})`)
    const impl = this.t.o.fetch
    if (!impl) {
      this.throw(`ctx.fetch ${method} ${url}: this test environment has no fetch: pass one to createTestEnv(units, { fetch }) (a mock that returns a Response, or globalThis.fetch for real requests)`)
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'azora-units'
    const start = performance.now()
    return (async () => {
      let resp: Response
      let data: Uint8Array
      try {
        resp = await impl(url, { method, headers, ...(body !== undefined && { body }), redirect: 'follow' })
        data = new Uint8Array(await resp.arrayBuffer())
      } catch (e) {
        return this.throw(`ctx.fetch ${method} ${url}: ${(e as Error).message}`)
      }
      if (data.length > lim.fetchBytes) this.throw(`ctx.fetch ${method} ${url}: the response is over units.fetch.max_bytes (${lim.fetchBytes})`)
      this.log('info', [`fetch ${method} ${url} -> ${resp.status} (${Math.round(performance.now() - start)}ms)`])
      const names = new Map<string, string>()
      resp.headers.forEach((v, k) => names.set(k.toLowerCase(), v))
      const sorted = [...names.keys()].sort()
      return {
        status: resp.status,
        statusText: STATUS_CODES[resp.status] ?? '',
        ok: resp.status >= 200 && resp.status < 300,
        url: resp.url || url,
        redirected: resp.redirected,
        headers: {
          get: (n: string) => names.get(String(n).toLowerCase()) ?? null,
          has: (n: string) => names.has(String(n).toLowerCase()),
          entries: () => sorted.map((k) => [k, names.get(k)!]),
        },
        text: async () => new TextDecoder().decode(data),
        json: async () => {
          try {
            return parseJSON(new TextDecoder().decode(data))
          } catch (e) {
            throw new Error(`response is not JSON: ${(e as Error).message}`)
          }
        },
        arrayBuffer: async () => data.slice().buffer,
        bytes: async () => data.slice(),
      }
    })()
  }

  /** Runs the top frame's handler and returns its result as JSON, or what it threw. */
  async invoke(f: Frame, args: string): Promise<{ value: string; thrown: Answer['err'] }> {
    const argv = parseJSON(args)
    let v: unknown
    try {
      v = f.unit.handler.call(undefined, this.newCtx(f), argv)
      if (v instanceof Promise) v = await v
    } catch (e) {
      return { value: '', thrown: this.unitError(e) }
    }
    if (this.limitErr) throw this.limitErr
    let s: string
    try {
      s = engineStringify(v)
    } catch (e) {
      return { value: '', thrown: this.unitError(e) }
    }
    const n = Buffer.byteLength(s)
    if (n > this.t.limits.maxValueBytes) {
      throw new Failure('resource_exhausted', `unit ${f.unit.name} returned ${n} bytes of JSON, over units.max_value_bytes (${this.t.limits.maxValueBytes})`)
    }
    return { value: s, thrown: null }
  }
}

/** Checks args (JSON text) against u's schema; "" is checked, and passed, as {} when it takes an object. */
function checkArgs(u: Def, args: string): string {
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

const SYSTEM: Caller = { kind: 'system', principal: 'system', subject: '', scopes: [], tables: [], claims: {} }

function caller(a: TestAuth | undefined): Caller {
  const kind = a?.kind ?? (a?.subject ? 'token' : 'key')
  const principal = a?.principal ?? { key: 'key:test', token: a?.subject || 'token:test', admin: 'admin:test', system: 'system' }[kind]
  const scopes = a?.scopes ?? { key: ['read', 'write'], token: ['read', 'write'], admin: ['admin'], system: [] }[kind]
  return { kind, principal, subject: kind === 'token' ? (a?.subject ?? '') : '', scopes: [...scopes], tables: [...(a?.tables ?? [])], claims: { ...a?.claims } }
}

// The env.

/** @internal The implementation behind {@link TestEnv}. */
class TestEnvImpl {
  readonly raw: DatabaseSync
  readonly units: Map<string, Def>
  readonly secrets: Record<string, string>
  readonly auth: Caller
  readonly random: (n: number) => Uint8Array
  readonly limits: Required<NonNullable<TestEnvOptions['limits']>>
  readonly jobAttempts: number
  clock: number
  txOpen = 0
  logLines: TestLogLine[] = []
  runLog: UnitRun[] = []
  private seq = 0
  private changeSeq = 0
  private queue: Promise<unknown> = Promise.resolve()
  readonly db: TestDb
  readonly unitsProxy: Record<string, (args?: unknown, opts?: TestCallOptions) => Promise<unknown>>

  readonly o: TestEnvOptions

  constructor(mod: Record<string, unknown>, o: TestEnvOptions) {
    this.o = o
    const { DatabaseSync } = openSqlite()
    this.units = load(mod)
    this.raw = new DatabaseSync(':memory:')
    this.raw.exec('PRAGMA foreign_keys = ON')
    for (const s of typeof o.schema === 'string' ? [o.schema] : (o.schema ?? [])) this.raw.exec(s)
    this.raw.exec(INTERNAL_SCHEMA)
    for (const u of this.units.values()) {
      if (u.kind === 'onChange' && !this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(u.table)) {
        this.raw.close()
        throw new Error(`azora units: onChange unit ${u.name}: table ${q(u.table)} does not exist (create it in the schema option)`)
      }
    }
    this.secrets = { ...o.env }
    this.auth = caller(o.auth)
    this.random = o.random ?? ((n) => new Uint8Array(cryptoRandomBytes(n)))
    this.clock = o.now === undefined ? Date.now() : o.now instanceof Date ? o.now.getTime() : o.now
    const l = o.limits ?? {}
    this.limits = {
      maxStatements: l.maxStatements ?? 10_000, maxRows: l.maxRows ?? 100_000, maxValueBytes: l.maxValueBytes ?? 1 << 20, maxJobs: l.maxJobs ?? 100_000,
      fetchCalls: l.fetchCalls ?? 50, fetchBytes: l.fetchBytes ?? 5 << 20,
    }
    this.jobAttempts = o.jobAttempts ?? 5
    const raw = this.raw
    const read = (sql: string, args: unknown[]) => {
      const st = raw.prepare(sql)
      st.setReadBigInts(true)
      return st.all(...args.map(sqlArg)).map((r) => rowObject(r as Record<string, unknown>))
    }
    this.db = {
      raw,
      all: <T>(sql: string, ...args: unknown[]) => read(sql, args) as T[],
      one: <T>(sql: string, ...args: unknown[]) => (read(sql, args)[0] ?? null) as T | null,
      value: <T>(sql: string, ...args: unknown[]) => {
        const r = read(sql, args)[0]
        const k = r && Object.keys(r)[0]
        return (k === undefined || !r ? null : r[k]) as T | null
      },
      exec: (sql: string, ...args: unknown[]) => {
        const r = raw.prepare(sql).run(...args.map(sqlArg))
        return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
      },
    }
    this.unitsProxy = new Proxy({} as Record<string, (args?: unknown, opts?: TestCallOptions) => Promise<unknown>>, {
      get: (_t, name) => (typeof name !== 'string' || name === 'then' ? undefined : (args?: unknown, opts?: TestCallOptions) => this.call(name, args, opts)),
    })
  }

  /** Runs fn after everything queued before it: one call at a time, as on one connection. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => undefined)
    return p
  }

  private record(c: Call, start: number, wall: number, status: string, error: string): void {
    this.runLog.push({
      id: ++this.seq, at: start, unit: c.top.name, kind: c.top.kind, trigger: c.req.trigger, principal: c.req.caller.principal,
      durationMs: Math.round((performance.now() - wall) * 1000) / 1000, status, error: error.slice(0, 8 << 10), logs: c.logs,
    })
  }

  /** Engine.Call: runs a unit in the transaction its kind asks for. */
  async exec(req: Request): Promise<Answer> {
    const u = this.units.get(req.unit)
    if (!u) throw new Failure('not_found', `no unit ${q(req.unit)}`)
    const start = this.clock
    const wall = performance.now()
    const c = new Call(this, req, u)
    const reject = (err: Failure): never => {
      this.record(c, start, wall, 'rejected', err.text)
      throw err
    }
    if (req.external && u.internal) reject(new Failure('permission_denied', `unit ${q(req.unit)} is internal: only other units can run it`))
    const size = Buffer.byteLength(req.args)
    if (size > this.limits.maxValueBytes) reject(new Failure('invalid', `arguments are ${size} bytes, over units.max_value_bytes (${this.limits.maxValueBytes})`))
    if (Buffer.byteLength(req.mutationId) > 128) reject(new Failure('invalid', 'mutation id longer than 128 bytes'))
    let args = req.args
    if (!req.noValidate) {
      try {
        args = checkArgs(u, args)
      } catch (e) {
        reject(e as Failure)
      }
    }
    const kind = u.runs
    const top: Frame = { unit: u, kind, tx: null, write: kind === 'mutation' }
    let value = ''
    let replayed = false
    let thrown: Answer['err'] = null
    const stored = (): string | null => {
      if (req.mutationId === '') return null
      const r = this.raw.prepare(`SELECT result FROM ${TABLE_PREFIX}_results WHERE id = ?`).get(req.mutationId)
      return r ? String(r['result']) : null
    }
    const store = (): void => {
      if (req.mutationId !== '') {
        this.raw.prepare(`INSERT OR IGNORE INTO ${TABLE_PREFIX}_results(id, at, unit, result) VALUES (?, ?, ?, ?)`).run(req.mutationId, this.clock, u.name, value)
      }
    }
    try {
      if (kind === 'query' || kind === 'mutation') {
        const h = c.hold(kind === 'mutation')
        top.tx = h
        let commit = false
        try {
          const prev = kind === 'mutation' ? stored() : null
          if (prev !== null) {
            value = prev
            replayed = true
          } else {
            ;({ value, thrown } = await c.invoke(top, args))
            if (!thrown && kind === 'mutation') {
              store()
              req.inTx?.()
            }
          }
          commit = !thrown
        } finally {
          c.end(h, commit)
        }
      } else {
        const prev = stored()
        if (prev !== null) {
          value = prev
          replayed = true
        } else {
          ;({ value, thrown } = await c.invoke(top, args))
          if (!thrown) {
            if (c.limitErr) throw c.limitErr
            if (req.mutationId !== '') {
              this.raw.exec('BEGIN IMMEDIATE')
              try {
                store()
                this.raw.exec('COMMIT')
              } catch (e) {
                this.raw.exec('ROLLBACK')
                throw e
              }
            }
            req.afterAction?.()
          }
        }
      }
      if (c.limitErr) throw c.limitErr
    } catch (e) {
      c.cleanup()
      this.record(c, start, wall, 'error', e instanceof Failure ? e.text : String(e))
      throw e
    }
    c.cleanup()
    if (replayed) this.record(c, start, wall, 'replayed', '')
    else if (thrown) this.record(c, start, wall, 'error', `${thrown.code}: ${thrown.message}${thrown.stack ? `\n${thrown.stack}` : ''}`)
    else this.record(c, start, wall, 'ok', '')
    return { value, replayed, err: thrown }
  }

  /** The answer as a client sees it: the result, or the client's UnitError / AzoraError. */
  private async answer(name: string, req: Promise<Answer>): Promise<unknown> {
    let a: Answer
    try {
      a = await req
    } catch (e) {
      if (e instanceof Failure) throw new AzoraError(e.code, e.message)
      throw e
    }
    if (a.err) {
      let data: unknown
      try {
        data = a.err.data === '' ? undefined : parseJSON(a.err.data)
      } catch {
        data = a.err.data
      }
      throw new CallError(name, a.err.code, a.err.message, data === null ? undefined : data)
    }
    return parseJSON(a.value)
  }

  call(name: string, args?: unknown, opts: TestCallOptions = {}): Promise<unknown> {
    const as = opts.as ?? 'client'
    const argsJSON = clientStringify(args)
    const mutationId = opts.mutationId ?? (as === 'client' ? 'm-' + hex(this.random(16)) : '')
    const who = as === 'admin' ? caller({ kind: 'admin', ...opts.auth }) : opts.auth ? caller(opts.auth) : this.auth
    const trigger = as === 'client' ? 'call' : as
    return this.serial(() => this.answer(name, this.exec({ unit: name, args: argsJSON, mutationId, caller: who, external: as === 'client', trigger })))
  }

  private trigger(name: string, kind: 'schedule' | 'onChange'): Def {
    const u = this.units.get(name)
    if (!u) throw new Error(`azora units: no unit ${q(name)}`)
    if (u.kind !== kind) throw new Error(`azora units: ${name} is ${u.kind === 'onChange' || u.kind === 'action' ? 'an' : 'a'} ${u.kind}, not ${kind === 'schedule' ? 'a schedule' : 'an onChange'} unit`)
    return u
  }

  async runSchedule(name: string): Promise<void> {
    this.trigger(name, 'schedule')
    return this.serial(async () => {
      await this.answer(name, this.exec({ unit: name, args: '', mutationId: '', caller: SYSTEM, external: false, trigger: 'schedule', noValidate: true }))
    })
  }

  async change(name: string, changes: readonly TestChange[], o: { gap?: boolean } = {}): Promise<void> {
    const u = this.trigger(name, 'onChange')
    const pk = (this.raw.prepare(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(u.table) as { name: string }[]).map((r) => r.name)
    const list = changes
      .map((c) => {
        const row = c.new ?? c.old ?? {}
        return {
          seq: c.seq ?? ++this.changeSeq,
          op: c.op,
          key: c.key ?? Object.fromEntries(pk.map((k) => [k, row[k] ?? null])),
          old: c.op === 'insert' ? null : (c.old ?? null),
          new: c.op === 'delete' ? null : (c.new ?? null),
        }
      })
      .filter((c) => u.ops.includes(c.op))
    return this.serial(async () => {
      for (let i = 0; i < list.length; i += u.batch) {
        const args = clientStringify({ changes: list.slice(i, i + u.batch), gap: o.gap ?? false })
        await this.answer(name, this.exec({ unit: name, args, mutationId: '', caller: SYSTEM, external: false, trigger: 'change', noValidate: true }))
      }
    })
  }

  // Jobs.

  private jobRows(where = '1 = 1', ...args: Bound[]): JobRow[] {
    const st = this.raw.prepare(`SELECT * FROM ${TABLE_PREFIX}_jobs WHERE ${where} ORDER BY state DESC, run_at, id`)
    return st.all(...args) as unknown as JobRow[]
  }

  jobs(f: { state?: 'pending' | 'failed'; unit?: string } = {}): UnitJob[] {
    return this.jobRows()
      .filter((j) => (f.state === undefined || j.state === f.state) && (f.unit === undefined || j.unit === f.unit))
      .map((j) => ({
        id: j.id, unit: j.unit, args: j.args === '' ? undefined : parseJSON(j.args), runAt: j.run_at, createdAt: j.created_at, createdBy: j.created_by,
        source: j.source, attempts: j.attempts, state: j.state, error: j.error,
      }))
  }

  private writeTx(fn: () => void): void {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.raw.exec('COMMIT')
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  private deleteJob(id: string): boolean {
    return Number(this.raw.prepare(`DELETE FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).run(id).changes) > 0
  }

  /** runJob of pkg/azora/units_jobs.go. */
  private async runJob(j: JobRow): Promise<void> {
    let err: string | null = null
    let gone = false
    try {
      const a = await this.exec({
        unit: j.unit, args: j.args, mutationId: j.id, trigger: 'job', job: j, external: false,
        caller: { kind: 'system', principal: `job:${j.id}`, subject: '', scopes: [], tables: [], claims: {} },
        inTx: () => void this.deleteJob(j.id),
        afterAction: () => this.writeTx(() => void this.deleteJob(j.id)),
      })
      if (!a.err) {
        if (a.replayed) this.writeTx(() => void this.deleteJob(j.id))
        return
      }
      err = `${a.err.code}: ${a.err.message}`
    } catch (e) {
      if (!(e instanceof Failure)) throw e
      err = e.text
      gone = e.code === 'not_found'
    }
    const now = this.clock
    this.writeTx(() => {
      const cur = this.raw.prepare(`SELECT attempts FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).get(j.id)
      if (!cur) return
      const attempts = Number(cur['attempts']) + 1
      const failed = attempts >= (gone ? 1 : this.jobAttempts)
      // A failed job's run_at is when it failed; a pending one's when it runs again.
      this.raw.prepare(`UPDATE ${TABLE_PREFIX}_jobs SET attempts = ?, state = ?, error = ?, run_at = ? WHERE id = ?`).run(
        attempts, failed ? 'failed' : 'pending', err.slice(0, 8 << 10), failed ? now : now + jobBackoff(j.attempts + 1), j.id,
      )
    })
  }

  /** Runs the jobs due now, in rounds (jobs they schedule for now run too); reports how many ran and whether it stopped early. */
  private async due(): Promise<{ ran: number; capped: boolean }> {
    let ran = 0
    for (let round = 0; round < 100; round++) {
      const list = this.jobRows("state = 'pending' AND run_at <= ?", this.clock).slice(0, 64)
      if (list.length === 0) return { ran, capped: false }
      for (const j of list) {
        await this.runJob(j)
        ran++
      }
    }
    return { ran, capped: true }
  }

  private nextDue(): number | null {
    const r = this.raw.prepare(`SELECT min(run_at) AS at FROM ${TABLE_PREFIX}_jobs WHERE state = 'pending'`).get()
    return r?.['at'] == null ? null : Number(r['at'])
  }

  runJobs(): Promise<number> {
    return this.serial(async () => {
      const r = await this.due()
      if (r.capped) throw new Error('azora units: jobs keep scheduling jobs due now: stopped after 100 rounds')
      return r.ran
    })
  }

  advance(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ms must be a non-negative number, not ${ms}`)
    return this.serial(async () => {
      const target = this.clock + ms
      let ran = 0
      for (;;) {
        const next = this.nextDue()
        if (next === null || next > target) break
        if (next > this.clock) this.clock = next
        const r = await this.due()
        ran += r.ran
        if (r.capped) throw new Error('azora units: jobs keep scheduling jobs due now: stopped after 100 rounds')
      }
      this.clock = Math.max(this.clock, target)
      return ran
    })
  }

  cancelJob(id: string): boolean {
    return this.deleteJob(id)
  }

  retryJob(id: string): void {
    const r = this.raw.prepare(`UPDATE ${TABLE_PREFIX}_jobs SET state = 'pending', attempts = 0, error = '', run_at = ? WHERE id = ? AND state = 'failed'`).run(this.clock, id)
    if (Number(r.changes) > 0) return
    const j = this.raw.prepare(`SELECT state FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).get(id)
    if (!j) throw new AzoraError('not_found', `no job ${q(id)}`)
    throw new AzoraError('invalid', `job ${id} is ${String(j['state'])}, not failed`)
  }
}

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
  /** Closes the database. */
  close(): void
}

/**
 * Runs units locally, without an engine: the module's units against an
 * in-memory SQLite database (node:sqlite, Node.js 22.13+), with the
 * engine's transactions, argument checks, SQL rules, values, jobs and
 * run log.
 *
 * ```ts
 * import * as units from '../units/index.ts'
 * import { createTestEnv } from '@azora-db/units/testing'
 *
 * const t = createTestEnv(units, { schema: ['CREATE TABLE carts(...)'], auth: { subject: 'user:42' } })
 * const { orderId } = await t.call('checkout', { cartId: 'c1' })
 * t.db.all('SELECT * FROM orders')
 * await t.advance(24 * 3600e3) // runs the jobs that fall due
 * ```
 */
export function createTestEnv<M>(units: M, options: TestEnvOptions = {}): TestEnv<M> {
  if (typeof units !== 'object' || units === null) throw new TypeError('createTestEnv: pass your units module (import * as units from ...)')
  const t = new TestEnvImpl(units as Record<string, unknown>, options)
  return {
    call: ((name: string, args?: unknown, opts?: TestCallOptions) => t.call(name, args, opts)) as TestEnv<M>['call'],
    units: t.unitsProxy as unknown as Units<M>,
    db: t.db,
    runSchedule: (name) => t.runSchedule(name),
    change: (name, changes, o) => t.change(name, changes, o),
    jobs: (f) => t.jobs(f),
    runJobs: () => t.runJobs(),
    advance: (ms) => t.advance(ms),
    now: () => t.clock,
    cancelJob: (id) => t.cancelJob(id),
    retryJob: (id) => t.retryJob(id),
    runs: (f = {}) => t.runLog.filter((r) => (f.unit === undefined || r.unit === f.unit) && (f.status === undefined || r.status === f.status)),
    logs: (f = {}) => t.logLines.filter((l) => f.unit === undefined || l.unit === f.unit),
    close: () => t.raw.close(),
  }
}
