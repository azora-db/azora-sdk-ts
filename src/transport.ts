/**
 * Transports move whole frames: binary WebSocket messages (browsers and
 * every other runtime) or length-prefixed frames over TCP (Node, Bun, Deno).
 */
import { ConnectionError } from './errors.ts'

/** The largest frame: one Noise message. */
export const FRAME_SIZE = 65535

/** The WebSocket subprotocol of the realtime endpoint. */
export const SUBPROTOCOL = 'azp.v1'

/** A connected, frame-oriented, ordered and reliable byte channel. */
export interface Transport {
  /** Writes one frame. */
  send(frame: Uint8Array): void
  /** Closes the connection; `onClose` then runs once. */
  close(): void
  /** Receives every frame, in order. Set before the first frame can arrive. */
  onFrame: (frame: Uint8Array) => void
  /** Runs once when the connection ends, with the reason if it failed. */
  onClose: (err?: Error) => void
  /** Bytes queued for sending and not yet handed to the network. */
  readonly bufferedAmount: number
}

/** The constructor of a WHATWG WebSocket (the global one, or the `ws` package's). */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket

/** Opens a WebSocket transport to url; resolves once the socket is open. */
export function connectWebSocket(url: string, ctor: WebSocketCtor | undefined, signal: AbortSignal): Promise<Transport> {
  const WS = ctor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (!WS) {
    return Promise.reject(new ConnectionError('azora: this runtime has no WebSocket: pass one with the webSocket option'))
  }
  return new Promise<Transport>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WS(url, SUBPROTOCOL)
    } catch (e) {
      reject(new ConnectionError(`azora: websocket: ${(e as Error).message}`))
      return
    }
    ws.binaryType = 'arraybuffer'
    let opened = false
    let closed = false
    const t: Transport = {
      send(frame) {
        if (ws.readyState !== 1) throw new ConnectionError('azora: websocket is not open')
        ws.send(frame as Uint8Array<ArrayBuffer>)
      },
      close() {
        try {
          ws.close(1000)
        } catch {
          /* already closing */
        }
        finish()
      },
      onFrame: () => {},
      onClose: () => {},
      get bufferedAmount() {
        return ws.bufferedAmount
      },
    }
    const finish = (err?: Error): void => {
      if (closed) return
      closed = true
      signal.removeEventListener('abort', onAbort)
      if (!opened) {
        reject(err ?? new ConnectionError('azora: websocket closed before it opened'))
        return
      }
      t.onClose(err)
    }
    const onAbort = (): void => {
      try {
        ws.close()
      } catch {
        /* not open yet */
      }
      finish(new ConnectionError('azora: connection attempt aborted'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)
    ws.onopen = () => {
      if (ws.protocol !== SUBPROTOCOL) {
        ws.close(1002)
        finish(new ConnectionError(`azora: websocket: the server did not accept subprotocol ${SUBPROTOCOL}`))
        return
      }
      opened = true
      resolve(t)
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) {
        ws.close(1003)
        finish(new ConnectionError('azora: websocket: text message on a binary channel'))
        return
      }
      t.onFrame(new Uint8Array(ev.data))
    }
    ws.onerror = () => {
      finish(new ConnectionError(`azora: websocket error (${url})`))
    }
    ws.onclose = (ev: CloseEvent) => {
      const clean = ev.code === 1000 || ev.code === 1001
      finish(clean ? undefined : new ConnectionError(`azora: websocket closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`))
    }
  })
}

/** A queue that turns frame events into awaitable reads (used by the handshake). */
export class FrameQueue {
  private frames: Uint8Array[] = []
  private waiter: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void } | null = null
  private ended: Error | null = null

  constructor(t: Transport) {
    t.onFrame = (f) => {
      if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w.resolve(f)
      } else {
        this.frames.push(f)
      }
    }
    t.onClose = (err) => {
      this.ended = err ?? new ConnectionError('azora: connection closed')
      if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w.reject(this.ended)
      }
    }
  }

  /** The next frame; rejects when the connection ended first. */
  read(): Promise<Uint8Array> {
    const f = this.frames.shift()
    if (f) return Promise.resolve(f)
    if (this.ended) return Promise.reject(this.ended)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  /** Frames that arrived and were not read (handed to the channel after the handshake). */
  drain(): Uint8Array[] {
    const out = this.frames
    this.frames = []
    return out
  }

  /** The reason the connection ended while the queue owned it, if it did. */
  get error(): Error | null {
    return this.ended
  }
}
