/**
 * The secure channel of a connection: the client side of the AZP handshake
 * (preamble, Noise IK or XX, or plaintext for tests), then whole
 * application messages split into encrypted frames.
 */
import { blake2s } from '@noble/hashes/blake2.js'
import { AzoraError, ConnectionError, ErrorCode, HandshakeError } from './errors.ts'
import { type CipherState, generateKeyPair, HandshakeState } from './noise.ts'
import { FRAME_SIZE, FrameQueue, type Transport } from './transport.ts'

/** The channel's security mode. */
export type Mode = 'IK' | 'XX' | 'plaintext'

const MAGIC = [0x41, 0x5a, 0x50, 0x31] // "AZP1"
const VERSION = 1
const MODE_BYTE: Record<Mode, number> = { IK: 0x4b, XX: 0x58, plaintext: 0x50 }
const TAG = 16
/** The most message bytes one frame carries (a Noise message minus tag and flag). */
export const MAX_CHUNK = FRAME_SIZE - TAG - 1
const FLAG_MORE = 0
const FLAG_FINAL = 1
const EMPTY = new Uint8Array(0)

/** The default bound of application messages (16 MiB, the server's default). */
export const DEFAULT_MAX_MESSAGE = 16 << 20

/** Binds handshakes to the realtime protocol; equals the server's prologue. */
export const PROLOGUE = new TextEncoder().encode('azora-rt/1')

