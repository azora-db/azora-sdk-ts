import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { fingerprint, keyId } from '../../src/channel.ts'
import { CodecError, Reader, toValue, Writer } from '../../src/codec.ts'
import { encodeServerKey } from '../../src/config.ts'
import { decode, encode, Kind, MsgType, Op, type Msg, type WireFilter } from '../../src/messages.ts'
import { rowHash } from '../../src/replica.ts'

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))

// Written by the Go implementation (internal/azp sampleMsgs): type and hex per line.
const fixture = readFileSync(new URL('../fixtures/messages.txt', import.meta.url), 'utf8').trim().split('\n')
const golden = fixture.filter((l) => /^\d+ /.test(l)).map((l) => l.split(' ') as [string, string])
const named = Object.fromEntries(fixture.filter((l) => !/^\d+ /.test(l)).map((l) => l.split(' ') as [string, string]))

const MAX = 9223372036854775807n
const vals = [null, -5, MAX, 2.5, -Infinity, 'héllo', new Uint8Array(0), Uint8Array.of(0, 255), true]
const leaf = (op: string, col: string, val: WireFilter['val'] = null, vals: WireFilter['vals'] = null, args: WireFilter[] = []): WireFilter => ({ op, col, val, vals, args })

/** The same messages as Go's sampleMsgs, in the same order. */
const samples: Msg[] = [
  { type: MsgType.Hello, version: 1, database: 'orders', credential: 'azt1.x.y', client: 'azora-go/1' },
  { type: MsgType.Welcome, sessionId: 's1', serverTimeMs: 1700000000000, heartbeatMs: 15000, maxMessage: 16 << 20, principal: 'user:42', scopes: ['read', 'write'], maxSubscriptions: 100 },
  { type: MsgType.Error, reqId: 7, code: 'gone', message: 'resync', fatal: true, retryAfterMs: 250 },
  { type: MsgType.Ping, nonce: 99 },
  { type: MsgType.Pong, nonce: 99 },
  { type: MsgType.OK, reqId: 3 },
  { type: MsgType.Auth, reqId: 2, credential: 'new' },
  {
    type: MsgType.Subscribe, reqId: 1, subId: 5, kind: Kind.Table, table: 't', key: [1, 'k'],
    where: leaf('and', '', null, null, [leaf('=', 'a', 1), leaf('in', 'b', null, ['x', Uint8Array.of(1)]), leaf('not', '', null, null, [leaf('is_null', 'c')])]),
    ops: 3, since: 2 ** 40, epoch: -9n, noSnapshot: true, bucket: 'b', pathPrefix: 'p/', tables: ['a', 'b'],
  },
  { type: MsgType.Subscribe, reqId: 2, subId: 6, kind: Kind.Notify, table: '', key: null, where: null, ops: 0, since: 0, epoch: 0n, noSnapshot: false, bucket: '', pathPrefix: '', tables: [] },
  { type: MsgType.Subscribed, reqId: 1, subId: 5 },
  { type: MsgType.Unsubscribe, reqId: 4, subId: 5 },
  { type: MsgType.Shape, table: 't', tv: 3, columns: ['id', 'v'], pk: ['id'] },
  {
    type: MsgType.Batch, subId: 5, snapshot: true, reset: true, checkpoint: 42, epoch: 7n, tables: ['x'],
    changes: [
      { seq: 41, table: 't', tv: 3, op: Op.Update, key: [1], new: vals, old: [] },
      { seq: 42, table: 't', tv: 3, op: Op.Insert, key: [2], new: [2, 'v'], old: null },
    ],
  },
  { type: MsgType.Batch, subId: 1, snapshot: false, reset: false, checkpoint: 9, epoch: 0n, tables: [], changes: [] },
  { type: MsgType.SubEnd, subId: 5, code: 'gone', message: 'schema changed' },
  { type: MsgType.Ack, subId: 5, checkpoint: 42 },
  { type: MsgType.Query, reqId: 8, sql: 'SELECT ?', args: vals, maxRows: 1000 },
  { type: MsgType.Exec, reqId: 9, mutationId: 'm-1', sql: 'INSERT INTO t VALUES (?)', args: [1] },
  { type: MsgType.Tx, reqId: 10, mutationId: 'm-2', statements: [{ sql: 'A', args: [1] }, { sql: 'B', args: null }] },
  { type: MsgType.Result, reqId: 8, columns: ['a'], rows: [[1], []], truncated: true, rowsAffected: 3, lastInsertId: -1, replayed: true },
  { type: MsgType.Verify, reqId: 11, subId: 5 },
  { type: MsgType.Verified, reqId: 11, subId: 5, epoch: 7n, checkpoint: 42, rows: 10, sum: 2n ** 64n - 1n },
  { type: MsgType.Sign, reqId: 12, objectId: 'o1', ttlSeconds: 60 },
  { type: MsgType.Signed, reqId: 12, url: 'https://x/o/db/o1?sig=1', expiresAtMs: 1 },
  { type: MsgType.GoAway, reason: 'shutdown', retryAfterMs: 1000 },
  { type: MsgType.Call, reqId: 13, unit: 'checkout', args: '{"cartId":"c1"}', mutationId: 'm-3' },
  { type: MsgType.Call, reqId: 14, unit: 'ping', args: '', mutationId: '' },
  { type: MsgType.Returned, reqId: 13, ok: true, value: '{"orderId":7}', replayed: true, errCode: '', errMessage: '', errData: '' },
  { type: MsgType.Returned, reqId: 14, ok: false, value: '', replayed: false, errCode: 'not_found', errMessage: 'no such cart', errData: '{"cart":"c1"}' },
  { type: MsgType.UnitAdmin, reqId: 15, op: 'deploy', body: '{"bundle":"x"}' },
  { type: MsgType.UnitAdminResult, reqId: 15, body: '{"version":1}' },
]

