/**
 * ChaCha20-Poly1305 for Node, Bun and Deno. Creating a native cipher costs
 * about 25 µs whatever the message size, so small frames (most requests
 * and answers) are faster in JavaScript, while large frames are several
 * times faster natively. Each frame goes to the faster one (see
 * bench/aead.ts for the measurements behind the threshold).
 */
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

/** Frames up to this many bytes are encrypted in JavaScript. */
const SMALL = 2048
const TAG = 16
const OPTS = { authTagLength: TAG } as const

/** Encrypts plaintext; the result is the ciphertext followed by the 16-byte tag. */
export function seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (plaintext.length <= SMALL) return chacha20poly1305(key, nonce, ad).encrypt(plaintext)
  const c = createCipheriv('chacha20-poly1305', key, nonce, OPTS)
  if (ad.length > 0) c.setAAD(ad, { plaintextLength: plaintext.length })
  const out = new Uint8Array(plaintext.length + TAG)
  const body = c.update(plaintext)
  out.set(body, 0)
  c.final()
  out.set(c.getAuthTag(), plaintext.length)
  return out
}

/** Decrypts ciphertext || tag; throws when authentication fails. */
export function open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length < TAG) throw new Error('ciphertext shorter than its tag')
  if (ciphertext.length <= SMALL + TAG) return chacha20poly1305(key, nonce, ad).decrypt(ciphertext)
  const n = ciphertext.length - TAG
  const d = createDecipheriv('chacha20-poly1305', key, nonce, OPTS)
  if (ad.length > 0) d.setAAD(ad, { plaintextLength: n })
  d.setAuthTag(ciphertext.subarray(n))
  const body = d.update(ciphertext.subarray(0, n))
  d.final() // throws on a bad tag
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
}
