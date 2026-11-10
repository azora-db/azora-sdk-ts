/** One established session: a channel after Hello and Welcome. */
import { type Channel, fingerprint, openChannel } from './channel.ts'
import { encodeServerKey, type ResolvedOptions } from './config.ts'
import { AzoraError, ConnectionError, LostError } from './errors.ts'
import type { Endpoint } from './discovery.ts'
import { decode, encode, MsgType, PROTOCOL_VERSION, type Msg, type Welcome } from './messages.ts'
import { connectWebSocket, type Transport } from './transport.ts'
import { connectTCP } from '#tcp'

/** An established session, as the server's Welcome describes it. */
export interface Session {
  sessionId: string
  /** The server's clock when the session started. */
  serverTime: Date
  heartbeatMs: number
  /** The largest message either side may send, in bytes. */
  maxMessage: number
  /** Who the credential identifies. */
  principal: string
  /** What it may do: `read`, `write`, `ddl`, `admin`. */
  scopes: string[]
  maxSubscriptions: number
  /** The channel's security: `IK`, `XX` or `plaintext`. */
  mode: string
  /** The server's public key (base64url; empty in plaintext) and its fingerprint. */
  serverKey: string
  fingerprint: string
}

interface Call {
  resolve: (m: Msg) => void
  reject: (e: Error) => void
}

/** The heartbeat found the server silent for three intervals. */
export const HEARTBEAT_ERROR = 'azora: no traffic from the server for three heartbeat intervals'

/** @internal A live connection carrying requests and subscription traffic. */
export class Link {
  readonly info: Session
  readonly started = Date.now()
  alive = true
  /** Why the link ended (set once dead). */
  cause: Error | null = null
  /** Bumped whenever a new credential was accepted on this link. */
  authGen = 0
  /** The server's reconnect hint after a GoAway, in ms (0: none). */
  goAwayMs = 0
  /** Receives every message that is not an answer to a request. */
  onMessage: (m: Msg, size: number) => void = () => {}
  /** Resolves with the cause when the link ends. */
  readonly closed: Promise<Error>

  private readonly ch: Channel
  private readonly calls = new Map<number, Call>()
  private readonly hbMs: number
  private lastRecv = Date.now()
  private lastPing = 0
  private nonce = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private resolveClosed: (e: Error) => void = () => {}

  constructor(ch: Channel, w: Welcome) {
    this.ch = ch
    this.hbMs = w.heartbeatMs > 0 ? w.heartbeatMs : 15_000
    this.info = {
      sessionId: w.sessionId,
      serverTime: new Date(w.serverTimeMs),
      heartbeatMs: this.hbMs,
      maxMessage: w.maxMessage,
      principal: w.principal,
      scopes: w.scopes,
      maxSubscriptions: w.maxSubscriptions,
      mode: ch.mode,
      serverKey: ch.serverKey ? encodeServerKey(ch.serverKey) : '',
      fingerprint: ch.serverKey ? fingerprint(ch.serverKey) : '',
    }
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    ch.onMessage = (raw) => {
      this.lastRecv = Date.now()
      this.dispatch(decode(raw), raw.length) // a malformed message ends the channel
    }
    ch.onClose = (err) => this.fail(err ?? new ConnectionError('azora: connection closed by the server'))
    this.timer = setInterval(() => this.heartbeat(), Math.max(this.hbMs / 8, 20))
  }

  private dispatch(m: Msg, size: number): void {
    switch (m.type) {
      case MsgType.Ping:
        this.sendCtrl({ type: MsgType.Pong, nonce: m.nonce })
        return
      case MsgType.Pong:
      case MsgType.Welcome:
        return
      case MsgType.Result:
      case MsgType.OK:
      case MsgType.Subscribed:
      case MsgType.Verified:
      case MsgType.Signed:
      case MsgType.Returned:
      case MsgType.UnitAdminResult:
        this.deliver(m.reqId, m)
        return
      case MsgType.Error:
        if (m.reqId !== 0) {
          this.deliver(m.reqId, m)
          return
        }
    }
    this.onMessage(m, size)
  }

  private deliver(id: number, m: Msg): void {
    const c = this.calls.get(id)
    if (c) {
      this.calls.delete(id)
      c.resolve(m)
    }
  }

