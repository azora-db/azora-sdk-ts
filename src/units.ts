/**
 * Units: functions published into a database and called by name
 * (docs/units.md of the engine). This file holds the JSON form of their
 * arguments and results, the types `db.units` is built from, and the
 * admin facade (`db.unitsAdmin`).
 */
import { UnitError, type UnitErrorCodeValue } from './errors.ts'
import type { CallOptions } from './util.ts'

// JSON with blobs: a Uint8Array travels as {"$bytes": "<base64>"}.

function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function replacer(this: unknown, key: string, value: unknown): unknown {
  // The holder's own value: a Buffer has already gone through its toJSON.
  const raw = (this as Record<string, unknown>)[key]
  if (raw instanceof Uint8Array) return { $bytes: toBase64(raw) }
  if (raw instanceof ArrayBuffer) return { $bytes: toBase64(new Uint8Array(raw)) }
  if (ArrayBuffer.isView(raw)) return { $bytes: toBase64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) }
  if (typeof value === 'bigint') return Number(value) // integers travel as JSON numbers
  return value
}

/**
 * The JSON text of a unit's arguments or result: blobs (Uint8Array,
 * ArrayBuffer, typed arrays) become `{"$bytes": base64}`, bigints numbers.
 * undefined is "" (no arguments).
 */
export function encodeUnitJSON(value: unknown): string {
  if (value === undefined) return ''
  const s = JSON.stringify(value, replacer)
  if (s === undefined) throw new TypeError(`azora: a ${typeof value} cannot be sent to a unit`)
  return s
}

/** Turns every `{"$bytes": base64}` object in a parsed JSON value into a Uint8Array. */
export function reviveBytes(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = reviveBytes(v[i])
    return v
  }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1 && keys[0] === '$bytes' && typeof o['$bytes'] === 'string') return fromBase64(o['$bytes'])
  for (const k of keys) o[k] = reviveBytes(o[k])
  return o
}

/** Parses a unit's JSON result, reviving blobs; "" is undefined. */
export function decodeUnitJSON(text: string): unknown {
  if (text === '') return undefined
  return reviveBytes(JSON.parse(text))
}

/** Builds the error a unit threw from its code, message and JSON data. */
export function unitError(unit: string, code: string, message: string, data: string | unknown): UnitError {
  let d: unknown = data
  if (typeof data === 'string') {
    try {
      d = data === '' ? undefined : decodeUnitJSON(data)
    } catch {
      d = data
    }
  }
  return new UnitError(unit, code as UnitErrorCodeValue, message, d === null ? undefined : d)
}

// Types: db.units is derived from the definitions of @azora-db/units,
// which carry a phantom "~azora" property (structural: no dependency on
// that package).

/** Unit kinds. */
export type UnitKind = 'query' | 'mutation' | 'action' | 'schedule' | 'onChange'

/** The phantom type a unit definition carries under `"~azora"`. */
export interface UnitBrand<K extends UnitKind = UnitKind, A = unknown, R = unknown, I extends boolean = boolean> {
  kind: K
  args: A
  result: R
  internal: I
}

/** Options of a unit call. */
export interface UnitCallOptions extends CallOptions {
  /**
   * Your own mutation id (at most 128 bytes) instead of a fresh one: a
   * mutation called again with the same id within the server's window
   * returns its first result without running again.
   */
  mutationId?: string
}

/** A unit as a function: `args` may be left out when the unit takes none. */
export type UnitFunction<A, R> = undefined extends A
  ? (args?: A, opts?: UnitCallOptions) => Promise<R>
  : (args: A, opts?: UnitCallOptions) => Promise<R>

type BrandOf<T> = T extends { readonly '~azora'?: infer B } ? Exclude<B, undefined> : never
type CallableKey<B, K> = B extends { kind: 'query' | 'mutation' | 'action'; internal: false } ? K : never

/**
 * The units of a module (`typeof import('./units')`) that clients can
 * call: its query, mutation and action exports that are not internal.
 */