describe('messages', () => {
  test('encode byte for byte like the Go implementation', () => {
    expect(samples.length).toBe(golden.length)
    samples.forEach((m, i) => {
      const [type, want] = golden[i] as [string, string]
      expect(m.type, `sample ${i}`).toBe(Number(type))
      expect(hex(encode(m)), `sample ${i} (type ${type})`).toBe(want)
    })
    expect(new Set(samples.map((m) => m.type)).size).toBe(27) // every message type
  })

  test('decode what Go encoded, and round-trip', () => {
    golden.forEach(([, bytes], i) => {
      const m = decode(unhex(bytes))
      expect(hex(encode(m)), `sample ${i}`).toBe(bytes)
    })
    const b = decode(unhex((golden[12] as [string, string])[1]))
    expect(b).toMatchObject({ type: MsgType.Batch, checkpoint: 42, epoch: 7n })
    if (b.type !== MsgType.Batch) throw new Error('not a batch')
    expect(b.changes[0]?.new).toEqual([null, -5, MAX, 2.5, -Infinity, 'héllo', new Uint8Array(0), Uint8Array.of(0, 255), true])
    expect(b.changes[0]?.old).toEqual([]) // empty, not absent
    expect(b.changes[1]?.old).toBeNull()
  })

  test('every strict prefix and any trailing byte is refused', () => {
    for (const [, bytes] of golden) {
      const b = unhex(bytes)
      for (let n = 0; n < b.length; n++) expect(() => decode(b.subarray(0, n)), `${bytes} cut to ${n}`).toThrow(CodecError)
      expect(() => decode(Uint8Array.of(...b, 0))).toThrow(/trailing/)
    }
  })

  test('malformed input is refused without allocating what it claims', () => {
    expect(() => decode(new Uint8Array(0))).toThrow(/empty/)
    expect(() => decode(Uint8Array.of(0))).toThrow(/unknown type 0/)
    expect(() => decode(Uint8Array.of(255))).toThrow(/unknown type 255/)
    // A Result claiming 2^40 rows in a few bytes.
    expect(() => decode(Uint8Array.of(MsgType.Result, 1, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20))).toThrow(/list of/)
    expect(() => decode(Uint8Array.of(MsgType.Error, 1, 1, 99, 1, 109, 2, 0))).toThrow(/bad flag 2/)
    expect(() => decode(Uint8Array.of(MsgType.OK, 0x80, 0x80, 0x80, 0x80, 0x10))).toThrow(/out of range/)
    expect(() => decode(Uint8Array.of(MsgType.Ping, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02))).toThrow(/overflows/)
    let deep = leaf('=', 'a', 1)
    for (let i = 0; i < 40; i++) deep = leaf('not', '', null, null, [deep])
    const sub = samples[8] as Extract<Msg, { type: typeof MsgType.Subscribe }>
    expect(() => decode(encode({ ...sub, where: deep }))).toThrow(/filter too large/)
    const wide = leaf('and', '', null, null, Array.from({ length: 256 }, (_, i) => leaf('=', 'a', i)))
    expect(() => decode(encode({ ...sub, where: wide }))).toThrow(/filter too large/)
  })
})

