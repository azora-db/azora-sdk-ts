/** The public client: `connect()` returns a {@link Database}. */
import { Client } from './client.ts'
import { toValue, type InputValue, type Value } from './codec.ts'
import { resolveOptions, type ConnectOptions, type ResolvedOptions } from './config.ts'
import { Discovery } from './discovery.ts'
import { AzoraError, ErrorCode } from './errors.ts'
import { LiveQuery, type LiveOptions } from './live.ts'
import type { Session } from './session.ts'
import { Storage } from './storage.ts'
import { Subscription } from './subscription.ts'
import type { ExecResult, QueryResult, Row, Statement, Stats, SubscribeSpec } from './types.ts'
import { decodeUnitJSON, encodeUnitJSON, unitError, UnitsAdmin, type UnitCallOptions, type Units } from './units.ts'
import { isDDL, newMutationId, type CallOptions } from './util.ts'

/** Options of the query methods. */
export interface QueryOptions extends CallOptions {
  /** At most this many rows (0: the server's limit, 10,000); `truncated` tells when rows were cut. */
  maxRows?: number
}

/** Options of `exec` and `batch`. */
export interface WriteOptions extends CallOptions {
  /**
   * Your own mutation id (at most 128 bytes). Persist it with a queued
   * write and pass it again after a restart: the write still applies
   * exactly once (within the server's `realtime.mutation_window`).
   */
  mutationId?: string
}

/** A statement of `batch`: text, `[text, args]`, or a `sql` statement. */
export type BatchStatement = string | readonly [sql: string, args?: readonly InputValue[]] | Statement

type Args = readonly InputValue[]

