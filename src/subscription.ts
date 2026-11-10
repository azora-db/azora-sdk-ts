/**
 * A live feed of a subscription's rows. It survives reconnects: it resumes
 * from the last checkpoint it received, skips changes it already has, and
 * takes a new snapshot (an update with `reset`) only when the server can
 * no longer resume it.
 */
import type { Client } from './client.ts'
import { toValue, type Value } from './codec.ts'
import { AzoraError, ClosedError, ErrorCode, LostError, ResyncError, RetryVerifyError } from './errors.ts'
import { toWireFilter } from './filter.ts'
import { Kind, MsgType, Op, type Batch, type Subscribe, type SubEnd } from './messages.ts'
import type { Link } from './session.ts'
import type { Change, Operation, SubscribeSpec, SubscriptionKind, Update, VerifyResult } from './types.ts'
import { Notifier, sleep, type CallOptions } from './util.ts'

const KIND: Record<SubscriptionKind, number> = {
  database: Kind.Database,
  table: Kind.Table,
  row: Kind.Row,
  files: Kind.Files,
  notify: Kind.Notify,
}
const OP_NAME: Record<number, Operation> = { [Op.Insert]: 'insert', [Op.Update]: 'update', [Op.Delete]: 'delete' }
const OP_BIT: Record<Operation, number> = { insert: 1, update: 2, delete: 4 }
const NO_COLUMNS: readonly string[] = Object.freeze([])

/** A complete step of changes ending at a checkpoint, waiting for `next`. */
interface Staged {
  changes: Change[]
  cp: number
  epoch: bigint
  reset: boolean
  snapshot: boolean
  bytes: number
}

function kindOf(spec: SubscribeSpec): SubscriptionKind {
  if (spec.kind) return spec.kind
  if (spec.table) return spec.key ? 'row' : 'table'
  if (spec.tables) return 'notify'
  if (spec.bucket || spec.pathPrefix || spec.key) return 'files'
  return 'database'
}

let subIds = 0

/** A subscription. `next()` (or `for await`) is for one consumer at a time. */
export class Subscription implements AsyncIterable<Update> {
  /** Identifies the subscription within the client (`onResync` reports it). */
  readonly id = ++subIds
  readonly spec: Readonly<SubscribeSpec>
  readonly kind: SubscriptionKind

  private readonly c: Client
  private readonly tmpl: Subscribe
  private readonly abort = new AbortController()
  private readonly stateChanged = new Notifier()
  private readonly wake = new Notifier() // wakes next()
  private readonly events = new Notifier() // wakes the run loop
  private done: Promise<void> = Promise.resolve()

  private wire = 0
  private link: Link | null = null
  private active = false
  private started = false
  private err: Error | null = null
  private ended: SubEnd | null = null
  private resyncRequested = false

  // Stream state. Changes are staged until a checkpoint completes them.
  private needSnapshot = false
  private rcvCP = 0
  private rcvEpoch = 0n
  private threshold = 0 // changes with seq <= threshold were already received
  private partial: Change[] = []
  private pReset = false
  private pSnap = false
  private partialBytes = 0
  private ready: Staged[] = []
  private readyBytes = 0
  private delivered = 0
  private deliverEpoch = 0n
  private ackPending = 0
  private notifyQ: string[][] = []
  private pv: VerifyResult | null = null // server checksum waiting for delivery up to its checkpoint
  private busy = false

  /** @internal Use `db.subscribe()`. */
  constructor(c: Client, spec: SubscribeSpec) {
    this.c = c
    this.spec = spec
    this.kind = kindOf(spec)
    let ops = 0
    for (const o of spec.ops ?? []) {
      const bit = OP_BIT[o]
      if (!bit) throw new TypeError(`azora: unknown operation "${o}"`)
      ops |= bit
    }
    this.tmpl = {
      type: MsgType.Subscribe,
      reqId: 0,
      subId: 0,
      kind: KIND[this.kind],
      table: spec.table ?? '',
      key: spec.key ? spec.key.map(toValue) : null,
      where: toWireFilter(spec.where),
      ops,
      since: 0,
      epoch: 0n,
      noSnapshot: spec.noSnapshot ?? false,
      bucket: spec.bucket ?? '',
      pathPrefix: spec.pathPrefix ?? '',
      tables: spec.tables ? [...spec.tables] : [],
    }
    if (!this.tmpl.kind) throw new TypeError(`azora: unknown subscription kind "${String(spec.kind)}"`)
    if (this.kind !== 'notify') {
      if (spec.since && spec.since > 0) {
        this.rcvCP = this.threshold = this.delivered = spec.since
        this.rcvEpoch = this.deliverEpoch = spec.epoch ?? 0n
      } else if (!spec.noSnapshot) {
        this.needSnapshot = true
      }
    }
  }

