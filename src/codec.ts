/**
 * The binary encoding of AZP messages: unsigned and zigzag varints (Go's
 * `binary.AppendUvarint` / `AppendVarint`), length-prefixed strings and
 * tagged SQLite values.
 *
 * Integers are 64-bit on the wire. They are decoded as `number` while that
 * is exact (up to 2^53 - 1 in magnitude) and as `bigint` beyond. Going out,
 * a `number` is an integer when it is a safe integer and a float
 * otherwise; pass a `bigint` for integers beyond 2^53.
 */

/** A value a statement argument or a row cell can hold. */
export type Value = null | number | bigint | string | Uint8Array | boolean

/** What callers may pass where a {@link Value} is expected. */
export type InputValue = Value | undefined | Date | ArrayBuffer | ArrayBufferView

/** A message that could not be decoded (or a value that cannot be encoded). */
export class CodecError extends Error {
  override name = 'CodecError'
}

const T_NULL = 0
const T_INT = 1
const T_FLOAT = 2
const T_TEXT = 3
const T_BLOB = 4
const T_FALSE = 5
const T_TRUE = 6

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const U64_MAX = (1n << 64n) - 1n
const I64_MIN = -(1n << 63n)
const I64_MAX = (1n << 63n) - 1n
// Below this magnitude zigzag (2|x| or 2|x| - 1) stays an exact double.
const ZIGZAG_FAST = 2 ** 51

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8')

/** Normalizes an argument to a wire value; throws {@link CodecError} for anything else. */
export function toValue(v: unknown): Value {
  switch (typeof v) {
    case 'string':
    case 'boolean':
    case 'number':
      return v
    case 'bigint':
      if (v < I64_MIN || v > I64_MAX) throw new CodecError(`integer ${v} does not fit in 64 bits`)
      return v
    case 'undefined':
      return null
    case 'object':
      if (v === null) return null
      if (v instanceof Uint8Array) return v
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) throw new CodecError('invalid Date')
        return v.toISOString()
      }
      if (v instanceof ArrayBuffer) return new Uint8Array(v)
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  }
  throw new CodecError(`unsupported value type: ${describe(v)}`)
}

function describe(v: unknown): string {
  if (typeof v !== 'object' || v === null) return typeof v
  return v.constructor?.name ?? 'object'
}

