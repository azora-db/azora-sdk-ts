/**
 * ChaCha20-Poly1305 for browsers and other runtimes without node:crypto.
 * The Node build of this module (aead.node.ts) uses the native cipher.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

/** Encrypts plaintext; the result is the ciphertext followed by the 16-byte tag. */
export function seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, ad).encrypt(plaintext)
}

/** Decrypts ciphertext || tag; throws when authentication fails. */
export function open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, ad).decrypt(ciphertext)
}