  /** @internal Starts the subscription; resolves once the server confirmed it. */
  open(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let reported = false
      const first = (err?: Error): void => {
        if (reported) return
        reported = true
        signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const onAbort = (): void => {
        first(signal.reason as Error)
        void this.close()
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      this.done = this.run(first)
    })
  }

  /**
   * The checkpoint and epoch of the last update `next` returned: store
   * them to resume in another process (`since` and `epoch`).
   */
  get checkpoint(): { checkpoint: number; epoch: bigint } {
    return { checkpoint: this.delivered, epoch: this.deliverEpoch }
  }

  /**
   * The size of the messages received and not yet returned by `next`. The
   * server stops sending about 4 MiB past the last update the application
   * consumed, so it stays bounded.
   */
  get buffered(): number {
    return this.partialBytes + this.readyBytes
  }

  /** Whether the subscription is closed or failed. */
  get closed(): boolean {
    return this.err !== null
  }

  /** Ends the subscription; `next` rejects with ClosedError afterwards. */
  async close(): Promise<void> {
    this.abort.abort(new ClosedError())
    this.events.notify()
    await this.done
    this.c.forget(this)
  }

  /**
   * Drops the resume point and asks for a new snapshot: the next update
   * has `reset` set. Use it after `verify` reports a mismatch.
   */
  resync(): void {
    this.resyncRequested = true
    this.events.notify()
  }

  private fail(err: Error): void {
    if (!this.err) {
      this.err = err
      if (err instanceof ClosedError) {
        this.ready = []
        this.partial = []
        this.notifyQ = []
        this.readyBytes = this.partialBytes = 0
      }
    }
    this.active = false
    this.stateChanged.notify()
    this.wake.notify()
  }

  /** Prepares the Subscribe of a new incarnation on link. */
  private begin(link: Link, wire: number): Subscribe {
    const m: Subscribe = { ...this.tmpl, subId: wire }
    this.partial = [] // an incomplete tail is sent again
    this.pReset = this.pSnap = false
    this.partialBytes = 0
    this.wire = wire
    this.link = link
    this.active = false
    this.ended = null
    if (this.kind !== 'notify') {
      if (this.needSnapshot && this.spec.noSnapshot) {
        // Resume point lost without a snapshot: the first update carries
        // reset to mark the gap.
        m.noSnapshot = true
        this.threshold = 0
        this.pReset = this.started
      } else if (this.needSnapshot) {
        m.noSnapshot = false
        this.threshold = 0
      } else if (this.rcvCP > 0) {
        m.since = this.rcvCP
        m.epoch = this.rcvEpoch
        this.threshold = this.rcvCP
      } else {
        m.noSnapshot = true // no checkpoint yet
      }
    }
    this.c.route(wire, this)
    return m
  }

  private setActive(wire: number): void {
    if (this.wire !== wire) return
    this.active = true
    if (this.started && this.kind === 'notify') {
      // Signals may have been missed while resubscribing.
      this.notifyQ.push(['*'])
      this.wake.notify()
    }
    this.started = true
    this.stateChanged.notify()
  }

  /** Ends incarnation wire: its late messages are ignored. */
  private unroute(wire: number): void {
    this.c.unroute(wire, this)
    if (this.wire === wire) {
      this.wire = 0
      this.active = false
      this.stateChanged.notify()
    }
  }

  /** Forgets the resume point so the next incarnation takes a new snapshot. */
  private dropResumePoint(reason: string): boolean {
    if (this.spec.manualResync) return false
    this.ready = []
    this.partial = []
    this.readyBytes = this.partialBytes = 0
    this.pReset = this.pSnap = false
    this.rcvCP = this.threshold = 0
    this.needSnapshot = true
    this.pv = null
    this.c.noteResync(this.id, reason)
    return true
  }

  private get closing(): boolean {
    return this.abort.signal.aborted
  }

