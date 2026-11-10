/** The TCP transport: each frame is a 4-byte big-endian length, then the payload. */
import { connect as netConnect, type Socket } from 'node:net'
import { ConnectionError } from '../errors.ts'
import { FRAME_SIZE, type Transport } from '../transport.ts'

/** Whether this runtime can open TCP connections. */
export const tcpSupported = true

/** Opens a TCP transport to host:port; resolves once connected. */
export function connectTCP(host: string, port: number, signal: AbortSignal): Promise<Transport> {
  return new Promise<Transport>((resolve, reject) => {
    const sock: Socket = netConnect({ host, port, noDelay: true, keepAlive: true, keepAliveInitialDelay: 30_000 })
    let opened = false
    let closed = false
    // Bytes of a frame that spans several chunks.
    let pending: Uint8Array[] = []
    let pendingLen = 0
    const t: Transport = {
      send(frame) {
        if (closed || sock.destroyed) throw new ConnectionError('azora: connection is closed')
        if (frame.length > FRAME_SIZE) throw new ConnectionError(`azora: frame of ${frame.length} bytes is too large`)
        const out = Buffer.allocUnsafe(4 + frame.length)
        out.writeUInt32BE(frame.length, 0)
        out.set(frame, 4)
        sock.write(out)
      },
      close() {
        sock.destroy()
        finish()
      },
      onFrame: () => {},
      onClose: () => {},
      get bufferedAmount() {
        return sock.writableLength
      },
    }
    const finish = (err?: Error): void => {
      if (closed) return
      closed = true
      signal.removeEventListener('abort', onAbort)
      if (!opened) {
        reject(err ?? new ConnectionError('azora: connection closed before it opened'))
        return
      }
      t.onClose(err)
    }
    const onAbort = (): void => {
      sock.destroy()
      finish(new ConnectionError('azora: connection attempt aborted'))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)

    const take = (chunk: Uint8Array): Uint8Array => {
      if (pendingLen === 0) return chunk
      pending.push(chunk)
      const all = new Uint8Array(pendingLen + chunk.length)
      let at = 0
      for (const p of pending) {
        all.set(p, at)
        at += p.length
      }
      pending = []
      pendingLen = 0
      return all
    }
    sock.on('connect', () => {
      opened = true
      resolve(t)
    })
    sock.on('data', (chunk: Buffer) => {
      // A plain view, so slices of it copy (Buffer#slice would alias).
      let buf = take(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      let at = 0
      while (buf.length - at >= 4) {
        const size = ((buf[at] as number) << 24 | (buf[at + 1] as number) << 16 | (buf[at + 2] as number) << 8 | (buf[at + 3] as number)) >>> 0
        if (size > FRAME_SIZE) {
          sock.destroy()
          finish(new ConnectionError(`azora: frame of ${size} bytes is too large`))
          return
        }
        if (buf.length - at - 4 < size) break
        t.onFrame(buf.subarray(at + 4, at + 4 + size))
        if (closed) return
        at += 4 + size
      }
      if (at < buf.length) {
        buf = buf.subarray(at)
        pending = [buf]
        pendingLen = buf.length
      }
    })
    sock.on('error', (e: Error) => finish(new ConnectionError(`azora: ${e.message}`)))
    sock.on('close', () => finish(pendingLen > 0 ? new ConnectionError('azora: connection closed inside a frame') : undefined))
  })
}
