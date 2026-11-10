/**
 * AZP v1 messages (docs/protocol.md of the engine): one type byte, then the
 * message's fields in order. Every message type can be both encoded and
 * decoded, so tests can play the server's part.
 */
import { CodecError, Reader, Writer, type Value } from './codec.ts'

export const PROTOCOL_VERSION = 1

export const MsgType = {
  Hello: 1,
  Welcome: 2,
  Error: 3,
  Ping: 4,
  Pong: 5,
  Auth: 6,
  Subscribe: 7,
  Subscribed: 8,
  Unsubscribe: 9,
  Batch: 10,
  SubEnd: 11,
  Ack: 12,
  Query: 13,
  Exec: 14,
  Tx: 15,
  Result: 16,
  Verify: 17,
  Verified: 18,
  Sign: 19,
  Signed: 20,
  GoAway: 21,
  Shape: 22,
  OK: 23,
  Call: 24,
  Returned: 25,
  UnitAdmin: 26,
  UnitAdminResult: 27,
} as const

/** Subscription kinds on the wire. */
export const Kind = { Database: 1, Table: 2, Row: 3, Files: 4, Notify: 5 } as const
export type KindValue = (typeof Kind)[keyof typeof Kind]

/** Change operations on the wire. */
export const Op = { Insert: 1, Update: 2, Delete: 3 } as const

const MAX_FILTER_DEPTH = 16
const MAX_FILTER_NODES = 256

/** The wire form of a subscription filter. */
export interface WireFilter {
  op: string
  col: string
  val: Value
  vals: Value[] | null
  args: WireFilter[]
}

export interface WireStatement {
  sql: string
  args: Value[] | null
}

export interface WireChange {
  seq: number
  table: string
  tv: number
  op: number
  key: Value[] | null
  new: Value[] | null
  old: Value[] | null
  /** Positions of integral floats in key and new (see Reader.lastFloats). */
  keyFloats?: number[]
  newFloats?: number[]
}

export interface Hello { type: typeof MsgType.Hello; version: number; database: string; credential: string; client: string }
export interface Welcome {
  type: typeof MsgType.Welcome
  sessionId: string
  serverTimeMs: number
  heartbeatMs: number
  maxMessage: number
  principal: string
  scopes: string[]
  maxSubscriptions: number
}
export interface ErrorMsg { type: typeof MsgType.Error; reqId: number; code: string; message: string; fatal: boolean; retryAfterMs: number }
export interface Ping { type: typeof MsgType.Ping; nonce: number }
export interface Pong { type: typeof MsgType.Pong; nonce: number }
export interface Auth { type: typeof MsgType.Auth; reqId: number; credential: string }
export interface Subscribe {
  type: typeof MsgType.Subscribe
  reqId: number
  subId: number
  kind: number
  table: string
  key: Value[] | null
  where: WireFilter | null
  ops: number
  since: number
  epoch: bigint
  noSnapshot: boolean
  bucket: string
  pathPrefix: string
  tables: string[]
}
export interface Subscribed { type: typeof MsgType.Subscribed; reqId: number; subId: number }
export interface Unsubscribe { type: typeof MsgType.Unsubscribe; reqId: number; subId: number }
export interface Batch {
  type: typeof MsgType.Batch
  subId: number
  snapshot: boolean
  reset: boolean
  checkpoint: number
  epoch: bigint
  tables: string[]
  changes: WireChange[]
}
export interface SubEnd { type: typeof MsgType.SubEnd; subId: number; code: string; message: string }
export interface Ack { type: typeof MsgType.Ack; subId: number; checkpoint: number }
export interface Query { type: typeof MsgType.Query; reqId: number; sql: string; args: Value[] | null; maxRows: number }
export interface Exec { type: typeof MsgType.Exec; reqId: number; mutationId: string; sql: string; args: Value[] | null }
export interface Tx { type: typeof MsgType.Tx; reqId: number; mutationId: string; statements: WireStatement[] }
export interface Result {
  type: typeof MsgType.Result
  reqId: number
  columns: string[]
  rows: Value[][]
  truncated: boolean
  rowsAffected: number
  lastInsertId: number | bigint
  replayed: boolean
}
export interface Verify { type: typeof MsgType.Verify; reqId: number; subId: number }
export interface Verified { type: typeof MsgType.Verified; reqId: number; subId: number; epoch: bigint; checkpoint: number; rows: number; sum: bigint }
export interface Sign { type: typeof MsgType.Sign; reqId: number; objectId: string; ttlSeconds: number }
export interface Signed { type: typeof MsgType.Signed; reqId: number; url: string; expiresAtMs: number }
export interface GoAway { type: typeof MsgType.GoAway; reason: string; retryAfterMs: number }
export interface Shape { type: typeof MsgType.Shape; table: string; tv: number; columns: string[]; pk: string[] }
export interface OK { type: typeof MsgType.OK; reqId: number }
/** Runs a published unit; args is JSON text ("" for none). */
export interface Call { type: typeof MsgType.Call; reqId: number; unit: string; args: string; mutationId: string }
/** Answers Call: the unit's result (ok) or the error it threw; value and errData are JSON text. */
export interface Returned {
  type: typeof MsgType.Returned
  reqId: number
  ok: boolean
  value: string
  replayed: boolean
  errCode: string
  errMessage: string
  errData: string
}
/** Manages a database's units (scope ddl); body is the op's JSON request. */
export interface UnitAdmin { type: typeof MsgType.UnitAdmin; reqId: number; op: string; body: string }
/** Answers UnitAdmin with the JSON text of its result. */
export interface UnitAdminResult { type: typeof MsgType.UnitAdminResult; reqId: number; body: string }