  /** Keeps the subscription subscribed on the current connection. */
  private async run(first: (err?: Error) => void): Promise<void> {
    const signal = this.abort.signal
    const fail = (err: Error): void => {
      this.fail(err)
      first(err)
    }
    let backoff = 0
    let refreshed = 0
    for (;;) {
      let link: Link
      try {
        link = await this.c.waitLink(signal, false)
      } catch {
        return fail(new ClosedError())
      }
      const wire = this.c.nextWireId()
      const msg = this.begin(link, wire)
      const gen = link.authGen
      msg.reqId = this.c.nextReqId()
      let answer
      try {
        answer = await link.roundTrip(msg.reqId, msg, signal)
      } catch (e) {
        this.unroute(wire)
        if (this.closing) return fail(new ClosedError())
        if (e instanceof LostError) continue
        return fail(e as Error)
      }
      if (answer.type === MsgType.Subscribed) {
        backoff = refreshed = 0
        this.setActive(wire)
        first()
      } else if (answer.type === MsgType.Error) {
        this.unroute(wire)
        try {
          if (answer.retryAfterMs > 0) {
            this.c.stats.rateLimited++
            await sleep(answer.retryAfterMs, signal)
            continue
          }
          if (answer.code === ErrorCode.Gone) {
            if (this.dropResumePoint(answer.message)) continue
            return fail(new ResyncError(`azora: resync required: ${answer.message}`))
          }
          if (answer.code === ErrorCode.Unauthenticated && this.c.canRefresh && refreshed < 2) {
            refreshed++
            const ok = await this.c.reauth(link, gen, signal).then(
              () => true,
              () => false,
            )
            if (ok) continue
          } else if (answer.code === ErrorCode.Unavailable || answer.code === ErrorCode.Internal) {
            // Transient (database reopening, ...): retry with backoff.
            backoff = Math.min(backoff + 1, 16)
            await sleep(this.c.backoff(backoff), signal)
            continue
          }
        } catch {
          return fail(new ClosedError())
        }
        return fail(new AzoraError(answer.code, answer.message))
      } else {
        this.unroute(wire)
        link.fail(new Error(`azora: unexpected answer type ${answer.type} to subscribe`))
        continue
      }
      const more = await this.follow(link, wire, (n) => {
        backoff = n < 0 ? Math.min(backoff + 1, 16) : n
        return backoff
      })
      if (!more) return
    }
  }

  /** Follows an active incarnation until it ends; false ends `run`. */
  private async follow(link: Link, wire: number, setBackoff: (n: number) => number): Promise<boolean> {
    const linkDown = link.closed.then(() => this.events.notify())
    void linkDown
    for (;;) {
      if (this.closing) {
        this.sendUnsubscribe(link, wire)
        this.unroute(wire)
        this.fail(new ClosedError())
        return false
      }
      if (!link.alive) {
        this.unroute(wire)
        return true
      }
      const end = this.ended
      if (end && end.subId === wire) {
        this.ended = null
        this.unroute(wire)
        switch (end.code) {
          case ErrorCode.Gone:
            if (!this.dropResumePoint(end.message)) {
              this.fail(new ResyncError(`azora: resync required: ${end.message}`))
              return false
            }
            return true
          case ErrorCode.Unavailable:
            setBackoff(0) // the database was closed or reopened: resume
            return true
          case ErrorCode.Invalid:
          case ErrorCode.PermissionDenied:
          case ErrorCode.NotFound:
            this.fail(new AzoraError(end.code, end.message))
            return false
          default:
            try {
              await sleep(this.c.backoff(setBackoff(-1)), this.abort.signal)
            } catch {
              this.fail(new ClosedError())
              return false
            }
            return true
        }
      }
      if (this.resyncRequested) {
        this.resyncRequested = false
        this.sendUnsubscribe(link, wire)
        this.unroute(wire)
        this.dropResumePoint('requested')
        return true
      }
      await this.events.wait()
    }
  }

  private sendUnsubscribe(link: Link, wire: number): void {
    link.sendCtrl({ type: MsgType.Unsubscribe, reqId: this.c.nextReqId(), subId: wire })
  }

  /** @internal Stages a batch of the current incarnation. */
  onBatch(b: Batch, size: number): void {
    if (b.subId !== this.wire || this.err) return
    if (this.kind === 'notify') {
      if (b.tables.length > 0) {
        if (this.notifyQ.length >= 1024) this.notifyQ = [['*']]
        else this.notifyQ.push(b.tables)
        this.wake.notify()
      }
      return
    }
    if (b.reset) {
      // A new snapshot replaces everything not yet delivered.
      this.ready = []
      this.partial = []
      this.readyBytes = this.partialBytes = 0
      this.pReset = true
    }
    if (b.snapshot) this.pSnap = true
    const thr = this.threshold
    let top = thr
    for (const w of b.changes) {
      if (w.seq !== 0 && w.seq <= thr) continue // sent again after a server-side resume
      const shape = this.c.shape(w.table, w.tv)
      const ch: Change = {
        seq: w.seq,
        table: w.table,
        op: OP_NAME[w.op] ?? 'update',
        key: w.key ?? [],
        new: w.new,
        old: w.old,
        columns: shape?.columns ?? NO_COLUMNS,
        pk: shape?.pk ?? NO_COLUMNS,
        tv: w.tv,
      }
      if (w.keyFloats) ch.keyFloats = w.keyFloats
      if (w.newFloats) ch.newFloats = w.newFloats
      this.partial.push(ch)
      if (w.seq > top) top = w.seq
    }
    this.threshold = top
    this.partialBytes += size
    if (b.checkpoint === 0) return
    if (b.checkpoint <= this.rcvCP && this.partial.length === 0 && !this.pReset) {
      this.partialBytes = 0
      return
    }
    this.ready.push({ changes: this.partial, cp: b.checkpoint, epoch: b.epoch, reset: this.pReset, snapshot: this.pSnap, bytes: this.partialBytes })
    this.readyBytes += this.partialBytes
    this.partial = []
    this.pReset = this.pSnap = false
    this.partialBytes = 0
    this.rcvCP = b.checkpoint
    this.rcvEpoch = b.epoch
    if (b.checkpoint > this.threshold) this.threshold = b.checkpoint
    this.needSnapshot = false
    this.wake.notify()
  }

