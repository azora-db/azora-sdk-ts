/**
 * An in-memory AZP server for fault injection: tests script its answers
 * and break its connections at will. It speaks the plaintext mode, so the
 * client under test runs everything above the handshake unchanged.
 */
import { ConnectionError } from '../../src/errors.ts'
import { decode, encode, MsgType, type Msg } from '../../src/messages.ts'
import type { Transport } from '../../src/transport.ts'

/** One accepted connection, seen from the server. */
export class FakeConn {
  /** Messages the client sent, in order (Hello included). */
  readonly received: Msg[] = []
  open = true
  /** Called for every message after Hello. */
  onMessage: (m: Msg, conn: FakeConn) => void = () => {}

  private readonly toClient: Transport
  private helloSeen = false
  private handshaken = false

  private readonly server: FakeServer

  constructor(toClient: Transport, server: FakeServer) {
    this.toClient = toClient
    this.server = server
  }

  /** @internal A frame from the client. */
  frame(f: Uint8Array): void {
    if (!this.handshaken) {
      this.handshaken = true
      queueMicrotask(() => this.raw(Uint8Array.of(0))) // status OK, plaintext
      return
    }
    const m = decode(f.subarray(1))
    this.received.push(m)
    if (!this.helloSeen) {
      this.helloSeen = true
      if (m.type !== MsgType.Hello) throw new Error('expected Hello first')
      const refuse = this.server.refuseHello?.(m.credential)
      if (refuse) {
        this.send({ type: MsgType.Error, reqId: 0, code: refuse, message: 'unknown database or invalid credential', fatal: true, retryAfterMs: 0 })
        queueMicrotask(() => this.drop())
        return
      }
      this.send({
        type: MsgType.Welcome, sessionId: `s${this.server.accepted}`, serverTimeMs: Date.now(), heartbeatMs: this.server.heartbeatMs,
        maxMessage: 16 << 20, principal: 'test', scopes: ['read', 'write'], maxSubscriptions: 100,
      })
      return
    }
    ;(this.onMessage === noop ? this.server.onMessage : this.onMessage)(m, this)
  }

  private raw(frame: Uint8Array): void {
    if (this.open) queueMicrotask(() => this.open && this.toClient.onFrame(frame))
  }

  /** Sends a message to the client. */
  send(m: Msg): void {
    const b = encode(m)
    const f = new Uint8Array(b.length + 1)
    f[0] = 1
    f.set(b, 1)
    this.raw(f)
  }

  /** Breaks the connection, as a network failure would. */
  drop(err: Error = new ConnectionError('fake: connection reset')): void {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => this.toClient.onClose(err))
  }

  /** @internal The client closed its side. */
  clientClosed(): void {
    this.open = false
  }
}

const noop = (): void => {}

export class FakeServer {
  readonly conns: FakeConn[] = []
  accepted = 0
  heartbeatMs = 15_000
  /** While true, connection attempts fail. */
  down = false
  /** Returns an error code to refuse a Hello carrying this credential. */
  refuseHello: ((credential: string) => string | undefined) | undefined
  /** Handles messages of connections without their own handler. */
  onMessage: (m: Msg, conn: FakeConn) => void = () => {}

  /** The `transport` connect option. */
  transport = (signal: AbortSignal): Promise<Transport> => {
    if (this.down) return Promise.reject(new ConnectionError('fake: connection refused'))
    if (signal.aborted) return Promise.reject(signal.reason as Error)
    this.accepted++
    let conn: FakeConn
    const t: Transport = {
      send: (frame) => {
        if (!conn.open) throw new ConnectionError('fake: closed')
        const copy = frame.slice()
        queueMicrotask(() => conn.open && conn.frame(copy))
      },
      close: () => conn.clientClosed(),
      onFrame: () => {},
      onClose: () => {},
      bufferedAmount: 0,
    }
    conn = new FakeConn(t, this)
    conn.onMessage = noop
    this.conns.push(conn)
    return Promise.resolve(t)
  }

  /** The newest connection. */
  get last(): FakeConn {
    const c = this.conns.at(-1)
    if (!c) throw new Error('no connection yet')
    return c
  }
}