function normalize(args: Args | undefined): Value[] | null {
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

/** Splits the (sql, args?, opts?) | (statement, opts?) call shapes. */
function unpack<O>(a: string | Statement, b?: Args | O, c?: O): { sql: string; args: Value[] | null; opts: O | undefined } {
  if (typeof a === 'string') {
    if (b !== undefined && !Array.isArray(b)) return { sql: a, args: null, opts: b as O }
    return { sql: a, args: normalize(b as Args | undefined), opts: c }
  }
  return { sql: a.sql, args: normalize(a.args), opts: (b as O | undefined) ?? c }
}

function toObjects<T>(columns: readonly string[], rows: readonly Value[][]): T[] {
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

/**
 * A connection to one database. It stays connected in the background
 * (heartbeats, reconnects with backoff), so keep one per process or page
 * and share it. Every method may be called concurrently.
 *
 * M is the type of your units module (`Database<typeof import('./units')>`):
 * it types {@link Database.units}. Without it `db.units` is untyped.
 */
export class Database<M = unknown> {
  /** File storage (uploads, downloads, signed URLs). */
  readonly storage: Storage
  /** The database's name. */
  readonly name: string
  /**
   * The published units as functions, typed from your units module when
   * the database was opened with its type:
   *
   * ```ts
   * const db = await connectEnv<typeof import('./units')>()
   * const { orderId } = await db.units.checkout({ cartId: 'c1' })
   * ```
   *
   * Only query, mutation and action units that are not internal appear.
   * `db.units.x(args, opts)` is `db.call('x', args, opts)`.
   */
  readonly units: Units<M>
  /** Publishing, rollback, the run log and secrets (an API key with the `ddl` scope). */
  readonly unitsAdmin: UnitsAdmin

  private readonly clients: Client[]
  private readonly discovery: Discovery | null
  private next = 0

  private constructor(o: ResolvedOptions, clients: Client[], discovery: Discovery | null) {
    this.clients = clients
    this.discovery = discovery
    this.name = o.database
    this.storage = new Storage(o.storageUrl, o.database, () => (clients[0] as Client).currentCredential, o.fetch)
    const fns = new Map<string, (args?: unknown, opts?: UnitCallOptions) => Promise<unknown>>()
    this.units = new Proxy({} as Units<M>, {
      get: (_t, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined // not a thenable
        let f = fns.get(name)
        if (!f) {
          f = (args, opts) => this.call(name, args, opts)
          fns.set(name, f)
        }
        return f
      },
    })
    this.unitsAdmin = new UnitsAdmin((op, body, opts) => {
      this.checkUnits()
      return this.pick().unitAdmin(op, body, opts)
    })
  }

  /** @internal Use {@link connect}. */
  static async open<M = unknown>(options: ConnectOptions, call?: CallOptions): Promise<Database<M>> {
    const o = resolveOptions(options)
    const discovery = o.discovery ? new Discovery(o) : null // one answer for the whole pool
    const clients = Array.from({ length: o.pool }, () => new Client(o, discovery))
    try {
      // The first connection proves the configuration; the others follow at once.
      await (clients[0] as Client).connect(call)
      await Promise.all(clients.slice(1).map((c) => c.connect(call)))
    } catch (e) {
      await Promise.all(clients.map((c) => c.close()))
      throw e
    }
    return new Database<M>(o, clients, discovery)
  }

  /** The client with the fewest requests in flight. */
  private pick(): Client {
    const cs = this.clients
    if (cs.length === 1) return cs[0] as Client
    let best = cs[this.next++ % cs.length] as Client
    for (const c of cs) if (c.pending < best.pending) best = c
    return best
  }

  private get main(): Client {
    return this.clients[0] as Client
  }

  /**
   * Runs a read and returns its rows as objects keyed by column name.
   *
   * ```ts
   * const orders = await db.query<Order>('SELECT * FROM orders WHERE customer = ?', [42])
   * const paid = await db.query(sql`SELECT * FROM orders WHERE status = ${status}`)
   * ```
   *
   * A read is retried on a new connection if the connection drops.
   */
  async query<T = Row>(sql: string, args?: Args, opts?: QueryOptions): Promise<T[]>
  async query<T = Row>(statement: Statement, opts?: QueryOptions): Promise<T[]>
  async query<T = Row>(a: string | Statement, b?: Args | QueryOptions, c?: QueryOptions): Promise<T[]> {
    const { sql, args, opts } = unpack<QueryOptions>(a, b, c)
    const r = await this.pick().query(sql, args, opts?.maxRows ?? 0, opts)
    return toObjects<T>(r.columns, r.rows)
  }

  /** Runs a read and returns columns and rows as arrays (no object per row), with `truncated`. */
  async queryRaw(sql: string, args?: Args, opts?: QueryOptions): Promise<QueryResult>
  async queryRaw(statement: Statement, opts?: QueryOptions): Promise<QueryResult>
  async queryRaw(a: string | Statement, b?: Args | QueryOptions, c?: QueryOptions): Promise<QueryResult> {
    const { sql, args, opts } = unpack<QueryOptions>(a, b, c)
    const r = await this.pick().query(sql, args, opts?.maxRows ?? 0, opts)
    return { columns: r.columns, rows: r.rows, truncated: r.truncated }
  }

  /** The first row of a read, or undefined when it returns none. */
  async queryOne<T = Row>(sql: string, args?: Args, opts?: CallOptions): Promise<T | undefined>
  async queryOne<T = Row>(statement: Statement, opts?: CallOptions): Promise<T | undefined>
  async queryOne<T = Row>(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<T | undefined> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.pick().query(sql, args, 1, opts)
    return toObjects<T>(r.columns, r.rows)[0]
  }

  /** The first column of the first row (`SELECT count(*) …`), or undefined when there is no row. */
  async queryValue<T extends Value = Value>(sql: string, args?: Args, opts?: CallOptions): Promise<T | undefined>
  async queryValue<T extends Value = Value>(statement: Statement, opts?: CallOptions): Promise<T | undefined>
  async queryValue<T extends Value = Value>(a: string | Statement, b?: Args | CallOptions, c?: CallOptions): Promise<T | undefined> {
    const { sql, args, opts } = unpack<CallOptions>(a, b, c)
    const r = await this.pick().query(sql, args, 1, opts)
    const row = r.rows[0]
    return row ? ((row[0] ?? null) as T) : undefined
  }

  /**
   * Runs a write. It carries a mutation id and is sent again with the same
   * id across reconnects, so it applies exactly once. Schema changes
   * (CREATE, ALTER, DROP) cannot carry one: if the connection drops after
   * one was sent, the call rejects with UnknownOutcomeError.
   */
  async exec(sql: string, args?: Args, opts?: WriteOptions): Promise<ExecResult>
  async exec(statement: Statement, opts?: WriteOptions): Promise<ExecResult>
  async exec(a: string | Statement, b?: Args | WriteOptions, c?: WriteOptions): Promise<ExecResult> {
    const { sql, args, opts } = unpack<WriteOptions>(a, b, c)
    const mid = opts?.mutationId ?? (isDDL(sql) ? '' : newMutationId())
    const r = await this.pick().write(mid, [{ sql, args }], true, opts)
    return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId, replayed: r.replayed }
  }

  /**
   * Runs several writes in one transaction: all of them apply, or none.
   * Like `exec` it applies exactly once. The statements are sent together
   * (there is no interactive transaction: a statement cannot depend on the
   * result of an earlier one, except through SQL itself). `rowsAffected`
   * is the total over the statements, `lastInsertId` the last insert's.
   */
  async batch(statements: readonly BatchStatement[], opts?: WriteOptions): Promise<ExecResult> {
    if (statements.length === 0) throw new TypeError('azora: batch needs at least one statement')
    const stmts = statements.map((s, i) => {
      try {
        if (typeof s === 'string') return { sql: s, args: null }
        if (Array.isArray(s)) return { sql: s[0] as string, args: normalize(s[1] as Args | undefined) }
        const st = s as Statement
        return { sql: st.sql, args: normalize(st.args) }
      } catch (e) {
        throw new TypeError(`azora: statement ${i + 1}: ${(e as Error).message}`)
      }
    })
    const r = await this.pick().write(opts?.mutationId ?? newMutationId(), stmts, false, opts)
    return { rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId, replayed: r.replayed }
  }

  /**
   * Starts a subscription and waits until the server confirms it. Read it
   * with `for await (const update of sub)` or `sub.next()`; see
   * {@link Subscription}. Most applications want {@link Database.live}.
   */
  subscribe(spec: SubscribeSpec = {}, opts?: CallOptions): Promise<Subscription> {
    return this.main.subscribe(spec, opts)
  }

  /**
   * A live local view of a table: resolves once its rows are loaded, then
   * follows every change. The table must be published
   * (`azora realtime publish DB TABLE`).
   *
   * ```ts
   * const open = await db.live<Order>('orders', { where: "status = 'open'", orderBy: ['total', 'desc'] })
   * open.rows                       // always a consistent state
   * open.subscribe(({ changes }) => render(open.rows))
   * ```
   */
  async live<T = Row>(table: string, options: LiveOptions<T> = {}, opts?: CallOptions): Promise<LiveQuery<T>> {
    const spec: SubscribeSpec = { table, kind: options.key ? 'row' : 'table' }
    if (options.where !== undefined) spec.where = options.where
    if (options.key) spec.key = options.key
    const sub = await this.main.subscribe(spec, opts)
    const live = new LiveQuery<T>(sub, table, options)
    const sc = this.main.scope(opts)
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(sc.signal.reason as Error)
        sc.signal.addEventListener('abort', onAbort, { once: true })
        live.ready.then(resolve, reject).finally(() => sc.signal.removeEventListener('abort', onAbort))
      })
    } catch (e) {
      await live.close()
      throw this.main.finalError(e)
    } finally {
      sc.done()
    }
    return live
  }

  /**
   * Calls listener whenever one of the tables is written (any table,
   * published or not; no rows are sent). `['*']` means "anything may have
   * changed", for example after a reconnect. Returns the function that
   * stops watching.
   */
  async watch(tables: readonly string[], listener: (tables: string[]) => void, opts?: CallOptions): Promise<() => Promise<void>> {
    const sub = await this.main.subscribe({ kind: 'notify', tables }, opts)
    void (async () => {
      for (;;) {
        let tables: string[]
        try {
          tables = (await sub.next()).tables
        } catch {
          return
        }
        try {
          listener(tables)
        } catch (e) {
          queueMicrotask(() => {
            throw e
          })
        }
      }
    })()
    return () => sub.close()
  }

  /**
   * A signed download URL for a stored file, over the realtime connection
   * (works with client tokens too). `ttlSeconds` 0 is the server's default.
   */
  async signUrl(objectId: string, ttlSeconds = 0, opts?: CallOptions): Promise<{ url: string; expiresAt: Date }> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 0xffffffff) throw new TypeError(`azora: ttlSeconds ${ttlSeconds} out of range`)
    const s = await this.pick().sign(objectId, ttlSeconds, opts)
    return { url: s.url, expiresAt: new Date(s.expiresAtMs) }
  }

  /**
   * Calls a published unit by name and returns its result.
   *
   * ```ts
   * const { orderId } = await db.call<{ orderId: number }>('checkout', { cartId: 'c1' })
   * ```
   *
   * Arguments and results travel as JSON; a Uint8Array travels as
   * `{"$bytes": base64}` and comes back as a Uint8Array. Every call
   * carries a mutation id (fresh unless `mutationId` is given) that is
   * sent again unchanged after a lost connection, so a mutation runs
   * exactly once. A unit that throws rejects with a {@link UnitError};
   * failures around the unit (no such unit, arguments that do not match
   * its schema, a timeout) reject with an {@link AzoraError}.
   */
  async call<R = unknown>(name: string, args?: unknown, opts?: UnitCallOptions): Promise<R> {
    if (!name) throw new TypeError('azora: empty unit name')
    let argsJSON: string
    try {
      argsJSON = encodeUnitJSON(args)
    } catch (e) {
      throw new TypeError(`azora: unit ${name}: arguments: ${(e as Error).message}`)
    }
    const mid = opts?.mutationId ?? newMutationId()
    this.checkUnits()
    const r = await this.pick().callUnit(name, argsJSON, mid, opts)
    if (!r.ok) throw unitError(name, r.errCode, r.errMessage, r.errData)
    return decodeUnitJSON(r.value) as R
  }

  /** Fails when the server's discovery document says it has no units. */
  private checkUnits(): void {
    const f = this.discovery?.features
    if (f && !f.includes('units')) {
      throw new AzoraError(ErrorCode.Unavailable, 'this server does not support units (its /.well-known/azora.json does not list "units" in features)')
    }
  }

  /** Replaces the credential: it is sent to the server now and used for later connections. */
  async setCredential(credential: string, opts?: CallOptions): Promise<void> {
    if (!credential) throw new TypeError('azora: empty credential')
    await Promise.all(this.clients.map((c) => c.setCredential(credential, opts)))
  }

  /** Measures a round trip to the server, in milliseconds. */
  async ping(opts?: CallOptions): Promise<number> {
    const start = performance.now()
    await this.pick().query('SELECT 1', null, 1, opts)
    return performance.now() - start
  }

  /** The current session (who the credential is, its scopes, the server key), or null while disconnected. */
  get session(): Session | null {
    return this.main.session
  }

  /** Whether a connection is up right now. */
  get connected(): boolean {
    return this.main.session !== null
  }

  /** Counters: connects, retries, rate limits, resyncs, ... (summed over the pool). */
  get stats(): Stats {
    const all = this.clients.map((c) => c.snapshotStats())
    const out = all[0] as Stats
    for (const s of all.slice(1)) {
      out.connected &&= s.connected
      out.connects += s.connects
      out.disconnects += s.disconnects
      out.connectFailures += s.connectFailures
      out.retries += s.retries
      out.rateLimited += s.rateLimited
      out.resyncs += s.resyncs
      out.credentialRefreshes += s.credentialRefreshes
      out.subscriptions += s.subscriptions
    }
    return out
  }

  /** Closes every connection and subscription. Calls in progress reject with ClosedError. */
  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()))
  }

  /** Whether `close` was called. */
  get closed(): boolean {
    return this.main.isClosed
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/**
 * Connects to a database and resolves once the first connection is up
 * (rejecting with its error otherwise: a wrong key, a refused credential,
 * an unreachable server).
 *
 * A client needs two values. The URL says where the database is: the
 * engine's HTTP address, the database as the last path segment, and the
 * server's public key. Nothing in it is secret. The token says who the
 * client is, an API key or a client token: keep it private.
 *
 * ```ts
 * const db = await connect('https://db.example.com/shop?key=<server key>', { token: process.env.AZORA_TOKEN })
 * const db = await connect('https://db.example.com/shop?key=<server key>', { token: () => fetchToken() })
 * ```
 *
 * See {@link parseUrl} for the other URL forms (raw TCP, WebSocket).
 *
 * Give the type of your units module to type `db.units`:
 * `connect<typeof import('./units')>(url, { token })`.
 */
export function connect<M = unknown>(url: string, options?: Omit<ConnectOptions, 'url'> & CallOptions): Promise<Database<M>>
export function connect<M = unknown>(options: ConnectOptions & CallOptions): Promise<Database<M>>
export function connect<M = unknown>(a: string | (ConnectOptions & CallOptions), b?: Omit<ConnectOptions, 'url'> & CallOptions): Promise<Database<M>> {
  const o: ConnectOptions & CallOptions = typeof a === 'string' ? { ...b, url: a } : a
  const { signal, timeoutMs, ...options } = o
  const call: CallOptions = {}
  if (signal) call.signal = signal
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return Database.open<M>(options, call)
}

/**
 * Connects with the two values from the environment: `AZORA_URL` (where
 * the database is; public) and `AZORA_TOKEN` (an API key or a client
 * token; private). `AZORA_API_KEY` is read when `AZORA_TOKEN` is not set.
 * `azora connect <database> --key <name>` on the server prints both
 * lines.
 *
 * ```ts
 * const db = await connectEnv()
 * ```
 *
 * A credential given in options is used instead of the environment's.
 * Where there is no `process.env` (browsers), pass the values to
 * {@link connect}.
 */
export async function connectEnv<M = unknown>(options: Omit<ConnectOptions, 'url'> & CallOptions = {}): Promise<Database<M>> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const url = env['AZORA_URL']
  if (!url) {
    throw new TypeError('azora: connectEnv: AZORA_URL is not set (the database\'s address, for example https://db.example.com/shop?key=<server key>)')
  }
  const o: ConnectOptions & CallOptions = { ...options }
  const given = [o.token, o.apiKey, o.credential].some((c) => c !== undefined && c !== '')
  if (!given) {
    const token = env['AZORA_TOKEN'] || env['AZORA_API_KEY']
    if (!token) throw new TypeError('azora: connectEnv: AZORA_TOKEN is not set (an API key or a client token)')
    o.token = token
  }
  return connect<M>(url, o)
}
