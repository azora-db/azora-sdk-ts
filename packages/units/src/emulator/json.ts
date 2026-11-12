/**
 * JSON as it crosses the engine's boundaries (docs/units.md, Protocol):
 * blobs as `{"$bytes": base64}` both ways. Two encoders, because the two
 * sides differ: the engine's (its prelude: bigints beyond 2^53 become
 * strings) for what units return, store and log, and the client's
 * (`encodeUnitJSON`: bigints become numbers) for what a test sends.
 */

function b64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')
}

/** The bytes of an ArrayBuffer or a view, or null. */
export function bytesOf(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return null
}

/** The engine's JSON.stringify: undefined (and functions) are "null". */
export function engineStringify(v: unknown): string {
  const s = JSON.stringify(v, function (this: unknown, key: string, value: unknown) {
    // The holder's own value: a Buffer has already gone through its toJSON.
    const raw = (this as Record<string, unknown>)[key]
    const b = bytesOf(raw)
    if (b) return { $bytes: b64(b) }
    if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    return value
  })
  return s === undefined ? 'null' : s
}

/** What a client sends (`encodeUnitJSON` of @azora-db/client): "" for undefined. */
export function clientStringify(v: unknown): string {
  if (v === undefined) return ''
  const s = JSON.stringify(v, function (this: unknown, key: string, value: unknown) {
    const b = bytesOf((this as Record<string, unknown>)[key])
    if (b) return { $bytes: b64(b) }
    if (typeof value === 'bigint') return Number(value)
    return value
  })
  if (s === undefined) throw new TypeError(`azora: a ${typeof v} cannot be sent to a unit`)
  return s
}

function revive(_k: string, x: unknown): unknown {
  if (x !== null && typeof x === 'object' && !Array.isArray(x)) {
    const o = x as Record<string, unknown>
    if (typeof o['$bytes'] === 'string' && Object.keys(o).length === 1) return new Uint8Array(Buffer.from(o['$bytes'], 'base64'))
  }
  return x
}

/** Parses JSON text, `{"$bytes"}` objects as Uint8Array; "" is undefined. */
export function parseJSON(s: string): unknown {
  if (s === '') return undefined
  return JSON.parse(s, revive)
}