export type Msg =
  | Hello | Welcome | ErrorMsg | Ping | Pong | Auth | Subscribe | Subscribed | Unsubscribe | Batch | SubEnd | Ack
  | Query | Exec | Tx | Result | Verify | Verified | Sign | Signed | GoAway | Shape | OK
  | Call | Returned | UnitAdmin | UnitAdminResult

function writeFilter(w: Writer, f: WireFilter | null): void {
  if (!f) return w.flag(false)
  w.flag(true)
  w.s(f.op)
  w.s(f.col)
  w.val(f.val)
  w.vals(f.vals)
  w.u(f.args.length)
  for (const a of f.args) writeFilter(w, a)
}

function readFilter(r: Reader, depth: number, nodes: { n: number }): WireFilter | null {
  if (!r.flag()) return null
  nodes.n++
  if (depth > MAX_FILTER_DEPTH || nodes.n > MAX_FILTER_NODES) throw new CodecError('filter too large')
  const f: WireFilter = { op: r.s(), col: r.s(), val: r.val(), vals: r.vals(), args: [] }
  const n = r.count()
  for (let i = 0; i < n; i++) {
    const a = readFilter(r, depth + 1, nodes)
    if (!a) throw new CodecError('missing filter argument')
    f.args.push(a)
  }
  return f
}