export type UnitsOf<M> = {
  readonly [K in keyof M as CallableKey<BrandOf<M[K]>, K>]: BrandOf<M[K]> extends { args: infer A; result: infer R }
    ? UnitFunction<A, Awaited<R>>
    : never
}

/** `db.units` without a module type: any name, untyped. */
export interface UntypedUnits {
  readonly [name: string]: (args?: any, opts?: UnitCallOptions) => Promise<unknown>
}

/** `db.units` for a units module type M (untyped when M is not given). */
export type Units<M> = unknown extends M ? UntypedUnits : UnitsOf<M>

/** The arguments of unit N of module M (`UnitArgs<typeof import('./units'), 'checkout'>`). */
export type UnitArgs<M, N extends keyof M> = BrandOf<M[N]> extends { args: infer A } ? A : never
/** The result of unit N of module M. */
export type UnitResult<M, N extends keyof M> = BrandOf<M[N]> extends { result: infer R } ? Awaited<R> : never

// The admin facade.

/** A JSON Schema (the subset units check). */
export type JsonSchema = Record<string, unknown>

/** A published unit, as the server describes it. */
export interface UnitInfo {
  name: string
  kind: UnitKind
  internal: boolean
  description: string
  /** The JSON Schema of the arguments, or null for any. */
  args: JsonSchema | null
  /** schedule and onChange: whether a run is a mutation or an action. */
  mode?: 'mutation' | 'action'
  /** schedule. */
  cron?: string
  every?: string
  /** onChange. */
  table?: string
  ops?: string[]
  batch?: number
}

export interface DeployInput {
  /** The bundle: one script that sets `globalThis.__azora_units`. */
  bundle: string
  /** Its source map (maps stack traces in the run log to your source). */
  sourceMap?: string
  note?: string
  /** Checks the bundle and returns its units without publishing it. */
  dryRun?: boolean
}

export interface DeployResult {
  version: number
  sha256: string
  /** The bundle is the active one already: no new version was made. */
  unchanged: boolean
  dryRun: boolean
  units: UnitInfo[]
}

/** A deploy in the history (times are unix milliseconds). */
export interface DeployInfo {
  version: number
  at: number
  by: string
  note: string
  sha256: string
  size: number
  /** The deploy's units, as the server reports them. */
  units: number | string[]
  active: boolean
}

/** What started a unit run. */
export type UnitRunTrigger = 'call' | 'schedule' | 'change' | 'job' | 'admin' | 'cli' | 'mcp' | (string & {})

/** How a unit run ended. */
export type UnitRunStatus = 'ok' | 'error' | 'replayed' | 'rejected' | (string & {})

/** A job scheduled with `ctx.scheduler` (times are unix milliseconds). */
export interface UnitJob {
  /** `job_` and 26 characters. */
  id: string
  unit: string
  /** The job's arguments (blobs as Uint8Array), undefined for none. */
  args: unknown
  /** pending: when it is due; failed: when it failed for good. */
  runAt: number
  createdAt: number
  /** The principal of the run that scheduled it. */
  createdBy: string
  /** The unit that scheduled it. */
  source: string
  /** Failed runs so far. */
  attempts: number
  state: 'pending' | 'failed'
  /** The last failure ("" for none). */
  error: string
}

/** A page of jobs and the database's counts. */
export interface UnitJobList {
  jobs: UnitJob[]
  /** Jobs waiting in the database (all units). */
  pending: number
  /** Jobs that failed for good. */
  failed: number
}

/** A unit run in the run log. */
export interface UnitRun {
  /** The run's id (`runs({ before, after })` pages by it). */
  id: number
  at: number
  unit: string
  kind: UnitKind
  /**
   * What started the run: `call` (a client), `schedule`, `change`
   * (onChange), `job` (`ctx.scheduler`), `admin` (the admin API, the
   * dashboard), `cli` (`azora-units call`, {@link UnitsAdmin.call}) or
   * `mcp` (an AI agent).
   */
  trigger: UnitRunTrigger
  principal: string
  durationMs: number
  /**
   * `ok`; `error` (the unit ran and threw, timed out or hit a limit);
   * `replayed` (a retry answered from the stored result); `rejected`
   * (refused before the unit ran: arguments that do not match its schema,
   * an internal unit called by a client).
   */
  status: UnitRunStatus
  error: string
  /** What the run logged (`ctx.log`), one line per entry. */
  logs: string
}