/** Appends message fields to a growing buffer. */
export class Writer {
  private buf: Uint8Array
  private view: DataView
  private len = 0

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity)
    this.view = new DataView(this.buf.buffer)
  }

  /** The bytes written so far (a copy-free view; valid until the next write). */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }

  /** The bytes written so far, detached from the writer. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  byte(b: number): void {
    this.grow(1)
    this.buf[this.len++] = b
  }

  raw(b: Uint8Array): void {
    this.grow(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
  }

  /** Unsigned varint. */
  u(v: number | bigint): void {
    if (typeof v === 'bigint') return this.uBig(v)
    if (!Number.isInteger(v) || v < 0) throw new CodecError(`not an unsigned integer: ${v}`)
    this.grow(10)
    const buf = this.buf
    let n = this.len
    while (v >= 0x80000000) {
      buf[n++] = (v % 128) | 0x80
      v = Math.floor(v / 128)
    }
    while (v >= 0x80) {
      buf[n++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    buf[n++] = v
    this.len = n
  }

  private uBig(v: bigint): void {
    if (v < 0n || v > U64_MAX) throw new CodecError(`not an unsigned 64-bit integer: ${v}`)
    this.grow(10)
    while (v >= 0x80n) {
      this.buf[this.len++] = Number(v & 0x7fn) | 0x80
      v >>= 7n
    }
    this.buf[this.len++] = Number(v)
  }

  /** Signed (zigzag) varint. */
  i(v: number | bigint): void {
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new CodecError(`not an integer: ${v}`)
      if (v > -ZIGZAG_FAST && v < ZIGZAG_FAST) return this.u(v >= 0 ? v * 2 : -v * 2 - 1)
      v = BigInt(v)
    }
    if (v < I64_MIN || v > I64_MAX) throw new CodecError(`integer ${v} does not fit in 64 bits`)
    this.uBig(v >= 0n ? v << 1n : ((-v) << 1n) - 1n)
  }

  /** Length-prefixed UTF-8 string. */
  s(v: string): void {
    if (v.length <= 42) {
      // At most 126 bytes of UTF-8: the length fits one byte, written after.
      this.grow(1 + v.length * 3)
      const at = this.len
      const { written } = utf8Encoder.encodeInto(v, this.buf.subarray(at + 1))
      this.buf[at] = written
      this.len = at + 1 + written
      return
    }
    const b = utf8Encoder.encode(v)
    this.u(b.length)
    this.raw(b)
  }

  flag(v: boolean): void {
    this.byte(v ? 1 : 0)
  }

  /** One tagged value. */
  val(v: Value): void {
    switch (typeof v) {
      case 'number':
        // Whole numbers a double holds exactly are integers; anything
        // else, 1e300 included, is a float.
        if (Number.isSafeInteger(v)) {
          this.byte(T_INT)
          this.i(v)
        } else {
          this.grow(9)
          this.buf[this.len] = T_FLOAT
          this.view.setFloat64(this.len + 1, v, true)
          this.len += 9
        }
        return
      case 'string':
        this.byte(T_TEXT)
        this.s(v)
        return
      case 'bigint':
        this.byte(T_INT)
        this.i(v)
        return
      case 'boolean':
        this.byte(v ? T_TRUE : T_FALSE)
        return
      case 'object':
        if (v === null) {
          this.byte(T_NULL)
          return
        }
        if (v instanceof Uint8Array) {
          this.byte(T_BLOB)
          this.u(v.length)
          this.raw(v)
          return
        }
    }
    throw new CodecError(`unsupported value type: ${describe(v)}`)
  }

  /** A float written as a float even when it is integral (2.0). */
  float(v: number): void {
    this.grow(9)
    this.buf[this.len] = T_FLOAT
    this.view.setFloat64(this.len + 1, v, true)
    this.len += 9
  }

  /**
   * A list of values; `null` (absent) and `[]` differ on the wire. floats
   * lists the positions to write as floats although their value is
   * integral (see Reader.lastFloats).
   */
  vals(vs: readonly Value[] | null | undefined, floats?: readonly number[] | null): void {
    if (vs == null) return this.u(0)
    this.u(vs.length + 1)
    if (!floats) {
      for (let i = 0; i < vs.length; i++) this.val(vs[i] as Value)
      return
    }
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i] as Value
      if (typeof v === 'number' && floats.includes(i)) this.float(v)
      else this.val(v)
    }
  }

  strs(ss: readonly string[] | null | undefined): void {
    if (!ss) return this.u(0)
    this.u(ss.length)
    for (const s of ss) this.s(s)
  }
}

/** Reads message fields; every malformation throws {@link CodecError}. */
export class Reader {
  private pos = 0
  private readonly view: DataView
  private readonly buf: Uint8Array

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get remaining(): number {
    return this.buf.length - this.pos
  }

  private corrupt(what = 'corrupt data'): never {
    throw new CodecError(what)
  }

  /** The unsigned varint at the cursor as a number when exact, else a bigint. */
  private uAny(): number | bigint {
    const buf = this.buf
    let pos = this.pos
    const end = buf.length
    let lo = 0
    let shift = 0
    // Up to 4 bytes (28 bits) with integer bit operations.
    for (; shift < 28; shift += 7) {
      if (pos >= end) this.corrupt()
      const b = buf[pos++] as number
      lo |= (b & 0x7f) << shift
      if (b < 0x80) {
        this.pos = pos
        return lo
      }
    }
    // Bytes 5 to 7 (up to 49 bits) with exact floating-point arithmetic.
    let v = lo
    let mul = 0x10000000
    for (let i = 4; i < 7; i++) {
      if (pos >= end) this.corrupt()
      const b = buf[pos++] as number
      v += (b & 0x7f) * mul
      if (b < 0x80) {
        this.pos = pos
        return v
      }
      mul *= 128
    }
    // Bytes 8 to 10: a 64-bit value.
    let big = BigInt(v)
    let bshift = 49n
    for (let i = 7; i < 10; i++) {
      if (pos >= end) this.corrupt()
      const b = buf[pos++] as number
      if (i === 9 && b > 1) this.corrupt('varint overflows 64 bits')
      big |= BigInt(b & 0x7f) << bshift
      if (b < 0x80) {
        this.pos = pos
        return big <= BigInt(MAX_SAFE) ? Number(big) : big
      }
      bshift += 7n
    }
    this.corrupt('varint overflows 64 bits')
  }

