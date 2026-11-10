/**
 * The Noise handshakes AZP uses: `Noise_IK_25519_ChaChaPoly_BLAKE2s` (the
 * client pins the server's key) and `Noise_XX_25519_ChaChaPoly_BLAKE2s`
 * (first contact), per the Noise Protocol Framework revision 34. Both
 * roles are implemented so tests can play the server.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { blake2s } from '@noble/hashes/blake2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { open, seal } from '#aead'

const DHLEN = 32
const TAG = 16
const EMPTY = new Uint8Array(0)

export type Pattern = 'IK' | 'XX'
type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss'

const PATTERNS: Record<Pattern, { responderPre: boolean; messages: Token[][] }> = {
  IK: { responderPre: true, messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  XX: { responderPre: false, messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
}

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** A new X25519 key pair. */
export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen()
  return { secretKey, publicKey }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(blake2s, ck, ikm)
  const out1 = hmac(blake2s, temp, Uint8Array.of(1))
  const out2 = hmac(blake2s, temp, concat(out1, Uint8Array.of(2)))
  return [out1, out2]
}

/** One direction of an established channel: a key and a counter nonce. */
export class CipherState {
  private n = 0
  private readonly nonce = new Uint8Array(12)
  private readonly nonceView = new DataView(this.nonce.buffer)
  private key: Uint8Array

  constructor(key: Uint8Array) {
    this.key = key
  }

  private nextNonce(): Uint8Array {
    const n = this.n
    this.nonceView.setUint32(4, n >>> 0, true)
    this.nonceView.setUint32(8, Math.floor(n / 0x100000000), true)
    return this.nonce
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const out = seal(this.key, this.nextNonce(), ad, plaintext)
    this.n++
    return out
  }

  /** Decrypts one message; a failure leaves the nonce unchanged and throws. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const out = open(this.key, this.nextNonce(), ad, ciphertext)
    this.n++
    return out
  }

  /** Replaces the key with one derived from it (Noise `REKEY`); the nonce continues. */
  rekey(): void {
    const max = new Uint8Array(12)
    max.fill(0xff, 4)
    this.key = seal(this.key, max, EMPTY, new Uint8Array(32)).slice(0, 32)
  }
}

/** The result of a completed handshake. */
export interface HandshakeResult {
  /** Encrypts what this side sends. */
  send: CipherState
  /** Decrypts what this side receives. */
  recv: CipherState
  /** The handshake hash: equal on both ends, unique per connection. */
  hash: Uint8Array
  /** The peer's static public key. */
  remoteStatic: Uint8Array
}

export interface HandshakeOptions {
  pattern: Pattern
  initiator: boolean
  prologue: Uint8Array
  /** This side's static key pair. */
  s: KeyPair
  /** The peer's static public key, when known beforehand (IK initiator). */
  rs?: Uint8Array
}

/** A Noise handshake in progress. */
export class HandshakeState {
  private h: Uint8Array
  private ck: Uint8Array
  private k: Uint8Array | null = null
  private n = 0
  private e: KeyPair | null = null
  private re: Uint8Array | null = null
  private rs: Uint8Array | null
  private readonly s: KeyPair
  private readonly initiator: boolean
  private readonly messages: Token[][]
  private step = 0

  constructor(o: HandshakeOptions) {
    const name = new TextEncoder().encode(`Noise_${o.pattern}_25519_ChaChaPoly_BLAKE2s`)
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : blake2s(name)
    this.ck = this.h
    this.s = o.s
    this.rs = o.rs ?? null
    this.initiator = o.initiator
    const p = PATTERNS[o.pattern]
    this.messages = p.messages
    this.mixHash(o.prologue)
    if (p.responderPre) {
      const pre = o.initiator ? this.rs : o.s.publicKey
      if (!pre) throw new Error('noise: the IK pattern needs the responder static key')
      this.mixHash(pre)
    }
  }