/** The short id of a public key: the first 4 bytes of BLAKE2s-256(key), in hex. */
export function keyId(pub: Uint8Array): string {
  const h = blake2s(pub)
  let out = ''
  for (let i = 0; i < 4; i++) out += (h[i] as number).toString(16).padStart(2, '0')
  return out
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * A human-checkable fingerprint of a public key: `azp1-` and the lowercase
 * base32 of the first 15 bytes of BLAKE2s-256(key), in groups of four.
 */
export function fingerprint(pub: Uint8Array): string {
  const h = blake2s(pub).subarray(0, 15)
  let bits = 0
  let acc = 0
  let s = ''
  for (const b of h) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      s += B32[(acc >>> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  let out = 'azp1'
  for (let i = 0; i < s.length; i += 4) out += '-' + s.slice(i, i + 4)
  return out
}

function validKeyId(kid: string, min: number): boolean {
  return kid.length >= min && kid.length <= 64 && /^[0-9a-z]*$/.test(kid)
}

/** How a channel authenticates the server. */
export interface ChannelSecurity {
  /** Pins the server's static public key (IK). */
  serverKey?: Uint8Array
  /** The id sent so the server picks the right key (default: the pinned key's id). */
  keyId?: string
  /**
   * Checks the server's static key; throws to abort. Required for XX (no
   * pinned key); an extra check with IK.
   */
  verifyServer?: (pub: Uint8Array) => void
  /** Requests an unencrypted channel (tests only; applies only without the two above). */
  allowPlaintext?: boolean
  /** Bounds application messages sent and received. */
  maxMessage?: number
  /** Rekey thresholds, lowered by tests. */
  rekeyFrames?: number
  rekeyBytes?: number
}

interface Direction {
  cs: CipherState | null
  frames: number
  bytes: number
}

/** An established channel carrying whole application messages. */
export class Channel {
  /** Receives every message, in order. */
  onMessage: (msg: Uint8Array) => void = () => {}
  /** Runs once when the channel ends, with the reason if it failed. */
  onClose: (err?: Error) => void = () => {}
  /** The server's static public key (null in plaintext). */
  serverKey: Uint8Array | null = null
  /** The id of the server key ("" in plaintext). */
  keyId = ''
  /** The Noise handshake hash, a channel binding value (null in plaintext). */
  handshakeHash: Uint8Array | null = null

  private readonly out: Direction = { cs: null, frames: 0, bytes: 0 }
  private readonly in: Direction = { cs: null, frames: 0, bytes: 0 }
  private parts: Uint8Array[] = []
  private partsLen = 0
  private dead = false
  private readonly maxMessage: number
  private readonly rekeyFrames: number
  private readonly rekeyBytes: number
  private readonly t: Transport
  /** The channel's security mode. */
  readonly mode: Mode

  constructor(t: Transport, mode: Mode, sec: ChannelSecurity) {
    this.t = t
    this.mode = mode
    this.maxMessage = sec.maxMessage && sec.maxMessage > 0 ? sec.maxMessage : DEFAULT_MAX_MESSAGE
    this.rekeyFrames = sec.rekeyFrames ?? 1 << 20
    this.rekeyBytes = sec.rekeyBytes ?? 1 << 30
  }

  /** @internal Installs the transport keys and starts receiving. */
  start(send: CipherState | null, recv: CipherState | null, early: Uint8Array[], ended: Error | null): void {
    this.out.cs = send
    this.in.cs = recv
    this.t.onFrame = (f) => this.receive(f)
    this.t.onClose = (err) => this.end(err)
    if (ended) {
      queueMicrotask(() => this.end(ended))
      return
    }
    if (early.length > 0) {
      queueMicrotask(() => {
        for (const f of early) this.receive(f)
      })
    }
  }

  private account(d: Direction, n: number): void {
    d.frames++
    d.bytes += n
    if (d.frames >= this.rekeyFrames || d.bytes >= this.rekeyBytes) {
      d.cs?.rekey()
      d.frames = 0
      d.bytes = 0
    }
  }

  /** Bytes queued in the transport and not yet on the network. */
  get bufferedAmount(): number {
    return this.t.bufferedAmount
  }

  /**
   * Sends msg as one message. A message over the limit is refused and the
   * channel stays usable; any other failure closes it.
   */
  send(msg: Uint8Array): void {
    if (this.dead) throw new ConnectionError('azora: connection is closed')
    if (msg.length > this.maxMessage) {
      throw new AzoraError(ErrorCode.ResourceExhausted, `message of ${msg.length} bytes exceeds the limit of ${this.maxMessage}`)
    }
    try {
      let at = 0
      for (;;) {
        const n = Math.min(msg.length - at, MAX_CHUNK)
        const final = at + n === msg.length
        const plain = new Uint8Array(1 + n)
        plain[0] = final ? FLAG_FINAL : FLAG_MORE
        plain.set(msg.subarray(at, at + n), 1)
        let frame: Uint8Array = plain
        if (this.out.cs) {
          frame = this.out.cs.encrypt(EMPTY, plain)
          this.account(this.out, frame.length)
        }
        this.t.send(frame)
        at += n
        if (final) return
      }
    } catch (e) {
      this.fail(e instanceof Error ? e : new ConnectionError(String(e)))
      throw e
    }
  }

  private receive(frame: Uint8Array): void {
    if (this.dead) return
    let plain = frame
    if (this.in.cs) {
      if (frame.length < TAG + 1 || frame.length > FRAME_SIZE) return this.fail(new ConnectionError('azora: frame failed authentication'))
      try {
        plain = this.in.cs.decrypt(EMPTY, frame)
      } catch {
        return this.fail(new ConnectionError('azora: frame failed authentication'))
      }
      this.account(this.in, frame.length)
    } else if (frame.length < 1 || frame.length > MAX_CHUNK + 1) {
      return this.fail(new ConnectionError(`azora: protocol violation: frame of ${frame.length} bytes`))
    }
    const flag = plain[0]
    const data = plain.subarray(1)
    if (flag !== FLAG_MORE && flag !== FLAG_FINAL) return this.fail(new ConnectionError(`azora: protocol violation: chunk flag ${flag}`))
    if (flag === FLAG_MORE && data.length === 0) return this.fail(new ConnectionError('azora: protocol violation: empty continuation chunk'))
    if (this.partsLen + data.length > this.maxMessage) {
      return this.fail(new ConnectionError(`azora: incoming message over ${this.maxMessage} bytes`))
    }
    if (flag === FLAG_FINAL && this.partsLen === 0) {
      this.deliver(data)
      return
    }
    this.parts.push(data)
    this.partsLen += data.length
    if (flag === FLAG_FINAL) {
      const msg = new Uint8Array(this.partsLen)
      let at = 0
      for (const p of this.parts) {
        msg.set(p, at)
        at += p.length
      }
      this.parts = []
      this.partsLen = 0
      this.deliver(msg)
    }
  }

  private deliver(msg: Uint8Array): void {
    try {
      this.onMessage(msg)
    } catch (e) {
      this.fail(e instanceof Error ? e : new ConnectionError(String(e)))
    }
  }

  private fail(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.t.onClose = () => {}
    this.t.close()
    this.onClose(err)
  }

  private end(err?: Error): void {
    if (this.dead) return
    this.dead = true
    if (!err && this.partsLen > 0) err = new ConnectionError('azora: connection closed inside a message')
    this.onClose(err)
  }

  /** Closes the channel and its transport; `onClose` does not run. */
  close(): void {
    if (this.dead) return
    this.dead = true
    this.t.onClose = () => {}
    this.t.close()
  }
}

function pickMode(sec: ChannelSecurity): { mode: Mode; kid: string } {
  if (sec.serverKey) {
    if (sec.serverKey.length !== 32) throw new HandshakeError('azora: the server key must be 32 bytes')
    const kid = sec.keyId || keyId(sec.serverKey)
    if (!validKeyId(kid, 1)) throw new HandshakeError('azora: keyId must be 1-64 characters of [0-9a-z]')
    return { mode: 'IK', kid }
  }
  if (sec.verifyServer) {
    const kid = sec.keyId ?? ''
    if (!validKeyId(kid, 0)) throw new HandshakeError('azora: keyId must be 0-64 characters of [0-9a-z]')
    return { mode: 'XX', kid }
  }
  if (sec.allowPlaintext) return { mode: 'plaintext', kid: '' }
  throw new HandshakeError('azora: set a server key (pinned key) or a fingerprint; plaintext is for tests only')
}

function checkStatus(reply: Uint8Array, mode: Mode): Uint8Array {
  if (reply.length === 0) throw new HandshakeError('azora: handshake failed: empty reply')
  switch (reply[0]) {
    case 0:
      return reply.subarray(1)
    case 1:
      if (mode === 'plaintext') throw new HandshakeError('azora: plaintext refused by the server')
      break
    case 2:
      if (mode !== 'plaintext') throw new HandshakeError('azora: unknown server key: the server does not have the requested key')
      break
    case 3:
      throw new HandshakeError(`azora: handshake failed: the server does not support protocol version ${VERSION}`)
  }
  throw new HandshakeError(`azora: handshake failed: rejected by the server (status ${reply[0]})`)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number)
  return d === 0
}

/**
 * Runs the client side of the handshake over t and returns the channel. On
 * failure t is closed and a {@link HandshakeError} (or the transport's
 * error) is thrown.
 */
export async function openChannel(t: Transport, sec: ChannelSecurity): Promise<Channel> {
  const q = new FrameQueue(t)
  try {
    const { mode, kid } = pickMode(sec)
    const kidBytes = new TextEncoder().encode(kid)
    const preamble = Uint8Array.of(...MAGIC, VERSION, MODE_BYTE[mode], kidBytes.length, ...kidBytes)
    const ch = new Channel(t, mode, sec)

    if (mode === 'plaintext') {
      t.send(preamble)
      const rest = checkStatus(await q.read(), mode)
      if (rest.length !== 0) throw new HandshakeError('azora: handshake failed: unexpected plaintext reply')
      ch.start(null, null, q.drain(), q.error)
      return ch
    }

    const prologue = new Uint8Array(preamble.length + PROLOGUE.length)
    prologue.set(preamble)
    prologue.set(PROLOGUE, preamble.length)
    const hs = new HandshakeState({
      pattern: mode,
      initiator: true,
      prologue,
      s: generateKeyPair(), // fresh per connection: clients are identified by their credential
      ...(mode === 'IK' && sec.serverKey ? { rs: sec.serverKey } : {}),
    })
    const first = hs.writeMessage()
    const frame = new Uint8Array(preamble.length + first.length)
    frame.set(preamble)
    frame.set(first, preamble.length)
    t.send(frame)

    const reply = checkStatus(await q.read(), mode)
    let payload: Uint8Array
    try {
      payload = hs.readMessage(reply)
    } catch {
      throw new HandshakeError('azora: handshake failed: the server could not prove it holds the expected key')
    }
    if (payload.length !== 0) throw new HandshakeError('azora: handshake failed: unexpected payload')
    const remote = hs.remoteStatic
    if (!remote || remote.length !== 32) throw new HandshakeError('azora: handshake failed: no server static key')
    if (mode === 'IK') {
      if (!sec.serverKey || !sameBytes(remote, sec.serverKey)) throw new HandshakeError('azora: handshake failed: server key mismatch')
    } else if (kid !== '' && keyId(remote) !== kid) {
      throw new HandshakeError('azora: handshake failed: the server sent a key with another id than requested')
    }
    if (sec.verifyServer) {
      try {
        sec.verifyServer(remote)
      } catch (e) {
        throw new HandshakeError(`azora: handshake failed: server key rejected: ${(e as Error).message}`)
      }
    }
    if (mode === 'XX') t.send(hs.writeMessage())
    const res = hs.split()
    ch.serverKey = remote
    ch.keyId = keyId(remote)
    ch.handshakeHash = res.hash
    ch.start(res.send, res.recv, q.drain(), q.error)
    return ch
  } catch (e) {
    t.onClose = () => {}
    t.close()
    throw e
  }
}
