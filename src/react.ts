/**
 * React bindings: a provider for the connection and hooks for live
 * queries and reads that follow the tables they depend on.
 *
 * ```tsx
 * <AzoraProvider db={db}>
 *   <Orders />
 * </AzoraProvider>
 *
 * function Orders() {
 *   const { rows, ready, error } = useLiveQuery<Order>('orders', { where: "status = 'open'" })
 *   ...
 * }
 * ```
 *
 * @packageDocumentation
 */
import {
  createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react'
import type { InputValue } from './codec.ts'
import type { Database } from './database.ts'
import type { LiveOptions, LiveQuery } from './live.ts'
import type { Row, Statement } from './types.ts'
import type { UnitCallOptions } from './units.ts'

const Context = createContext<Database | null>(null)

/** Makes a connected {@link Database} available to the hooks below. */
export function AzoraProvider(props: { db: Database; children?: ReactNode }): ReactNode {
  return createElement(Context.Provider, { value: props.db }, props.children)
}

/**
 * The database given to the nearest {@link AzoraProvider}. Pass your
 * units module type to get a typed `db.units`: `useAzora<typeof import('./units')>()`.
 */
export function useAzora<M = unknown>(): Database<M> {
  const db = useContext(Context)
  if (!db) throw new Error('azora: useAzora needs an <AzoraProvider db={...}> above it')
  return db as Database<M>
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))
const valueKey = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x))

const EMPTY: readonly never[] = Object.freeze([])

/** What {@link useLiveQuery} returns. */
export interface LiveQueryState<T> {
  /** The rows, ordered; the array keeps its identity until a row changes. */
  rows: readonly T[]
  /** The first snapshot arrived. */
  ready: boolean
  /** Why the query stopped, if it failed. */
  error: Error | null
}

/**
 * Follows a table's rows live. The component re-renders after every
 * consistent step; `options` are compared by value, so they can be
 * written inline. Pass `enabled: false` to wait (for example until a
 * parameter is known).
 */
export function useLiveQuery<T = Row>(table: string, options: LiveOptions<T> & { enabled?: boolean } = {}): LiveQueryState<T> {
  const db = useAzora()
  const { enabled = true, map, orderBy, ...rest } = options
  // Functions cannot be compared by value: keep the latest in a ref.
  const fns = useRef({ map, orderBy })
  fns.current = { map, orderBy }
  const key = JSON.stringify([table, rest.where ?? null, rest.key ?? null, typeof orderBy === 'function' ? 'fn' : (orderBy ?? null)], (_k, v: unknown) =>
    typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v,
  )
  const [live, setLive] = useState<LiveQuery<T> | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let opened: LiveQuery<T> | null = null
    setError(null)
    const o: LiveOptions<T> = { ...rest }
    const { map: m, orderBy: ob } = fns.current
    if (m) o.map = (row) => (fns.current.map ?? m)(row)
    if (ob !== undefined) o.orderBy = ob
    db.live<T>(table, o).then(
      (l) => {
        if (cancelled) return void l.close()
        opened = l
        setLive(l)
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      },
    )
    return () => {
      cancelled = true
      setLive(null)
      void opened?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key, enabled])

  const subscribe = useMemo(() => (notify: () => void) => live?.subscribe(notify) ?? (() => {}), [live])
  const rows = useSyncExternalStore(
    subscribe,
    () => (live ? live.rows : (EMPTY as readonly T[])),
    () => EMPTY as readonly T[],
  )
  return { rows, ready: live !== null, error: error ?? live?.error ?? null }
}

/** What {@link useQuery} returns. */
export interface QueryState<T> {
  rows: T[] | undefined
  loading: boolean
  error: Error | null
  /** Runs the query again now. */
  refetch: () => void
}

/**
 * Runs a read and runs it again whenever one of `watch`'s tables is
 * written (any table, published or not). Use it for aggregates and joins
 * that a live query cannot express:
 *
 * ```tsx
 * const { rows } = useQuery<{ status: string; n: number }>(
 *   'SELECT status, count(*) AS n FROM orders GROUP BY status', [], { watch: ['orders'] })
 * ```
 */