  /** Whether every handshake message was exchanged. */
  get done(): boolean {
    return this.step >= this.messages.length
  }

  private mixHash(data: Uint8Array): void {
    this.h = blake2s(concat(this.h, data))
  }

  private mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm)
    this.ck = ck
    this.k = k
    this.n = 0
  }

  private nonce(): Uint8Array {
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setUint32(4, this.n, true)
    return nonce
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(plaintext)
      return plaintext
    }
    const c = seal(this.k, this.nonce(), this.h, plaintext)
    this.n++
    this.mixHash(c)
    return c
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const p = open(this.k, this.nonce(), this.h, ciphertext)
    this.n++
    this.mixHash(ciphertext)
    return p
  }

  private dh(token: Token): void {
    const need = <T>(v: T | null, what: string): T => {
      if (v === null) throw new Error(`noise: missing ${what} key`)
      return v
    }
    let secret: Uint8Array
    let pub: Uint8Array
    switch (token) {
      case 'ee':
        secret = need(this.e, 'ephemeral').secretKey
        pub = need(this.re, 'remote ephemeral')
        break
      case 'ss':
        secret = this.s.secretKey
        pub = need(this.rs, 'remote static')
        break
      case 'es':
        secret = this.initiator ? need(this.e, 'ephemeral').secretKey : this.s.secretKey
        pub = this.initiator ? need(this.rs, 'remote static') : need(this.re, 'remote ephemeral')
        break
      case 'se':
        secret = this.initiator ? this.s.secretKey : need(this.e, 'ephemeral').secretKey
        pub = this.initiator ? need(this.re, 'remote ephemeral') : need(this.rs, 'remote static')
        break
      default:
        throw new Error(`noise: not a DH token: ${token}`)
    }
    this.mixKey(x25519.getSharedSecret(secret, pub))
  }

  /** Builds this side's next handshake message carrying payload. */
  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    const tokens = this.messages[this.step++]
    if (!tokens) throw new Error('noise: handshake already complete')
    const parts: Uint8Array[] = []
    for (const t of tokens) {
      if (t === 'e') {
        this.e = generateKeyPair()
        parts.push(this.e.publicKey)
        this.mixHash(this.e.publicKey)
      } else if (t === 's') {
        parts.push(this.encryptAndHash(this.s.publicKey))
      } else {
        this.dh(t)
      }
    }
    parts.push(this.encryptAndHash(payload))
    let len = 0
    for (const p of parts) len += p.length
    const out = new Uint8Array(len)
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }

  /** Processes the peer's next handshake message and returns its payload. */
  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.messages[this.step++]
    if (!tokens) throw new Error('noise: handshake already complete')
    let at = 0
    const take = (n: number): Uint8Array => {
      if (message.length - at < n) throw new Error('noise: handshake message too short')
      const out = message.subarray(at, at + n)
      at += n
      return out
    }
    for (const t of tokens) {
      if (t === 'e') {
        this.re = take(DHLEN).slice()
        this.mixHash(this.re)
      } else if (t === 's') {
        this.rs = this.decryptAndHash(take(this.k ? DHLEN + TAG : DHLEN)).slice()
      } else {
        this.dh(t)
      }
    }
    return this.decryptAndHash(message.subarray(at))
  }

  /** The peer's static key, once the handshake received it. */
  get remoteStatic(): Uint8Array | null {
    return this.rs
  }

  /** Derives the transport keys of a completed handshake. */
  split(): HandshakeResult {
    if (!this.done) throw new Error('noise: handshake not complete')
    const [k1, k2] = hkdf2(this.ck, EMPTY)
    const c1 = new CipherState(k1) // initiator -> responder
    const c2 = new CipherState(k2)
    if (!this.rs) throw new Error('noise: no remote static key')
    return this.initiator
      ? { send: c1, recv: c2, hash: this.h, remoteStatic: this.rs }
      : { send: c2, recv: c1, hash: this.h, remoteStatic: this.rs }
  }
}
