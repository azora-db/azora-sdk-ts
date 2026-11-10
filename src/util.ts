/** Small helpers shared by the client's parts. */
import { ClosedError, TimeoutError } from './errors.ts'

/** Options every asynchronous call accepts. */
export interface CallOptions {
  /** Cancels the call (it rejects with the signal's reason). */
  signal?: AbortSignal
  /** Bounds the call, including waiting for a connection (default: the client's `requestTimeoutMs`; 0 disables it). */
  timeoutMs?: number
}

/** Resolves after ms, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal?.reason as Error)
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A wake-up that many waiters can await; `notify` wakes all of them. */
export class Notifier {
  private waiters: Array<() => void> = []

  notify(): void {
    if (this.waiters.length === 0) return
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w()
  }

  /** Resolves at the next `notify`; rejects with the signal's reason when it aborts first. */
  wait(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason as Error)
      const wake = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const i = this.waiters.indexOf(wake)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(signal?.reason as Error)
      }
      this.waiters.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** The lifetime of one call: its abort signal and the cleanup to run when it ends. */
export interface Scope {
  signal: AbortSignal
  done: () => void
}

/**
 * Builds the signal of one call: it aborts when the caller's signal does,
 * when the timeout passes (TimeoutError) or when the owner closes
 * (ClosedError).
 */
export function scope(owner: AbortSignal, defaultTimeoutMs: number, opts?: CallOptions): Scope {
  const ac = new AbortController()
  const cleanups: Array<() => void> = []
  const link = (src: AbortSignal | undefined, reason: () => unknown): void => {
    if (!src) return
    if (src.aborted) {
      ac.abort(reason())
      return
    }
    const on = (): void => ac.abort(reason())
    src.addEventListener('abort', on, { once: true })
    cleanups.push(() => src.removeEventListener('abort', on))
  }
  link(owner, () => new ClosedError())
  link(opts?.signal, () => opts?.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  const ms = opts?.timeoutMs ?? defaultTimeoutMs
  if (ms > 0 && !ac.signal.aborted) {
    const t = setTimeout(() => ac.abort(new TimeoutError(`azora: the call did not finish within ${ms} ms`)), ms)
    cleanups.push(() => clearTimeout(t))
  }
  return {
    signal: ac.signal,
    done: () => {
      for (const c of cleanups) c()
    },
  }
}

/** A random mutation id for exactly-once writes. */
export function newMutationId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  let s = 'm-'
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

/**
 * Reports whether the statement is a schema change: its first keyword,
 * after whitespace and comments, is CREATE, ALTER or DROP (the server's test).
 */
export function isDDL(sql: string): boolean {
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql.charCodeAt(i)
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 59) {
      i++
    } else if (sql.startsWith('--', i)) {
      while (i < n && sql.charCodeAt(i) !== 10) i++
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return false
      i = end + 2
    } else {
      let j = i
      while (j < n) {
        const l = sql.charCodeAt(j) | 0x20
        if (l < 97 || l > 122) break
        j++
      }
      const kw = sql.slice(i, j).toLowerCase()
      return kw === 'create' || kw === 'alter' || kw === 'drop'
    }
  }
  return false
}
