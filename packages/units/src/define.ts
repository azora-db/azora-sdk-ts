/**
 * The helpers that define units. Each returns the plain definition object
 * of the bundle format (docs/units.md, Bundle format), handler included;
 * its type carries a phantom `"~azora"` brand with the unit's kind,
 * arguments and result, which `@azora-db/client` reads to type `db.units`.
 */
import type { ActionCtx, ChangeBatch, MutationCtx, QueryCtx, Row, UnitKind } from './ctx.ts'
import { argsSchema, type ArgsSpec, type InferArgs, type JsonSchema } from './v.ts'

/** The phantom type of a definition (what clients see). */
export interface UnitBrand<K extends UnitKind = UnitKind, A = unknown, R = unknown, I extends boolean = boolean> {
  kind: K
  args: A
  result: R
  internal: I
}

/** A unit definition: what a unit export holds. */
export interface UnitDefinition<K extends UnitKind = UnitKind, A = unknown, R = unknown, I extends boolean = boolean> {
  /**
   * The bundle format's marker: the number 1 at runtime. Its declared type
   * is the phantom brand clients read the unit's types from.
   */
  readonly '~azora'?: UnitBrand<K, A, R, I>
  readonly kind: K
  readonly handler: (ctx: any, args: any) => unknown
  /** The JSON Schema of the arguments, or null for any. */
  readonly args: JsonSchema | null
  readonly internal: I
  readonly description: string
}

/** A schedule unit's definition. */
export interface ScheduleDefinition<M extends RunMode = RunMode> extends UnitDefinition<'schedule', undefined, unknown, true> {
  readonly mode: M
  readonly cron: string
  readonly every: string
}

/** An onChange unit's definition. */
export interface OnChangeDefinition<M extends RunMode = RunMode> extends UnitDefinition<'onChange', undefined, unknown, true> {
  readonly mode: M
  readonly table: string
  readonly ops: ChangeOp[]
  readonly batch: number
}

/** How a schedule or onChange unit runs: as a mutation (one transaction, the default) or an action. */
export type RunMode = 'mutation' | 'action'
export type ChangeOp = 'insert' | 'update' | 'delete'

