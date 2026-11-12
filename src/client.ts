/**
 * One connection to a database, kept alive in the background: heartbeats,
 * reconnects with backoff, requests multiplexed and retried, credentials
 * refreshed, subscriptions resumed. `Database` (database.ts) is the public
 * face; it owns one or several clients.
 */
import type { ResolvedOptions } from './config.ts'
import type { Discovery } from './discovery.ts'
import {
  AzoraError, ClosedError, ConnectionError, ErrorCode, HandshakeError, isPermanent, LostError, TimeoutError, UnknownOutcomeError,
} from './errors.ts'
import { MsgType, type ErrorMsg, type Msg, type Result, type Returned, type Shape, type Signed } from './messages.ts'
import { dial, type Link, type Session } from './session.ts'
import { Subscription } from './subscription.ts'
import type { SubscribeSpec, Stats } from './types.ts'
import { Notifier, scope, sleep, type CallOptions, type Scope } from './util.ts'
import type { Value } from './codec.ts'

interface CallPolicy {
  /** Not sent again once written: losing the connection then is an unknown outcome. */
  once?: boolean
  /** An unauthenticated answer is final (Auth itself). */
  noRefresh?: boolean
}

/** UnitAdmin operations that only read: safe to send again after a lost connection. */
const UNIT_ADMIN_READS = new Set(['list', 'deploys', 'runs', 'triggers', 'secrets.list', 'jobs'])

interface ShapeInfo {
  columns: readonly string[]
  pk: readonly string[]
}

function toError(e: ErrorMsg): AzoraError {
  return new AzoraError(e.code, e.message, { fatal: e.fatal, retryAfterMs: e.retryAfterMs })
}

/** @internal */
export class Client {
  readonly stats = { connects: 0, disconnects: 0, connectFailures: 0, retries: 0, rateLimited: 0, resyncs: 0, refreshes: 0 }

  private readonly o: ResolvedOptions
  private readonly discovery: Discovery | null // supplies the server key when the URL has none
  private readonly life = new AbortController() // aborted by close()
  private readonly changed = new Notifier() // the current link or `closed` changed
  private cur: Link | null = null
  private closed = false
  private lastErr: Error | null = null // why the last connection attempt failed
  private cred: string
  private reqId = 0
  private wireId = 0
  private readonly routes = new Map<number, Subscription>()
  private readonly subs = new Set<Subscription>()
  // Column layouts by "table\0version": versions are never reused for
  // another layout, so the cache survives reconnects.
  private readonly shapes = new Map<string, ShapeInfo>()
  private authLock: Promise<unknown> = Promise.resolve()
  private following: Link | null = null // the link the supervisor waits on
  private supervisor: Promise<void> = Promise.resolve()

  constructor(o: ResolvedOptions, discovery: Discovery | null = null) {
    this.o = o
    this.discovery = discovery
    this.cred = o.credential
  }

  /** Establishes the first connection (throwing its error), then keeps one alive until `close`. */
  async connect(opts?: CallOptions): Promise<void> {
    const sc = scope(this.life.signal, this.o.requestTimeoutMs, opts)
    let link: Link
    try {
      link = await this.dialOnce(sc.signal)
    } finally {
      sc.done()
    }
    this.install(link)
    this.supervisor = this.supervise(link)
  }

  /** Whether a credential provider can supply a fresh credential. */
  get canRefresh(): boolean {
    return this.o.credentialProvider !== null
  }

  /** The current session, or null while disconnected. */
  get session(): Session | null {
    return this.cur?.alive ? this.cur.info : null
  }

  /** Requests waiting for an answer on the current connection. */
  get pending(): number {
    return this.cur?.pending ?? 0
  }

  get isClosed(): boolean {
    return this.closed
  }

  snapshotStats(): Stats {
    const s = this.stats
    return {
      connected: this.cur?.alive ?? false,
      connects: s.connects,
      disconnects: s.disconnects,
      connectFailures: s.connectFailures,
      retries: s.retries,
      rateLimited: s.rateLimited,
      resyncs: s.resyncs,
      credentialRefreshes: s.refreshes,
      subscriptions: this.subs.size,
    }
  }