describe('values', () => {
  const roundTrip = (v: unknown): unknown => {
    const w = new Writer()
    w.val(toValue(v))
    const r = new Reader(w.finish())
    const out = r.val()
    expect(r.remaining).toBe(0)
    return out
  }

  test('integers keep their exact value', () => {
    const ints: Array<number | bigint> = [
      0, 1, -1, 63, 64, -64, -65, 127, 128, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 51, -(2 ** 51), 2 ** 52 + 1, -(2 ** 52) - 1,
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2n ** 53n, -(2n ** 53n), 2n ** 62n, MAX, -(2n ** 63n),
    ]
    for (const i of ints) expect(roundTrip(i), String(i)).toBe(i)
    expect(roundTrip(5n)).toBe(5) // a small bigint comes back as a number
    expect(roundTrip(2 ** 60)).toBe(2 ** 60) // beyond 2^53 a number travels as a float
    expect(() => toValue(2n ** 63n)).toThrow(/64 bits/)
  })

  test('varints match Go for every size', () => {
    const w = new Writer()
    w.u(300)
    w.i(-3)
    w.u(2 ** 40)
    w.u(2n ** 64n - 1n)
    w.i(-(2n ** 63n))
    expect(hex(w.bytes())).toBe('ac0205808080808020ffffffffffffffffff01ffffffffffffffffff01')
    const r = new Reader(w.finish())
    expect([r.u(), r.i(), r.u(), r.uBig(), r.iBig()]).toEqual([300, -3, 2 ** 40, 2n ** 64n - 1n, -(2n ** 63n)])
  })

  test('floats, text, blobs, booleans, dates and nulls', () => {
    for (const f of [0.5, -1.25, 1e300, Number.EPSILON, Infinity, -Infinity]) expect(roundTrip(f)).toBe(f)
    expect(roundTrip(NaN)).toBeNaN()
    for (const s of ['', 'a', 'x'.repeat(42), 'x'.repeat(43), 'é'.repeat(42), '日本語 🌍 \u0000 end', 'y'.repeat(100_000)]) expect(roundTrip(s)).toBe(s)
    expect(roundTrip(Uint8Array.of(1, 2, 3))).toEqual(Uint8Array.of(1, 2, 3))
    expect(roundTrip(new Uint8Array(0))).toEqual(new Uint8Array(0))
    expect(roundTrip(new Uint16Array([1, 2]).buffer)).toEqual(Uint8Array.of(1, 0, 2, 0))
    expect(roundTrip(true)).toBe(true)
    expect(roundTrip(false)).toBe(false)
    expect(roundTrip(null)).toBeNull()
    expect(roundTrip(undefined)).toBeNull()
    expect(roundTrip(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('2026-01-02T03:04:05.000Z')
    for (const bad of [{}, [], () => 1, Symbol('x'), new Date(NaN)]) expect(() => toValue(bad)).toThrow(CodecError)
  })

  test('integral floats are remembered so checksums hash the stored type', () => {
    const w = new Writer()
    w.vals([1, 2.5, 3, 'x'], [2]) // position 2 is the float 3.0
    const r = new Reader(w.finish())
    expect(r.vals()).toEqual([1, 2.5, 3, 'x'])
    expect(r.lastFloats).toEqual([2])
    expect(r.vals).toBeDefined()
  })
})

describe('row hashes and keys', () => {
  test('the protocol test vectors', () => {
    expect(rowHash('orders', [7], [7, 'paid', 12.5])).toBe(0xa171adb8fb865d6dn)
    const row = [1, 'a', null, 2.5, Uint8Array.of(1)]
    expect(rowHash('T', [1], row)).toBe(rowHash('t', [1], row)) // table names are case-insensitive
    expect(rowHash('t', [1], ['a'])).not.toBe(rowHash('t', [1, 'a'], [])) // the key/row boundary is hashed
    expect(rowHash('t', [1], [3], undefined, [0])).not.toBe(rowHash('t', [1], [3])) // 3.0 is not 3
  })

  test('key ids and fingerprints match the Go implementation', () => {
    const pub = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff)
    expect(keyId(pub)).toBe(named['kid'])
    expect(fingerprint(pub)).toBe(named['fp'])
    expect(encodeServerKey(pub)).toBe(named['pub'])
  })
})