  /** Pings a silent server and gives up after three silent intervals. */
  private heartbeat(): void {
    const now = Date.now()
    const silent = now - this.lastRecv
    if (silent > 3 * this.hbMs) {
      this.fail(new ConnectionError(HEARTBEAT_ERROR))
    } else if (silent > this.hbMs && now - this.lastPing > this.hbMs / 2) {
      this.lastPing = now
      this.sendCtrl({ type: MsgType.Ping, nonce: ++this.nonce })
    }
  }

  /** Requests waiting for an answer. */
  get pending(): number {
    return this.calls.size
  }

  /** Bytes queued for sending. */
  get bufferedAmount(): number {
    return this.ch.bufferedAmount
  }

  /**
   * Writes m. A failed write ends the link (the channel cannot recover
   * from a partial message) and throws a {@link LostError}; a message over
   * the size limit throws an `AzoraError` and leaves the link usable.
   */
  send(m: Msg): void {
    if (!this.alive) throw new LostError(false, this.cause)
    const b = encode(m)
    try {
      this.ch.send(b)
    } catch (e) {
      if (e instanceof AzoraError) throw e
      this.fail(e instanceof Error ? e : new ConnectionError(String(e)))
      throw new LostError(true, e)
    }
  }

  /** Sends a control message (pong, ack, unsubscribe), best effort. */
  sendCtrl(m: Msg): void {
    try {
      this.send(m)
    } catch {
      /* a lost connection resumes anyway */
    }
  }

  /** Sends m (whose request id is id) and waits for its answer. */
  roundTrip(id: number, m: Msg, signal: AbortSignal): Promise<Msg> {
    return new Promise<Msg>((resolve, reject) => {
      if (!this.alive) return reject(new LostError(false, this.cause))
      if (signal.aborted) return reject(signal.reason as Error)
      const onAbort = (): void => {
        this.calls.delete(id)
        reject(signal.reason as Error)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.calls.set(id, {
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort)
          resolve(r)
        },
        reject: (e) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      try {
        this.send(m)
      } catch (e) {
        this.calls.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(e as Error)
      }
    })
  }

  /** Ends the link with err as its cause; pending requests fail with a LostError. */
  fail(err: Error): void {
    if (!this.alive) return
    this.alive = false
    this.cause = err
    clearInterval(this.timer)
    this.ch.close()
    const calls = [...this.calls.values()]
    this.calls.clear()
    for (const c of calls) c.reject(new LostError(true, err))
    this.resolveClosed(err)
  }
}

/**
 * @internal Opens a transport, runs the handshake and Hello, and returns
 * the link. `at` is the endpoint when discovery supplied it (default: the
 * options').
 */
export async function dial(o: ResolvedOptions, credential: string, signal: AbortSignal, at: Endpoint = o): Promise<Link> {
  const t: Transport = o.transport
    ? await o.transport(signal)
    : at.webSocketUrl
      ? await connectWebSocket(at.webSocketUrl, o.webSocket, signal)
      : await connectTCP(o.host, o.port, signal)
  const onAbort = (): void => t.close()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw signal.reason
    const ch = await openChannel(t, at.security)
    return await new Promise<Link>((resolve, reject) => {
      ch.onClose = (err) => reject(err ?? new ConnectionError('azora: connection closed before the session started'))
      ch.onMessage = (raw) => {
        const m = decode(raw)
        switch (m.type) {
          case MsgType.Welcome:
            // The link takes over the channel now: nothing sent after Welcome is missed.
            return resolve(new Link(ch, m))
          case MsgType.Error:
            return reject(new AzoraError(m.code, m.message, { fatal: m.fatal, retryAfterMs: m.retryAfterMs }))
          case MsgType.Ping:
          case MsgType.Pong:
            return
          default:
            return reject(new ConnectionError(`azora: unexpected message type ${m.type} before welcome`))
        }
      }
      try {
        ch.send(encode({ type: MsgType.Hello, version: PROTOCOL_VERSION, database: o.database, credential, client: o.clientName }))
      } catch (e) {
        reject(e as Error)
      }
    }).catch((e: unknown) => {
      ch.close()
      throw e
    })
  } catch (e) {
    if (signal.aborted) throw signal.reason
    throw e
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