  /** Closes the connection and every subscription; calls in progress reject with ClosedError. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.life.abort(new ClosedError())
    this.changed.notify()
    await Promise.all([...this.subs].map((s) => s.close()))
    ;(this.following ?? this.cur)?.fail(new ClosedError())
    await this.supervisor
  }

  nextReqId(): number {
    this.reqId = this.reqId >= 0xffffffff ? 1 : this.reqId + 1
    return this.reqId
  }

  nextWireId(): number {
    this.wireId = this.wireId >= 0xffffffff ? 1 : this.wireId + 1
    return this.wireId
  }

  /** The delay before reconnect attempt n: exponential, capped, with full jitter. */
  backoff(n: number): number {
    let d = this.o.reconnectMinMs
    for (let i = 0; i < n && d < this.o.reconnectMaxMs; i++) d *= 2
    return Math.floor(Math.random() * Math.min(d, this.o.reconnectMaxMs)) + 1
  }

  scope(opts?: CallOptions): Scope {
    return scope(this.life.signal, this.o.requestTimeoutMs, opts)
  }

  /** Maps errors caused by `close` to ClosedError. */
  finalError(e: unknown): Error {
    if (this.closed) return e instanceof ClosedError ? e : new ClosedError()
    return e instanceof Error ? e : new Error(String(e))
  }

  private reportError(err: Error): void {
    try {
      this.o.hooks.onError?.(err)
    } catch {
      /* a hook must not break the client */
    }
  }

  /** Returns the credential for Hello, asking the provider when there is one. */
  private async credential(): Promise<string> {
    const p = this.o.credentialProvider
    if (!p) return this.cred
    let cred: string
    try {
      cred = await p()
    } catch (e) {
      throw new ConnectionError(`azora: credential provider: ${(e as Error).message}`)
    }
    if (!cred) throw new ConnectionError('azora: credential provider returned nothing')
    this.cred = cred
    return cred
  }

  private async dialOnce(signal: AbortSignal): Promise<Link> {
    const at = await this.discovery?.get(signal)
    let link: Link
    try {
      link = await dial(this.o, await this.credential(), signal, at)
    } catch (e) {
      // A discovered key that fails the handshake may have been rotated: the next attempt asks the server again.
      if (at && e instanceof HandshakeError) this.discovery?.invalidate(at)
      throw e
    }
    link.onMessage = (m, size) => this.handle(link, m, size)
    return link
  }

  private install(link: Link): void {
    this.cur = link
    this.lastErr = null
    this.stats.connects++
    this.changed.notify()
    try {
      this.o.hooks.onConnect?.(link.info)
    } catch {
      /* ignored */
    }
  }

  private uninstall(link: Link, cause: Error): void {
    if (this.cur === link) this.cur = null
    this.changed.notify()
    this.stats.disconnects++
    try {
      this.o.hooks.onDisconnect?.(this.closed ? new ClosedError() : cause)
    } catch {
      /* ignored */
    }
  }

  /** Follows the installed link, then reconnects (installing new links) until `close`. */
  private async supervise(link: Link | null): Promise<void> {
    let attempt = 0
    const pause = (ms: number): Promise<boolean> =>
      sleep(ms, this.life.signal).then(
        () => true,
        () => false,
      )
    for (;;) {
      this.following = link
      if (link) {
        const cause = await link.closed
        this.uninstall(link, cause)
        if (this.closed) return
        // A connection that died young does not reset the backoff, so a
        // server that accepts and drops cannot cause a reconnect storm.
        attempt = Date.now() - link.started < 2000 ? attempt + 1 : 0
        const delay = link.goAwayMs > 0 ? link.goAwayMs + this.backoff(0) : this.backoff(attempt)
        link = null
        if (!(await pause(delay))) return
      }
      const sc = scope(this.life.signal, this.o.requestTimeoutMs)
      try {
        link = await this.dialOnce(sc.signal)
      } catch (e) {
        if (this.closed) return
        const err = e instanceof Error ? e : new Error(String(e))
        this.stats.connectFailures++
        this.lastErr = err
        this.changed.notify() // waiters may fail fast on a permanent error
        this.reportError(err)
        attempt++
        if (!(await pause(this.backoff(attempt)))) return
        continue
      } finally {
        sc.done()
      }
      if (this.closed) {
        link.fail(new ClosedError())
        return
      }
      this.install(link)
    }
  }

