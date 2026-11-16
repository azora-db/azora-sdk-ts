/** node:sqlite, the engine's internal tables and limits, and the shapes a run passes around. */
import { createRequire } from 'node:module'
import type { HttpRequest } from '../ctx.ts'
import { bytesOf } from './json.ts'
import { TABLE_PREFIX } from './sql.ts'
import type { Runs } from './types.ts'
import type { Def } from './units.ts'

// node:sqlite.

/** The minimum Node.js versions with node:sqlite without a flag. */
export const NODE_SQLITE = '22.13.0 (or 23.4.0 and later)'

export function openSqlite(): typeof import('node:sqlite') {
  let mod: typeof import('node:sqlite') | undefined
  try {
    mod =
      (process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined) ??
      (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  } catch {
    mod = undefined
  }
  if (!mod?.DatabaseSync) {
    throw new Error(
      `@azora-db/units/testing needs node:sqlite, which Node.js has without a flag from ${NODE_SQLITE}; this is Node.js ${process.version}`,
    )
  }
  return mod
}

export const INTERNAL_SCHEMA = `
CREATE TABLE ${TABLE_PREFIX}_jobs(id TEXT PRIMARY KEY, unit TEXT NOT NULL, args TEXT NOT NULL, run_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
CREATE TABLE ${TABLE_PREFIX}_results(id TEXT PRIMARY KEY, at INTEGER NOT NULL, unit TEXT NOT NULL, result TEXT NOT NULL);`

export interface JobRow {
  id: string
  unit: string
  args: string
  run_at: number
  created_at: number
  created_by: string
  source: string
  attempts: number
  state: 'pending' | 'failed'
  error: string
}

export const MAX_JOB_DELAY = 366 * 24 * 3600e3
export const MAX_RUN_DEPTH = 8
export const MAX_LOG_BYTES = 4 << 10

/** How long a job waits after its n-th failed attempt: 1s, 2s, 4s ... up to an hour. */
export function jobBackoff(n: number): number {
  const k = Math.max(1, n)
  return k > 12 ? 3600e3 : Math.min(2 ** (k - 1) * 1000, 3600e3)
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
export function base32(b: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const x of b) {
    value = (value << 8) | x
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

/** A string, bytes or nothing as bytes (the engine's bytesArg). */
export function bytesArg(v: unknown): Uint8Array {
  if (v === null || v === undefined) return new Uint8Array()
  if (typeof v === 'string') return new TextEncoder().encode(v)
  const b = bytesOf(v)
  if (b) return b
  throw new TypeError('expected a string, Uint8Array or ArrayBuffer')
}

// A run.

/** A transaction a frame holds (the connection has one at a time). */
export interface Hold {
  write: boolean
  ended: boolean
  /** It began the connection's transaction (false: it runs inside one already open). */
  own: boolean
}

export interface Frame {
  unit: Def
  kind: Runs
  tx: Hold | null
  write: boolean
}

export interface Caller {
  kind: 'key' | 'token' | 'admin' | 'system' | 'public'
  principal: string
  subject: string
  scopes: string[]
  tables: string[]
  claims: Record<string, unknown>
}

export interface Request {
  unit: string
  args: string
  mutationId: string
  caller: Caller
  external: boolean
  trigger: string
  noValidate?: boolean
  /** The request of a call over plain HTTP (ctx.request). */
  http?: HttpRequest
  inTx?: () => void
  afterAction?: () => void
  job?: JobRow
}

export interface Answer {
  value: string
  replayed: boolean
  /** What the unit threw; stack (for the run log) only for values that are not a UnitError. */
  err: { code: string; message: string; data: string; stack: string } | null
}

export const CODES = new Set(['invalid', 'not_found', 'permission_denied', 'conflict', 'failed'])
