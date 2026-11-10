/** Compares the native and the JavaScript ChaCha20-Poly1305 by message size: `node bench/aead.ts`. */
import * as native from '../src/platform/aead.node.ts'
import * as js from '../src/platform/aead.web.ts'

const key = new Uint8Array(32).fill(7)
const nonce = new Uint8Array(12).fill(1)
const ad = new Uint8Array(0)
for (const size of [32, 128, 512, 2048, 8192, 65000]) {
  const pt = new Uint8Array(size).fill(3)
  const line: string[] = [`${String(size).padStart(6)} bytes`]
  for (const [name, impl] of [['native', native], ['js', js]] as const) {
    const ct = impl.seal(key, nonce, ad, pt)
    const n = size > 8000 ? 2000 : 50_000
    for (let i = 0; i < 2000; i++) impl.open(key, nonce, ad, impl.seal(key, nonce, ad, pt)) // warm up
    const t = performance.now()
    for (let i = 0; i < n; i++) {
      impl.seal(key, nonce, ad, pt)
      impl.open(key, nonce, ad, ct)
    }
    line.push(`${name} ${(((performance.now() - t) / n) * 1000).toFixed(1).padStart(7)} µs/seal+open`)
  }
  console.log(line.join('   '))
}