  /**
   * Returns the current link, waiting for one. With failFast, a permanent
   * connection error (credential refused, ...) is thrown instead of waiting.
   */
  async waitLink(signal: AbortSignal, failFast: boolean): Promise<Link> {
    for (;;) {
      if (this.closed) throw new ClosedError()
      if (this.cur?.alive) return this.cur
      if (failFast && this.lastErr && isPermanent(this.lastErr)) throw this.lastErr
      try {
        await this.changed.wait(signal)
      } catch (e) {
        if (e instanceof TimeoutError && this.lastErr) {
          throw new TimeoutError(`${e.message} (not connected: ${this.lastErr.message})`)
        }
        throw e
      }
    }
  }

  /**
   * Sends a request built by build (given its request id) until it gets an
   * answer: through reconnects, rate limits and credential refreshes.
   */
  async call(build: (id: number) => Msg, policy: CallPolicy = {}, opts?: CallOptions): Promise<Msg> {
    const sc = this.scope(opts)
    try {
      let refreshed = 0
      let unavailable = 0
      for (;;) {
        const link = await this.waitLink(sc.signal, true)
        const gen = link.authGen
        const id = this.nextReqId()
        let m: Msg
        try {
          m = await link.roundTrip(id, build(id), sc.signal)
        } catch (e) {
          if (e instanceof LostError) {
            if (policy.once && e.sent) throw new UnknownOutcomeError()
            this.stats.retries++
            continue
          }
          throw e
        }
        if (m.type !== MsgType.Error) return m
        if (m.retryAfterMs > 0) {
          this.stats.rateLimited++
          await sleep(m.retryAfterMs, sc.signal)
          continue
        }
        if (m.code === ErrorCode.Unauthenticated && !policy.noRefresh && this.canRefresh && refreshed < 2) {
          refreshed++
          await this.reauth(link, gen, sc.signal)
          continue
        }
        if (m.code === ErrorCode.Unavailable && unavailable < 5) {
          unavailable++
          await sleep(this.backoff(unavailable), sc.signal)
          continue
        }
        throw toError(m)
      }
    } catch (e) {
      throw this.finalError(e)
    } finally {
      sc.done()
    }
  }

  /**
   * Fetches a credential from the provider and sends it with Auth on
   * link, unless another refresh happened since gen was observed.
   */
  reauth(link: Link, gen: number, signal: AbortSignal): Promise<void> {
    const run = async (): Promise<void> => {
      if (link.authGen !== gen) return
      const cred = await this.credential()
      for (;;) {
        const id = this.nextReqId()
        let m: Msg
        try {
          m = await link.roundTrip(id, { type: MsgType.Auth, reqId: id, credential: cred }, signal)
        } catch (e) {
          if (e instanceof LostError) return // the next connection sends the new credential in Hello
          throw e
        }
        if (m.type === MsgType.Error) {
          if (m.retryAfterMs > 0) {
            await sleep(m.retryAfterMs, signal)
            continue
          }
          throw toError(m)
        }
        this.stats.refreshes++
        link.authGen++
        return
      }
    }
    const p = this.authLock.then(run, run)
    this.authLock = p.catch(() => {})
    return p
  }

  /** Dispatches a message that is not an answer to a request. */
  private handle(link: Link, m: Msg, size: number): void {
    switch (m.type) {
      case MsgType.Shape:
        this.putShape(m)
        return
      case MsgType.Batch:
        this.routes.get(m.subId)?.onBatch(m, size)
        return
      case MsgType.SubEnd:
        this.routes.get(m.subId)?.onEnd(m)
        return
      case MsgType.Error: {
        const err = toError(m)
        if (!m.fatal && m.code === ErrorCode.Unauthenticated && this.canRefresh) {
          this.reauth(link, link.authGen, this.life.signal).catch((e: unknown) => {
            if (link.alive) this.reportError(e instanceof Error ? e : new Error(String(e)))
          })
          return
        }
        this.reportError(err)
        if (m.fatal) link.fail(err)
        return
      }
      case MsgType.GoAway: {
        link.goAwayMs = Math.max(m.retryAfterMs, 1)
        if (this.cur === link) {
          // Stop handing the link to new requests; let answers in flight arrive.
          this.cur = null
          this.changed.notify()
        }
        const deadline = Date.now() + 1000
        const leave = (): void => {
          if (!link.alive) return
          if (link.pending > 0 && Date.now() < deadline) setTimeout(leave, 10)
          else link.fail(new ConnectionError(`azora: server going away${m.reason ? ': ' + m.reason : ''}`))
        }
        leave()
        return
      }
    }
  }