/** A schedule or onChange trigger. */
export interface UnitTrigger {
  unit: string
  kind: UnitKind
  /** The cron expression, the interval, or the table. */
  spec: string
  mode: 'mutation' | 'action'
  /** schedule: the next run (unix ms). */
  nextAt?: number
  lastAt?: number
  /** onChange: the last change processed, and how many wait. */
  cursor?: number
  pending?: number
  failures: number
  error?: string
  lagged: boolean
  running: boolean
}

export interface UnitSecret {
  name: string
  updatedAt: number
}

/** Copies o with its snake_case keys in camelCase (one level). */
function camel<T>(o: unknown): T {
  if (typeof o !== 'object' || o === null) return o as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v
  return out as T
}

/** @internal How the facade reaches the server. */
export type AdminSend = (op: string, body: string, opts?: CallOptions) => Promise<string>

/**
 * Publishing and operating units (`db.unitsAdmin`): needs an API key with
 * the `ddl` scope. Most applications use the `azora-units` CLI instead.
 */
export class UnitsAdmin {
  private readonly send: AdminSend

  /** Secrets units read as `ctx.env.NAME`: set and removed, never read back. */
  readonly secrets: {
    list(opts?: CallOptions): Promise<UnitSecret[]>
    set(name: string, value: string, opts?: CallOptions): Promise<void>
    /** Reports whether the secret existed. */
    unset(name: string, opts?: CallOptions): Promise<boolean>
  }

  /** Jobs units scheduled with `ctx.scheduler`: waiting and failed ones. */
  readonly jobs: {
    /** Waiting jobs first (the next due first), then failed ones; at most `limit` (default 100). */
    list(o?: { state?: 'pending' | 'failed'; unit?: string; limit?: number }, opts?: CallOptions): Promise<UnitJobList>
    /** Removes a job, waiting or failed; reports whether it existed. A running job finishes. */
    cancel(id: string, opts?: CallOptions): Promise<boolean>
    /** Runs a failed job again now, its attempts reset (`invalid` for a job that is not failed, `not_found` for none). */
    retry(id: string, opts?: CallOptions): Promise<void>
  }

  /** @internal */
  constructor(send: AdminSend) {
    this.send = send
    this.jobs = {
      list: async (o = {}, opts) => {
        const r = await this.op<{ jobs?: unknown[]; pending?: number; failed?: number }>('jobs', o, opts)
        return {
          jobs: (r.jobs ?? []).map((x) => {
            const j = camel<UnitJob & { args: unknown; error?: string }>(x)
            j.args = j.args === null ? undefined : reviveBytes(j.args)
            j.error ??= ''
            return j
          }),
          pending: r.pending ?? 0,
          failed: r.failed ?? 0,
        }
      },
      cancel: async (id, opts) => Boolean((await this.op<{ removed?: unknown }>('jobs.cancel', { id }, opts)).removed),
      retry: async (id, opts) => {
        await this.op('jobs.retry', { id }, opts)
      },
    }
    this.secrets = {
      list: async (opts) => ((await this.op<{ secrets?: unknown[] }>('secrets.list', {}, opts)).secrets ?? []).map((s) => camel<UnitSecret>(s)),
      set: async (name, value, opts) => {
        await this.op('secrets.set', { name, value }, opts)
      },
      unset: async (name, opts) => Boolean((await this.op<{ removed?: unknown }>('secrets.unset', { name }, opts)).removed),
    }
  }