/** Options of query, mutation and action. */
interface CallableOptions<I extends boolean> {
  /** Clients cannot call the unit; other units can (`ctx.run`). */
  internal?: I
  /** Shown in the dashboard and to AI agents (MCP). */
  description?: string
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function define<K extends UnitKind>(kind: K, def: { args?: ArgsSpec | undefined; internal?: boolean; description?: string; handler: unknown }): Record<string, unknown> {
  if (typeof def !== 'object' || def === null) throw new TypeError(`azora units: ${kind}() takes an object ({ handler, ... })`)
  if (typeof def.handler !== 'function') throw new TypeError(`azora units: ${kind}() needs a handler function`)
  return {
    '~azora': 1,
    kind,
    handler: def.handler,
    args: def.args === undefined ? null : argsSchema(def.args),
    internal: def.internal ?? false,
    description: def.description ?? '',
  }
}

type Def<K extends UnitKind, A, R, I extends boolean> = UnitDefinition<K, A, Awaited<R>, I>

/**
 * A query: reads in one consistent snapshot, runs in parallel with other
 * calls, always safe to retry.
 *
 * ```ts
 * export const myOrders = query({
 *   handler: (ctx) => ctx.db.all('SELECT * FROM orders WHERE customer = ?', ctx.auth.subject),
 * })
 * ```
 */
export function query<const S extends ArgsSpec, R, I extends boolean = false>(
  def: CallableOptions<I> & { args: S; handler: (ctx: QueryCtx, args: InferArgs<S>) => R },
): Def<'query', InferArgs<S>, R, I>
export function query<R, A = unknown, I extends boolean = false>(
  def: CallableOptions<I> & { args?: undefined; handler: (ctx: QueryCtx, args: A) => R },
): Def<'query', A, R, I>
export function query(def: { args?: ArgsSpec | undefined; internal?: boolean; description?: string; handler: unknown }): unknown {
  return define('query', def)
}

/**
 * A mutation: one write transaction, committed when the handler returns
 * and rolled back when it throws; a retried call runs it exactly once.
 *
 * ```ts
 * export const checkout = mutation({
 *   args: { cartId: v.string() },
 *   handler(ctx, { cartId }) { ... return { orderId } },
 * })
 * ```
 */
export function mutation<const S extends ArgsSpec, R, I extends boolean = false>(
  def: CallableOptions<I> & { args: S; handler: (ctx: MutationCtx, args: InferArgs<S>) => R },
): Def<'mutation', InferArgs<S>, R, I>
export function mutation<R, A = unknown, I extends boolean = false>(
  def: CallableOptions<I> & { args?: undefined; handler: (ctx: MutationCtx, args: A) => R },
): Def<'mutation', A, R, I>
export function mutation(def: { args?: ArgsSpec | undefined; internal?: boolean; description?: string; handler: unknown }): unknown {
  return define('mutation', def)
}

/**
 * An action: no implicit transaction (each `ctx.db.exec` commits on its
 * own, `ctx.db.tx` groups writes) and `ctx.fetch`. A finished result is
 * returned to retries; an interrupted run may run again.
 */
export function action<const S extends ArgsSpec, R, I extends boolean = false>(
  def: CallableOptions<I> & { args: S; handler: (ctx: ActionCtx, args: InferArgs<S>) => R },
): Def<'action', InferArgs<S>, R, I>
export function action<R, A = unknown, I extends boolean = false>(
  def: CallableOptions<I> & { args?: undefined; handler: (ctx: ActionCtx, args: A) => R },
): Def<'action', A, R, I>
export function action(def: { args?: ArgsSpec | undefined; internal?: boolean; description?: string; handler: unknown }): unknown {
  return define('action', def)
}

type ModeCtx<M extends RunMode> = M extends 'action' ? ActionCtx : MutationCtx

const DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/

/**
 * A unit run on a schedule: `cron` (five fields, UTC, or `@hourly`,
 * `@daily`, `@weekly`, `@monthly`) or `every` (`30s`, `5m`, `1h30m`; at
 * least 1s). It runs as a mutation, or as an action with `mode: "action"`.
 * Always internal.
 */
export function schedule<M extends RunMode = 'mutation'>(def: {
  cron?: string
  every?: string
  mode?: M
  description?: string
  handler: (ctx: ModeCtx<M>) => unknown
}): ScheduleDefinition<M> {
  const cron = def?.cron ?? ''
  const every = def?.every ?? ''
  if ((cron === '') === (every === '')) throw new TypeError('azora units: schedule() needs one of cron or every')
  if (every !== '' && !DURATION.test(every)) throw new TypeError(`azora units: schedule(): every ${JSON.stringify(every)} is not a duration like 30s, 5m or 1h30m`)
  const d = define('schedule', { internal: true, ...(def.description !== undefined && { description: def.description }), handler: def.handler })
  return Object.assign(d, { mode: def.mode ?? 'mutation', cron, every }) as unknown as ScheduleDefinition<M>
}

/**
 * A unit run with the rows that changed in a table, at most `batch`
 * (default 100) changes per run, in commit order. It runs as a mutation
 * (each change exactly once), or as an action with `mode: "action"` (at
 * least once). Publishing it publishes the table for realtime. Always
 * internal.
 */
export function onChange<T = Row, M extends RunMode = 'mutation'>(def: {
  table: string
  /** Default: all three. */
  ops?: readonly ChangeOp[]
  batch?: number
  mode?: M
  description?: string
  handler: (ctx: ModeCtx<M>, batch: ChangeBatch<T>) => unknown
}): OnChangeDefinition<M> {
  if (typeof def?.table !== 'string' || def.table === '') throw new TypeError('azora units: onChange() needs a table')
  const batch = def.batch ?? 100
  if (!Number.isInteger(batch) || batch < 1) throw new TypeError(`azora units: onChange(): batch ${batch} is not a positive integer`)
  const ops = def.ops ? [...def.ops] : ['insert', 'update', 'delete']
  for (const op of ops) if (op !== 'insert' && op !== 'update' && op !== 'delete') throw new TypeError(`azora units: onChange(): unknown op ${JSON.stringify(op)}`)
  const d = define('onChange', { internal: true, ...(def.description !== undefined && { description: def.description }), handler: def.handler })
  return Object.assign(d, { mode: def.mode ?? 'mutation', table: def.table, ops, batch }) as unknown as OnChangeDefinition<M>
}

/** Whether a unit name is valid: 1 to 64 letters, digits and `_`, starting with a letter. */
export function isUnitName(name: string): boolean {
  return NAME.test(name)
}

/** Whether x is a unit definition (what the helpers return). */
export function isUnitDefinition(x: unknown): x is UnitDefinition {
  return typeof x === 'object' && x !== null && (x as { '~azora'?: unknown })['~azora'] === 1
}