  /** Unsigned varint that must be exact as a number (ids, counts, lengths). */
  u(): number {
    const v = this.uAny()
    if (typeof v !== 'number') this.corrupt(`value ${v} out of range`)
    return v
  }

  /** Unsigned varint as a bigint (checksums). */
  uBig(): bigint {
    return BigInt(this.uAny())
  }

  /** Unsigned varint limited to 32 bits. */
  u32(): number {
    const v = this.uAny()
    if (typeof v !== 'number' || v > 0xffffffff) this.corrupt(`value ${v} out of range`)
    return v
  }

  /** Signed varint: a number when exact, else a bigint. */
  i(): number | bigint {
    const u = this.uAny()
    if (typeof u === 'number') {
      return u % 2 === 0 ? u / 2 : -(u + 1) / 2
    }
    const x = (u & 1n) === 0n ? u >> 1n : -((u + 1n) >> 1n)
    return x >= -BigInt(MAX_SAFE) && x <= BigInt(MAX_SAFE) ? Number(x) : x
  }

  /** Signed varint as a bigint (epochs). */
  iBig(): bigint {
    return BigInt(this.i())
  }

  /** Signed varint that must be exact as a number (timestamps, counts). */
  iNum(): number {
    const v = this.i()
    if (typeof v !== 'number') this.corrupt(`value ${v} out of range`)
    return v
  }

  bytes(n: number): Uint8Array {
    if (n > this.buf.length - this.pos) this.corrupt()
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  s(): string {
    const n = this.u()
    const buf = this.buf
    const start = this.pos
    const end = start + n
    if (end > buf.length) this.corrupt()
    this.pos = end
    if (n < 32) {
      // Short ASCII strings (column names, codes, small cells) skip TextDecoder.
      let out = ''
      let i = start
      for (; i < end; i++) {
        const c = buf[i] as number
        if (c >= 0x80) break
        out += String.fromCharCode(c)
      }
      if (i === end) return out
    }
    return utf8Decoder.decode(buf.subarray(start, end))
  }

  flag(): boolean {
    if (this.pos >= this.buf.length) this.corrupt()
    const b = this.buf[this.pos++] as number
    if (b > 1) this.corrupt(`bad flag ${b}`)
    return b === 1
  }

  /** A list length; lists longer than the bytes left are refused before allocating. */
  count(): number {
    const n = this.u()
    if (n > this.remaining) this.corrupt(`list of ${n} elements in ${this.remaining} bytes`)
    return n
  }

  val(): Value {
    if (this.pos >= this.buf.length) this.corrupt()
    const tag = this.buf[this.pos++] as number
    switch (tag) {
      case T_NULL:
        return null
      case T_INT:
        return this.i()
      case T_FLOAT: {
        if (this.remaining < 8) this.corrupt()
        const v = this.view.getFloat64(this.pos, true)
        this.pos += 8
        return v
      }
      case T_TEXT:
        return this.s()
      case T_BLOB:
        // A copy: the frame buffer is reused or released after decoding.
        return this.bytes(this.u()).slice()
      case T_FALSE:
        return false
      case T_TRUE:
        return true
    }
    this.corrupt(`unknown value tag ${tag}`)
  }

  /**
   * The positions, in the list `vals` read last, of floats with an
   * integral value (null when there are none). A JavaScript number cannot
   * tell 2.0 from 2, but row checksums hash the stored type, so whoever
   * re-encodes the row needs them.
   */
  lastFloats: number[] | null = null

  /** A list of values, or `null` when the list is absent. */
  vals(): Value[] | null {
    this.lastFloats = null
    const n = this.u()
    if (n === 0) return null
    const len = n - 1
    if (len > this.remaining) this.corrupt(`list of ${len} values in ${this.remaining} bytes`)
    const out = new Array<Value>(len)
    for (let i = 0; i < len; i++) {
      const float = this.buf[this.pos] === T_FLOAT
      const v = this.val()
      out[i] = v
      if (float && Number.isInteger(v)) (this.lastFloats ??= []).push(i)
    }
    return out
  }

  strs(): string[] {
    const n = this.count()
    const out = new Array<string>(n)
    for (let i = 0; i < n; i++) out[i] = this.s()
    return out
  }
}

/** Appends values one after another, without a length prefix (row hashes, replica keys). */
export function encodeValues(w: Writer, vs: readonly Value[]): void {
  for (let i = 0; i < vs.length; i++) w.val(vs[i] as Value)
}