  private async op<T>(op: string, body: unknown, opts?: CallOptions): Promise<T> {
    const text = await this.send(op, JSON.stringify(body), opts)
    return (text === '' ? {} : JSON.parse(text)) as T
  }

  /** Publishes a bundle as a new version (unless it is already the active one). */
  async deploy(input: DeployInput, opts?: CallOptions): Promise<DeployResult> {
    const body: Record<string, unknown> = { bundle: input.bundle }
    if (input.sourceMap !== undefined) body['source_map'] = input.sourceMap
    if (input.note !== undefined) body['note'] = input.note
    if (input.dryRun) body['dry_run'] = true
    const r = camel<DeployResult>(await this.op('deploy', body, opts))
    r.units ??= []
    return r
  }

  /** The active deploy's version (0: nothing published) and its units. */
  async list(opts?: CallOptions): Promise<{ version: number; units: UnitInfo[] }> {
    const r = await this.op<{ version?: number; units?: UnitInfo[] }>('list', {}, opts)
    return { version: r.version ?? 0, units: r.units ?? [] }
  }

  /** The deploy history, newest first, and the active version. */
  async deploys(o: { limit?: number } = {}, opts?: CallOptions): Promise<{ active: number; deploys: DeployInfo[] }> {
    const r = await this.op<{ active?: number; deploys?: unknown[] }>('deploys', o, opts)
    return { active: r.active ?? 0, deploys: (r.deploys ?? []).map((d) => camel<DeployInfo>(d)) }
  }

  /** Makes an earlier deploy the active one (a rollback). */
  async activate(version: number, opts?: CallOptions): Promise<{ version: number; units: UnitInfo[] }> {
    const r = await this.op<{ version?: number; units?: UnitInfo[] }>('activate', { version }, opts)
    return { version: r.version ?? version, units: r.units ?? [] }
  }

  /**
   * Runs a unit as the caller, internal units included, and returns its
   * result; a unit that throws rejects with a {@link UnitError}. It is
   * not sent again after a lost connection.
   */
  async call<R = unknown>(unit: string, args?: unknown, opts?: CallOptions): Promise<R> {
    const body: Record<string, unknown> = { unit }
    const a = encodeUnitJSON(args)
    if (a !== '') body['args'] = JSON.parse(a) as unknown
    const r = await this.op<{ ok?: boolean; value?: unknown; error?: unknown }>('call', body, opts)
    if (!r.ok) {
      const e = r.error
      if (typeof e === 'object' && e !== null) {
        const { code, message, data } = e as { code?: string; message?: string; data?: unknown }
        throw unitError(unit, code ?? 'failed', message ?? '', reviveBytes(data))
      }
      throw unitError(unit, 'failed', typeof e === 'string' ? e : 'the unit failed', undefined)
    }
    return reviveBytes(r.value) as R
  }

  /**
   * The run log, newest first: at most `limit` runs, of one unit, with one
   * status, older than run id `before` or newer than run id `after`.
   */
  async runs(
    o: { limit?: number; unit?: string; status?: 'ok' | 'error' | 'replayed' | 'rejected'; before?: number; after?: number } = {},
    opts?: CallOptions,
  ): Promise<UnitRun[]> {
    const r = await this.op<{ runs?: unknown[] }>('runs', o, opts)
    return (r.runs ?? []).map((x) => camel<UnitRun>(x))
  }

  /** The schedule and onChange triggers and their state. */
  async triggers(opts?: CallOptions): Promise<UnitTrigger[]> {
    const r = await this.op<{ triggers?: unknown[] }>('triggers', {}, opts)
    return (r.triggers ?? []).map((x) => camel<UnitTrigger>(x))
  }

  /**
   * Skips a trigger's pending work: an onChange unit jumps past the
   * changes it has not processed. Returns how many were skipped.
   */
  async skipTrigger(unit: string, opts?: CallOptions): Promise<number> {
    const r = await this.op<{ skipped?: number }>('triggers.skip', { unit }, opts)
    return r.skipped ?? 0
  }
}