  /** @internal A SubEnd of the current incarnation. */
  onEnd(m: SubEnd): void {
    if (m.subId !== this.wire) return
    this.ended = m
    this.events.notify()
  }

  /**
   * The next update, waiting for one. Updates are consistent steps ending
   * at a checkpoint. Calling `next` again acknowledges the previous update
   * (the application has applied it), which lets the server send more: an
   * application that stops calling `next` pauses the stream instead of
   * growing memory.
   */
  async next(opts?: Pick<CallOptions, 'signal'>): Promise<Update> {
    if (this.busy) throw new Error('azora: Subscription.next() is already waiting: a subscription has one consumer')
    this.busy = true
    try {
      this.flushAck()
      for (;;) {
        if (this.err instanceof ClosedError) throw this.err
        const tables = this.notifyQ.shift()
        if (tables) return { reset: false, snapshot: false, changes: [], checkpoint: 0, epoch: 0n, tables }
        if (this.ready.length > 0) return this.take()
        if (this.err) throw this.err
        await this.wake.wait(opts?.signal)
      }
    } finally {
      this.busy = false
    }
  }

  /** Iterates updates until the subscription is closed (the loop then ends) or fails (it throws). */
  async *[Symbol.asyncIterator](): AsyncGenerator<Update, void, void> {
    try {
      for (;;) {
        let u: Update
        try {
          u = await this.next()
        } catch (e) {
          if (e instanceof ClosedError) return
          throw e
        }
        yield u
      }
    } finally {
      await this.close()
    }
  }

  /** Acknowledges the last delivered checkpoint. */
  private flushAck(): void {
    const cp = this.ackPending
    this.ackPending = 0
    if (cp > 0 && this.active && this.link?.alive) {
      this.link.sendCtrl({ type: MsgType.Ack, subId: this.wire, checkpoint: cp }) // a lost connection resumes anyway
    }
  }

  /**
   * Builds the next update from staged checkpoints: every complete step
   * merged, stopping at a pending verify checkpoint (splitting a step
   * there if needed) and at snapshots.
   */
  private take(): Update {
    const first = this.ready[0] as Staged
    if (this.pv && (this.pv.epoch !== first.epoch || this.pv.checkpoint <= this.delivered)) this.pv = null
    const limit = this.pv ? this.pv.checkpoint : Number.MAX_SAFE_INTEGER
    const u: Update = { reset: false, snapshot: false, changes: [], checkpoint: 0, epoch: 0n, tables: [] }
    let n = 0
    let bytes = 0
    if (first.reset || first.snapshot) {
      u.reset = first.reset
      u.snapshot = first.snapshot
      u.changes = first.changes
      u.checkpoint = first.cp
      u.epoch = first.epoch
      bytes = first.bytes
      n = 1
      if (this.pv && this.pv.checkpoint !== first.cp) this.pv = null
    } else {
      while (n < this.ready.length) {
        const r = this.ready[n] as Staged
        if (r.reset || r.snapshot || r.cp > limit) break
        u.changes = n === 0 ? r.changes : u.changes.concat(r.changes)
        u.checkpoint = r.cp
        u.epoch = r.epoch
        bytes += r.bytes
        n++
      }
      if (u.checkpoint < limit && n < this.ready.length) {
        const r = this.ready[n] as Staged
        if (!r.reset && !r.snapshot && r.cp > limit) {
          let k = 0
          while (k < r.changes.length && (r.changes[k] as Change).seq <= limit) k++
          u.changes = u.changes.concat(r.changes.slice(0, k))
          r.changes = r.changes.slice(k)
          u.checkpoint = limit
          u.epoch = r.epoch
        }
      }
    }
    this.ready.splice(0, n)
    this.readyBytes = this.ready.length === 0 ? 0 : Math.max(0, this.readyBytes - bytes)
    this.delivered = this.ackPending = u.checkpoint
    this.deliverEpoch = u.epoch
    return u
  }