/** Serializes a message. */
export function encode(m: Msg, w = new Writer(128)): Uint8Array {
  w.byte(m.type)
  switch (m.type) {
    case MsgType.Hello:
      w.u(m.version); w.s(m.database); w.s(m.credential); w.s(m.client)
      break
    case MsgType.Welcome:
      w.s(m.sessionId); w.i(m.serverTimeMs); w.u(m.heartbeatMs); w.u(m.maxMessage); w.s(m.principal); w.strs(m.scopes)
      w.u(m.maxSubscriptions)
      break
    case MsgType.Error:
      w.u(m.reqId); w.s(m.code); w.s(m.message); w.flag(m.fatal); w.u(m.retryAfterMs)
      break
    case MsgType.Ping:
    case MsgType.Pong:
      w.u(m.nonce)
      break
    case MsgType.Auth:
      w.u(m.reqId); w.s(m.credential)
      break
    case MsgType.Subscribe:
      w.u(m.reqId); w.u(m.subId); w.u(m.kind); w.s(m.table); w.vals(m.key); writeFilter(w, m.where); w.u(m.ops)
      w.u(m.since); w.i(m.epoch); w.flag(m.noSnapshot); w.s(m.bucket); w.s(m.pathPrefix); w.strs(m.tables)
      break
    case MsgType.Subscribed:
    case MsgType.Unsubscribe:
    case MsgType.Verify:
      w.u(m.reqId); w.u(m.subId)
      break
    case MsgType.Batch:
      w.u(m.subId); w.flag(m.snapshot); w.flag(m.reset); w.u(m.checkpoint); w.i(m.epoch); w.strs(m.tables)
      w.u(m.changes.length)
      for (const c of m.changes) {
        w.u(c.seq); w.s(c.table); w.i(c.tv); w.u(c.op); w.vals(c.key, c.keyFloats); w.vals(c.new, c.newFloats); w.vals(c.old)
      }
      break
    case MsgType.SubEnd:
      w.u(m.subId); w.s(m.code); w.s(m.message)
      break
    case MsgType.Ack:
      w.u(m.subId); w.u(m.checkpoint)
      break
    case MsgType.Query:
      w.u(m.reqId); w.s(m.sql); w.vals(m.args); w.u(m.maxRows)
      break
    case MsgType.Exec:
      w.u(m.reqId); w.s(m.mutationId); w.s(m.sql); w.vals(m.args)
      break
    case MsgType.Tx:
      w.u(m.reqId); w.s(m.mutationId); w.u(m.statements.length)
      for (const s of m.statements) {
        w.s(s.sql); w.vals(s.args)
      }
      break
    case MsgType.Result:
      w.u(m.reqId); w.strs(m.columns); w.u(m.rows.length)
      for (const row of m.rows) w.vals(row)
      w.flag(m.truncated); w.i(m.rowsAffected); w.i(m.lastInsertId); w.flag(m.replayed)
      break
    case MsgType.Verified:
      w.u(m.reqId); w.u(m.subId); w.i(m.epoch); w.u(m.checkpoint); w.i(m.rows); w.u(m.sum)
      break
    case MsgType.Sign:
      w.u(m.reqId); w.s(m.objectId); w.u(m.ttlSeconds)
      break
    case MsgType.Signed:
      w.u(m.reqId); w.s(m.url); w.i(m.expiresAtMs)
      break
    case MsgType.GoAway:
      w.s(m.reason); w.u(m.retryAfterMs)
      break
    case MsgType.Shape:
      w.s(m.table); w.i(m.tv); w.strs(m.columns); w.strs(m.pk)
      break
    case MsgType.OK:
      w.u(m.reqId)
      break
    case MsgType.Call:
      w.u(m.reqId); w.s(m.unit); w.s(m.args); w.s(m.mutationId)
      break
    case MsgType.Returned:
      w.u(m.reqId); w.flag(m.ok); w.s(m.value); w.flag(m.replayed); w.s(m.errCode); w.s(m.errMessage); w.s(m.errData)
      break
    case MsgType.UnitAdmin:
      w.u(m.reqId); w.s(m.op); w.s(m.body)
      break
    case MsgType.UnitAdminResult:
      w.u(m.reqId); w.s(m.body)
      break
  }
  return w.finish()
}

function byteField(r: Reader, what: string): number {
  const v = r.u()
  if (v > 255) throw new CodecError(`${what} ${v}`)
  return v
}