export function useQuery<T = Row>(
  query: string | Statement,
  args: readonly InputValue[] = [],
  options: { watch?: readonly string[]; enabled?: boolean } = {},
): QueryState<T> {
  const db = useAzora()
  const { watch = [], enabled = true } = options
  const text = typeof query === 'string' ? query : query.sql
  const params = typeof query === 'string' ? args : (query.args ?? [])
  const key = JSON.stringify([text, params, watch], (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v))
  const [state, setState] = useState<{ rows: T[] | undefined; loading: boolean; error: Error | null }>({ rows: undefined, loading: enabled, error: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stop: (() => Promise<void>) | undefined
    let running = false
    let again = false
    const run = (): void => {
      if (running) {
        again = true // one more pass once the current one is back
        return
      }
      running = true
      setState((s) => ({ ...s, loading: true }))
      db.query<T>(text, params).then(
        (rows) => !cancelled && setState({ rows, loading: false, error: null }),
        (e: unknown) => !cancelled && setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e : new Error(String(e)) })),
      ).finally(() => {
        running = false
        if (again && !cancelled) {
          again = false
          run()
        }
      })
    }
    run()
    if (watch.length > 0) {
      db.watch(watch, run).then(
        (s) => {
          if (cancelled) void s()
          else stop = s
        },
        () => {},
      )
    }
    return () => {
      cancelled = true
      void stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key, enabled, tick])

  return { ...state, refetch: () => setTick((t) => t + 1) }
}

/** Whether the connection is up right now (re-renders when it changes). */
export function useConnected(pollMs = 500): boolean {
  const db = useAzora()
  const [connected, setConnected] = useState(db.connected)
  useEffect(() => {
    const t = setInterval(() => setConnected(db.connected), pollMs)
    return () => clearInterval(t)
  }, [db, pollMs])
  return connected
}

/** What {@link useUnit} returns. */
export interface UnitState<R, A> {
  /**
   * Calls the unit. It resolves with the result and rejects with the
   * error, which `error` also holds until the next call.
   */
  call: (args?: A, opts?: UnitCallOptions) => Promise<R>
  /** A call is in flight. */
  pending: boolean
  /** Why the last call failed (a `UnitError` when the unit threw). */
  error: Error | null
  /** The last call's result. */
  data: R | undefined
}

/**
 * Calls a unit on demand (a mutation from a form, for example):
 *
 * ```tsx
 * const checkout = useUnit<{ orderId: number }, { cartId: string }>('checkout')
 * <button disabled={checkout.pending} onClick={() => checkout.call({ cartId })}>Pay</button>
 * ```
 *
 * With several calls in flight, `data` and `error` follow the latest.
 * `UnitResult` and `UnitArgs` give the types from your units module.
 */
export function useUnit<R = unknown, A = any>(name: string): UnitState<R, A> {
  const db = useAzora()
  const [state, setState] = useState<{ pending: boolean; error: Error | null; data: R | undefined }>({ pending: false, error: null, data: undefined })
  const seq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const call = useCallback(
    async (args?: A, opts?: UnitCallOptions): Promise<R> => {
      const n = ++seq.current
      setState((s) => ({ ...s, pending: true, error: null }))
      try {
        const data = await db.call<R>(name, args, opts)
        if (mounted.current && n === seq.current) setState({ pending: false, error: null, data })
        return data
      } catch (e) {
        if (mounted.current && n === seq.current) setState((s) => ({ ...s, pending: false, error: toError(e) }))
        throw e
      }
    },
    [db, name],
  )
  return { call, ...state }
}

/** What {@link useUnitQuery} returns. */
export interface UnitQueryState<R> {
  data: R | undefined
  loading: boolean
  error: Error | null
  /** Calls the unit again now. */
  refetch: () => void
}

/**
 * Calls a unit (a query) and calls it again when `args` change (compared
 * by value), when one of `deps` changes, or when one of `options.watch`'s
 * tables is written:
 *
 * ```tsx
 * const { data: orders } = useUnitQuery<Order[]>('myOrders', {}, [], { watch: ['orders'] })
 * ```
 */
export function useUnitQuery<R = unknown, A = any>(
  name: string,
  args?: A,
  deps: readonly unknown[] = [],
  options: { watch?: readonly string[]; enabled?: boolean } = {},
): UnitQueryState<R> {
  const db = useAzora()
  const { watch = [], enabled = true } = options
  const key = valueKey([name, args === undefined ? '\u0000none' : args, deps, watch])
  const [state, setState] = useState<{ data: R | undefined; loading: boolean; error: Error | null }>({ data: undefined, loading: enabled, error: null })
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let stop: (() => Promise<void>) | undefined
    let running = false
    let again = false
    const run = (): void => {
      if (running) {
        again = true
        return
      }
      running = true
      setState((s) => ({ ...s, loading: true }))
      db.call<R>(name, args).then(
        (data) => !cancelled && setState({ data, loading: false, error: null }),
        (e: unknown) => !cancelled && setState((s) => ({ ...s, loading: false, error: toError(e) })),
      ).finally(() => {
        running = false
        if (again && !cancelled) {
          again = false
          run()
        }
      })
    }
    run()
    if (watch.length > 0) {
      db.watch(watch, run).then(
        (s) => {
          if (cancelled) void s()
          else stop = s
        },
        () => {},
      )
    }
    return () => {
      cancelled = true
      void stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key, enabled, tick])

  return { ...state, refetch: () => setTick((t) => t + 1) }
}