  /**
   * Compares the server's checksum of the subscription's rows with
   * local's (for example `Replica.checksum`). Call it after applying the
   * last update: local must describe exactly what `next` delivered so far.
   *
   * The server computes its checksum at its current checkpoint. When that
   * is the checkpoint the application is at, or nothing the subscription
   * covers changed in between, `verify` compares at once. Otherwise it
   * rejects with RetryVerifyError and remembers the server's checksum: the
   * next update stops exactly at that checkpoint, and the following
   * `verify` compares against it without asking the server again.
   */
  async verify(local: () => { rows: number; sum: bigint }, opts?: CallOptions): Promise<VerifyResult> {
    if (this.kind === 'notify') throw new Error('azora: notify subscriptions have no rows to verify')
    const compare = (res: VerifyResult): VerifyResult => {
      const l = local()
      res.localRows = l.rows
      res.localSum = BigInt.asUintN(64, l.sum)
      res.match = res.localRows === res.serverRows && res.localSum === res.serverSum
      return res
    }
    if (this.pv && this.pv.checkpoint === this.delivered && this.pv.epoch === this.deliverEpoch) {
      const res = this.pv
      this.pv = null
      return compare(res)
    }
    const sc = this.c.scope(opts)
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 20) throw new Error('azora: verify: the subscription keeps restarting')
        const { link, wire } = await this.waitActive(sc.signal)
        const gen = link.authGen
        const id = this.c.nextReqId()
        let m
        try {
          m = await link.roundTrip(id, { type: MsgType.Verify, reqId: id, subId: wire }, sc.signal)
        } catch (e) {
          if (e instanceof LostError) continue
          throw e
        }
        if (m.type === MsgType.Error) {
          if (m.retryAfterMs > 0) {
            this.c.stats.rateLimited++
            await sleep(m.retryAfterMs, sc.signal)
            continue
          }
          if (m.code === ErrorCode.NotFound) {
            await sleep(10, sc.signal) // the incarnation ended meanwhile
            continue
          }
          if (m.code === ErrorCode.Unauthenticated && this.c.canRefresh && attempt < 3) {
            await this.c.reauth(link, gen, sc.signal)
            continue
          }
          throw new AzoraError(m.code, m.message)
        }
        if (m.type !== MsgType.Verified) throw new Error(`azora: unexpected answer type ${m.type} to verify`)
        const res: VerifyResult = {
          match: false, checkpoint: m.checkpoint, epoch: m.epoch, serverRows: m.rows, serverSum: m.sum, localRows: 0, localSum: 0n,
        }
        if (this.wire !== wire) continue
        const d = this.delivered
        if (m.epoch !== this.deliverEpoch || this.resetPending() || d === 0) throw new RetryVerifyError()
        if (m.checkpoint === d) return compare(res)
        if (m.checkpoint < d) continue
        if (this.rcvCP >= m.checkpoint && !this.changesIn(d, m.checkpoint)) {
          // Nothing this subscription covers changed in (d, V]: the
          // application's state at d is the state at V.
          return compare(res)
        }
        this.pv = res
        throw new RetryVerifyError()
      }
    } catch (e) {
      throw this.c.finalError(e)
    } finally {
      sc.done()
    }
  }

  /** Whether a new snapshot is pending: the application's state is about to be replaced. */
  private resetPending(): boolean {
    return this.needSnapshot || this.pReset || this.ready.some((r) => r.reset)
  }

  /** Whether staged changes have lo < seq <= hi. */
  private changesIn(lo: number, hi: number): boolean {
    const inRange = (c: Change): boolean => c.seq > lo && c.seq <= hi
    return this.ready.some((r) => r.changes.some(inRange)) || this.partial.some(inRange)
  }

  /** Waits until the subscription is subscribed on a live connection. */
  private async waitActive(signal: AbortSignal): Promise<{ link: Link; wire: number }> {
    for (;;) {
      if (this.err) throw this.err
      if (this.active && this.link?.alive) return { link: this.link, wire: this.wire }
      await this.stateChanged.wait(signal)
    }
  }
}

/** Builds an object from positional values and their column names. */
export function rowObject(columns: readonly string[], values: readonly Value[]): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (let i = 0; i < columns.length; i++) out[columns[i] as string] = values[i] ?? null
  return out
}