function readBody(type: number, r: Reader): Msg {
  switch (type) {
    case MsgType.Hello: {
      const version = r.u()
      if (version > 0xffff) throw new CodecError(`version ${version}`)
      return { type, version, database: r.s(), credential: r.s(), client: r.s() }
    }
    case MsgType.Welcome:
      return {
        type, sessionId: r.s(), serverTimeMs: r.iNum(), heartbeatMs: r.u32(), maxMessage: r.u32(), principal: r.s(),
        scopes: r.strs(), maxSubscriptions: r.u32(),
      }
    case MsgType.Error:
      return { type, reqId: r.u32(), code: r.s(), message: r.s(), fatal: r.flag(), retryAfterMs: r.u32() }
    case MsgType.Ping:
    case MsgType.Pong:
      return { type, nonce: r.u() }
    case MsgType.Auth:
      return { type, reqId: r.u32(), credential: r.s() }
    case MsgType.Subscribe: {
      const reqId = r.u32()
      const subId = r.u32()
      const kind = byteField(r, 'kind')
      const table = r.s()
      const key = r.vals()
      const where = readFilter(r, 0, { n: 0 })
      const ops = byteField(r, 'ops')
      return {
        type, reqId, subId, kind, table, key, where, ops, since: r.u(), epoch: r.iBig(), noSnapshot: r.flag(),
        bucket: r.s(), pathPrefix: r.s(), tables: r.strs(),
      }
    }
    case MsgType.Subscribed:
    case MsgType.Unsubscribe:
    case MsgType.Verify:
      return { type, reqId: r.u32(), subId: r.u32() }
    case MsgType.Batch: {
      const m: Batch = {
        type, subId: r.u32(), snapshot: r.flag(), reset: r.flag(), checkpoint: r.u(), epoch: r.iBig(), tables: r.strs(),
        changes: [],
      }
      const n = r.count()
      for (let i = 0; i < n; i++) {
        const seq = r.u()
        const table = r.s()
        const tv = r.iNum()
        const op = byteField(r, 'op')
        const c: WireChange = { seq, table, tv, op, key: r.vals(), new: null, old: null }
        if (r.lastFloats) c.keyFloats = r.lastFloats
        c.new = r.vals()
        if (r.lastFloats) c.newFloats = r.lastFloats
        c.old = r.vals()
        m.changes.push(c)
      }
      return m
    }
    case MsgType.SubEnd:
      return { type, subId: r.u32(), code: r.s(), message: r.s() }
    case MsgType.Ack:
      return { type, subId: r.u32(), checkpoint: r.u() }
    case MsgType.Query:
      return { type, reqId: r.u32(), sql: r.s(), args: r.vals(), maxRows: r.u32() }
    case MsgType.Exec:
      return { type, reqId: r.u32(), mutationId: r.s(), sql: r.s(), args: r.vals() }
    case MsgType.Tx: {
      const m: Tx = { type, reqId: r.u32(), mutationId: r.s(), statements: [] }
      const n = r.count()
      for (let i = 0; i < n; i++) m.statements.push({ sql: r.s(), args: r.vals() })
      return m
    }
    case MsgType.Result: {
      const reqId = r.u32()
      const columns = r.strs()
      const n = r.count()
      const rows = new Array<Value[]>(n)
      for (let i = 0; i < n; i++) rows[i] = r.vals() ?? []
      return { type, reqId, columns, rows, truncated: r.flag(), rowsAffected: r.iNum(), lastInsertId: r.i(), replayed: r.flag() }
    }
    case MsgType.Verified:
      return { type, reqId: r.u32(), subId: r.u32(), epoch: r.iBig(), checkpoint: r.u(), rows: r.iNum(), sum: r.uBig() }
    case MsgType.Sign:
      return { type, reqId: r.u32(), objectId: r.s(), ttlSeconds: r.u32() }
    case MsgType.Signed:
      return { type, reqId: r.u32(), url: r.s(), expiresAtMs: r.iNum() }
    case MsgType.GoAway:
      return { type, reason: r.s(), retryAfterMs: r.u32() }
    case MsgType.Shape:
      return { type, table: r.s(), tv: r.iNum(), columns: r.strs(), pk: r.strs() }
    case MsgType.OK:
      return { type, reqId: r.u32() }
    case MsgType.Call:
      return { type, reqId: r.u32(), unit: r.s(), args: r.s(), mutationId: r.s() }
    case MsgType.Returned:
      return {
        type, reqId: r.u32(), ok: r.flag(), value: r.s(), replayed: r.flag(), errCode: r.s(), errMessage: r.s(), errData: r.s(),
      }
    case MsgType.UnitAdmin:
      return { type, reqId: r.u32(), op: r.s(), body: r.s() }
    case MsgType.UnitAdminResult:
      return { type, reqId: r.u32(), body: r.s() }
  }
  throw new CodecError(`unknown type ${type}`)
}

/** Parses one message; malformed input throws {@link CodecError}. */
export function decode(b: Uint8Array): Msg {
  if (b.length === 0) throw new CodecError('malformed message: empty')
  const type = b[0] as number
  const r = new Reader(b.subarray(1))
  let m: Msg
  try {
    m = readBody(type, r)
  } catch (e) {
    throw new CodecError(`malformed message: type ${type}: ${(e as Error).message}`)
  }
  if (r.remaining !== 0) throw new CodecError(`malformed message: type ${type}: ${r.remaining} trailing bytes`)
  return m
}