  private putShape(s: Shape): void {
    this.shapes.set(`${s.table.toLowerCase()}\0${s.tv}`, { columns: Object.freeze(s.columns), pk: Object.freeze(s.pk) })
  }

  /** The column layout of a table version, when the server sent it. */
  shape(table: string, tv: number): ShapeInfo | undefined {
    return this.shapes.get(`${table.toLowerCase()}\0${tv}`)
  }

  route(wire: number, s: Subscription): void {
    this.routes.set(wire, s)
  }

  unroute(wire: number, s: Subscription): void {
    if (this.routes.get(wire) === s) this.routes.delete(wire)
  }

  forget(s: Subscription): void {
    this.subs.delete(s)
  }

  noteResync(subId: number, reason: string): void {
    this.stats.resyncs++
    try {
      this.o.hooks.onResync?.(subId, reason)
    } catch {
      /* ignored */
    }
  }

  // Requests.

  async query(sql: string, args: Value[] | null, maxRows: number, opts?: CallOptions): Promise<Result> {
    const m = await this.call((id) => ({ type: MsgType.Query, reqId: id, sql, args, maxRows }), {}, opts)
    if (m.type !== MsgType.Result) throw new Error(`azora: unexpected answer type ${m.type}`)
    return m
  }

  /** Sends statements as one Exec (single) or a Tx; exactly once when mutationId is set. */
  async write(mutationId: string, stmts: Array<{ sql: string; args: Value[] | null }>, single: boolean, opts?: CallOptions): Promise<Result> {
    const m = await this.call(
      (id) =>
        single
          ? { type: MsgType.Exec, reqId: id, mutationId, sql: (stmts[0] as { sql: string }).sql, args: (stmts[0] as { args: Value[] | null }).args }
          : { type: MsgType.Tx, reqId: id, mutationId, statements: stmts },
      { once: mutationId === '' },
      opts,
    )
    if (m.type !== MsgType.Result) throw new Error(`azora: unexpected answer type ${m.type}`)
    return m
  }

  async sign(objectId: string, ttlSeconds: number, opts?: CallOptions): Promise<Signed> {
    const m = await this.call((id) => ({ type: MsgType.Sign, reqId: id, objectId, ttlSeconds }), {}, opts)
    if (m.type !== MsgType.Signed) throw new Error(`azora: unexpected answer type ${m.type}`)
    return m
  }

  /**
   * Runs a published unit. argsJSON is the JSON text of its arguments (""
   * for none). The mutation id is sent again unchanged after a lost
   * connection, so the call is always safe to retry.
   */
  async callUnit(name: string, argsJSON: string, mutationId: string, opts?: CallOptions): Promise<Returned> {
    const m = await this.call((id) => ({ type: MsgType.Call, reqId: id, unit: name, args: argsJSON, mutationId }), {}, opts)
    if (m.type !== MsgType.Returned) throw new Error(`azora: unexpected answer type ${m.type}`)
    return m
  }

  /**
   * Sends a UnitAdmin operation and returns the JSON text of its result.
   * Operations that change state (deploy, activate, call, secrets.set, ...)
   * are not sent again once written: a lost connection then is an
   * UnknownOutcomeError. Reads are retried.
   */
  async unitAdmin(op: string, body: string, opts?: CallOptions): Promise<string> {
    const m = await this.call((id) => ({ type: MsgType.UnitAdmin, reqId: id, op, body }), { once: !UNIT_ADMIN_READS.has(op) }, opts)
    if (m.type !== MsgType.UnitAdminResult) throw new Error(`azora: unexpected answer type ${m.type}`)
    return m.body
  }

  /** Replaces the credential: sent to the server now and used for later connections. */
  async setCredential(cred: string, opts?: CallOptions): Promise<void> {
    this.cred = cred
    await this.call((id) => ({ type: MsgType.Auth, reqId: id, credential: cred }), { noRefresh: true }, opts)
    this.stats.refreshes++
  }

  /** The credential in use (the last one a provider returned). */
  get currentCredential(): string {
    return this.cred
  }

  async subscribe(spec: SubscribeSpec, opts?: CallOptions): Promise<Subscription> {
    if (this.closed) throw new ClosedError()
    const s = new Subscription(this, spec)
    this.subs.add(s)
    const sc = this.scope(opts)
    try {
      await s.open(sc.signal)
      return s
    } catch (e) {
      await s.close()
      throw this.finalError(e)
    } finally {
      sc.done()
    }
  }
}
