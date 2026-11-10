/**
 * An in-memory AZP server that holds a real key: it answers the Noise IK
 * handshake of a client that pinned its current key and refuses any other
 * key, as the engine does. Tests use it for discovery and key rotation.
 */
import { Channel, fingerprint, keyId } from '../../src/channel.ts'
import { encodeServerKey } from '../../src/config.ts'
import { ConnectionError } from '../../src/errors.ts'
import { decode, encode, MsgType } from '../../src/messages.ts'
import { generateKeyPair, HandshakeState, type KeyPair } from '../../src/noise.ts'
import type { Transport } from '../../src/transport.ts'

export class KeyedServer {
  /** Handshakes completed and refused (unknown key). */
  accepted = 0
  refused = 0

  private keys: KeyPair = generateKeyPair()
  private readonly open = new Set<() => void>()

  /** The current public key, as a URL or a discovery document spells it. */
  get serverKey(): string {
    return encodeServerKey(this.keys.publicKey)
  }

  /** What the server publishes at /.well-known/azora.json. */
  document(websocket = '/rt/v1'): Record<string, unknown> {
    return { azora: 1, server_key: this.serverKey, fingerprint: fingerprint(this.keys.publicKey), websocket }
  }

  /** Replaces the key: clients that pinned the old one are refused from now on. */
  rotate(): void {
    this.keys = generateKeyPair()
  }

  /** Breaks every connection, as a restart would. */
  dropAll(): void {
    for (const drop of [...this.open]) drop()
  }

  /** The `transport` connect option. */
  transport = (signal: AbortSignal): Promise<Transport> => {
    if (signal.aborted) return Promise.reject(signal.reason as Error)
    let up = true
    // The two ends of the wire: what one sends, the other receives.
    const client: Transport = { send: (f) => deliver(server, f), close: () => end(), onFrame: () => {}, onClose: () => {}, bufferedAmount: 0 }
    const server: Transport = { send: (f) => deliver(client, f), close: () => end(), onFrame: (f) => handshake(f), onClose: () => {}, bufferedAmount: 0 }
    const deliver = (to: Transport, f: Uint8Array): void => {
      if (!up) throw new ConnectionError('fake: closed')
      const copy = f.slice()
      queueMicrotask(() => up && to.onFrame(copy))
    }
    const end = (err?: Error): void => {
      if (!up) return
      up = false
      this.open.delete(drop)
      if (err) queueMicrotask(() => client.onClose(err))
    }
    const drop = (): void => end(new ConnectionError('fake: connection reset'))
    this.open.add(drop)

    const handshake = (first: Uint8Array): void => {
      const kidLen = first[6] as number
      const preamble = first.subarray(0, 7 + kidLen)
      const kid = new TextDecoder().decode(preamble.subarray(7))
      if (first[5] !== 0x4b || kid !== keyId(this.keys.publicKey)) {
        this.refused++
        server.send(Uint8Array.of(2)) // unknown server key
        queueMicrotask(() => queueMicrotask(drop))
        return
      }
      const hs = new HandshakeState({
        pattern: 'IK', initiator: false, prologue: Uint8Array.of(...preamble, ...new TextEncoder().encode('azora-rt/1')), s: this.keys,
      })
      hs.readMessage(first.subarray(preamble.length))
      server.send(Uint8Array.of(0, ...hs.writeMessage()))
      const keys = hs.split()
      const ch = new Channel(server, 'IK', {})
      ch.onMessage = (raw) => {
        const m = decode(raw)
        if (m.type === MsgType.Hello) {
          this.accepted++
          ch.send(encode({
            type: MsgType.Welcome, sessionId: `s${this.accepted}`, serverTimeMs: Date.now(), heartbeatMs: 15_000, maxMessage: 16 << 20,
            principal: m.credential, scopes: ['read'], maxSubscriptions: 100,
          }))
        } else if (m.type === MsgType.Query) {
          ch.send(encode({
            type: MsgType.Result, reqId: m.reqId, columns: ['v'], rows: [[m.sql]], truncated: false, rowsAffected: 0, lastInsertId: 0, replayed: false,
          }))
        }
      }
      ch.start(keys.send, keys.recv, [], null)
    }
    return Promise.resolve(client)
  }
}
