/** One run of a unit: its transactions, statements, ctx and nested runs (host.go). */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ctxFetch } from './ctx-fetch.ts'
import { newStorage } from './ctx-storage.ts'
import type { TestEnvImpl } from './test-env.ts'
import { PendingUpload } from './files.ts'
import { engineStringify, parseJSON } from './json.ts'
import {
  base32,
  bytesArg,
  CODES,
  hex,
  MAX_JOB_DELAY,
  MAX_LOG_BYTES,
  MAX_RUN_DEPTH,
  type Answer,
  type Frame,
  type Hold,
  type Request,
} from './runtime.ts'
import { checkSQL, rowObject, sqlArg, TABLE_PREFIX, type Bound } from './sql.ts'
import type { TestLogLine } from './types.ts'
import { checkArgs, Failure, q, type Def } from './units.ts'

/** One run of a unit and everything nested in it (host.go's call). */
export class Call {
  stmts = 0
  rows = 0
  fetches = 0
  depth = 0
  logs = ''
  logFull = false
  limitErr: Failure | null = null
  open: Hold[] = []
  writeOpen = 0
  jobsPending: number | null = null

  readonly t: TestEnvImpl
  readonly req: Request
  readonly top: Def

  constructor(t: TestEnvImpl, req: Request, top: Def) {
    this.t = t
    this.req = req
    this.top = top
  }

  /** Raises an error in the unit, as the engine's host functions do. */
  throw(msg: string): never {
    throw new Error(msg)
  }

  limit(msg: string): never {
    this.limitErr ??= new Failure('resource_exhausted', `unit ${this.top.name}: ${msg}`)
    throw new Error(msg)
  }

  log(level: TestLogLine['level'], args: unknown[]): void {
    const message = args
      .map((a) => {
        if (a === undefined) return 'undefined'
        if (typeof a === 'string') return a
        if (typeof a === 'object' && a !== null) {
          const st = (a as { stack?: unknown }).stack
          if (typeof st === 'string') return st
          try {
            return engineStringify(a)
          } catch {
            return String(a)
          }
        }
        return String(a)
      })
      .join(' ')
    const line: TestLogLine = { at: this.t.clock, unit: this.top.name, level, message }
    this.t.logLines.push(line)
    this.t.o.onLog?.(line)
    if (this.logFull) return
    const text = `${level}: ${message}\n`
    if (Buffer.byteLength(this.logs) + Buffer.byteLength(text) > MAX_LOG_BYTES) {
      this.logs +=
        Buffer.from(text)
          .subarray(0, MAX_LOG_BYTES - Buffer.byteLength(this.logs))
          .toString() + '…\n'
      this.logFull = true
      return
    }
    this.logs += text
  }

  /** The thrown value as the caller sees it (host.go's unitError). */
  unitError(v: unknown): NonNullable<Answer['err']> {
    const ue = { code: 'failed', message: '', data: '', stack: '' }
    if (typeof v !== 'object' || v === null) {
      ue.message = v === undefined ? 'undefined' : String(v)
      return ue
    }
    const o = v as Record<string, unknown>
    const get = (k: string): string => (o[k] === undefined || o[k] === null ? '' : String(o[k]))
    ue.message = get('message') || String(v)
    ue.stack = get('stack')
    if (get('name') === 'UnitError') {
      ue.stack = '' // an answer, not a crash
      if (CODES.has(get('code'))) ue.code = get('code')
      if (o['data'] !== undefined) {
        try {
          const s = engineStringify(o['data'])
          if (Buffer.byteLength(s) <= this.t.limits.maxValueBytes) ue.data = s
        } catch {
          // data that is not JSON is left out
        }
      }
    }
    return ue
  }

  // Transactions on the env's one connection.

  hold(write: boolean): Hold {
    const db = this.t.raw
    const h: Hold = { write, ended: false, own: this.t.txOpen === 0 }
    if (h.own) {
      try {
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
        if (!write) db.exec('PRAGMA query_only = 1')
      } catch (e) {
        this.throw((e as Error).message)
      }
      this.t.txOpen++
    }
    this.open.push(h)
    if (write) this.writeOpen++
    return h
  }

  end(h: Hold, commit: boolean): void {
    if (h.ended) return
    h.ended = true
    if (h.write) this.writeOpen--
    if (!h.own) return
    this.t.txOpen--
    const db = this.t.raw
    if (!h.write) db.exec('PRAGMA query_only = 0')
    if (commit) {
      try {
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    } else db.exec('ROLLBACK')
  }

  /** Ends h when v (the callback's result) is known: now for a value, when it settles for a promise. */
  settle(h: Hold, v: unknown): unknown {
    const finish = (): void => {
      if (this.limitErr) {
        this.end(h, false)
        this.throw(this.limitErr.message)
      }
      try {
        this.end(h, true)
      } catch (e) {
        this.throw((e as Error).message)
      }
    }
    if (v instanceof Promise) {
      return v.then(
        (r: unknown) => {
          finish()
          return r
        },
        (e: unknown) => {
          this.end(h, false)
          throw e
        },
      )
    }
    finish()
    return v
  }

  cleanup(): void {
    for (const h of this.open) if (!h.ended) this.end(h, false)
  }

  // Statements.

  check(sql: string): void {
    const why = checkSQL(sql)
    if (why) this.throw(why)
    if (++this.stmts > this.t.limits.maxStatements)
      this.limit(`more than units.max_statements (${this.t.limits.maxStatements}) statements`)
  }

  sqlArgs(args: unknown[]): Array<Bound | PendingUpload> {
    return args.map((a, i) => {
      try {
        if (a instanceof PendingUpload) {
          if (a.used)
            throw new Error('this upload was already used: call ctx.storage.upload again for another statement')
          a.used = true
          return a
        }
        return sqlArg(a)
      } catch (e) {
        return this.throw(`argument ${i + 1}: ${(e as Error).message}`)
      }
    })
  }

  run<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      return this.throw((e as Error).message)
    }
  }

  withRead<T>(f: Frame, fn: () => T): T {
    if (f.tx || this.t.txOpen > 0) return this.run(fn)
    // A read of its own: on a read-only connection, as the engine's are.
    const db = this.t.raw
    db.exec('PRAGMA query_only = 1')
    try {
      return this.run(fn)
    } finally {
      db.exec('PRAGMA query_only = 0')
    }
  }

  withWrite<T>(f: Frame, fn: () => T): T {
    if (f.tx) {
      if (!f.write) this.throw('a query cannot write (make it a mutation)')
      return this.run(fn)
    }
    if (f.kind !== 'action') this.throw('no transaction')
    if (this.writeOpen > 0) this.throw('ctx.db.tx is open: use the db its callback receives')
    if (this.t.txOpen > 0) return this.run(fn)
    // An action outside ctx.db.tx: the write commits on its own.
    const db = this.t.raw
    db.exec('BEGIN IMMEDIATE')
    let ok = false
    try {
      const v = this.run(fn)
      ok = true
      return v
    } finally {
      db.exec(ok ? 'COMMIT' : 'ROLLBACK')
    }
  }

  query(f: Frame, sql: string, args: unknown[], max: number): Record<string, unknown>[] {
    this.check(sql)
    const vals = this.sqlArgs(args).map((v) =>
      v instanceof PendingUpload ? this.throw('an upload can only be the argument of a write (ctx.db.exec)') : v,
    )
    return this.withRead(f, () => {
      const st = this.t.raw.prepare(sql)
      st.setReadBigInts(true)
      const rows = max === 1 ? [st.get(...vals)].filter((r) => r !== undefined) : st.all(...vals)
      for (let i = 0; i < rows.length; i++) {
        if (++this.rows > this.t.limits.maxRows)
          this.limit(`read more than units.max_rows (${this.t.limits.maxRows}) rows`)
      }
      return rows.map((r) => rowObject(r as Record<string, unknown>))
    })
  }

  exec(sql: string, vals: Array<Bound | PendingUpload>): { rowsAffected: number; lastInsertId: number } {
    // An upload is stored in the statement's transaction and replaced by the new file's id.
    const bound = vals.map((v) => (v instanceof PendingUpload ? this.t.files.store(v).id : v))
    const r = this.t.raw.prepare(sql).run(...bound)
    return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
  }

  // ctx.

  newDB(f: Frame): Record<string, unknown> {
    const split = (a: unknown[]): [string, unknown[]] => {
      if (typeof a[0] !== 'string') this.throw('the first argument must be a SQL string')
      return [a[0] as string, a.slice(1)]
    }
    const db: Record<string, unknown> = {
      all: (...a: unknown[]) => this.query(f, ...split(a), 0),
      one: (...a: unknown[]) => this.query(f, ...split(a), 1)[0] ?? null,
      value: (...a: unknown[]) => {
        const r = this.query(f, ...split(a), 1)[0]
        if (!r) return null
        const k = Object.keys(r)[0]
        return k === undefined ? null : r[k]
      },
      exec: (...a: unknown[]) => {
        const [sql, args] = split(a)
        this.check(sql)
        const vals = this.sqlArgs(args)
        return this.withWrite(f, () => this.exec(sql, vals))
      },
      batch: (list: unknown) => {
        if (!Array.isArray(list) || !list.every((s) => Array.isArray(s)))
          this.throw('batch takes a list of [sql, ...args] lists')
        const prepared = (list as unknown[][]).map((s, i) => {
          if (typeof s[0] !== 'string') this.throw(`batch statement ${i + 1}: the first item must be a SQL string`)
          this.check(s[0] as string)
          return { sql: s[0] as string, vals: this.sqlArgs(s.slice(1)) }
        })
        return this.withWrite(f, () =>
          prepared.map((s, i) => {
            try {
              return this.exec(s.sql, s.vals)
            } catch (e) {
              throw new Error(`batch statement ${i + 1}: ${(e as Error).message}`)
            }
          }),
        )
      },
      tx: (fn: unknown) => this.tx(f, fn),
    }
    return db
  }

  /** ctx.storage (the engine's newStorage in files.go, with its messages). */
  newStorage(f: Frame): Record<string, unknown> {
    return newStorage(this, f)
  }

  tx(f: Frame, fn: unknown): unknown {
    if (typeof fn !== 'function') this.throw('ctx.db.tx takes a function')
    if (f.tx) return (fn as (db: unknown) => unknown)(this.newDB(f))
    if (this.writeOpen > 0) this.throw('ctx.db.tx is already open')
    const h = this.hold(true)
    const inner: Frame = { unit: f.unit, kind: 'mutation', tx: h, write: true }
    let v: unknown
    try {
      v = (fn as (db: unknown) => unknown)(this.newDB(inner))
    } catch (e) {
      this.end(h, false)
      throw e
    }
    return this.settle(h, v)
  }

  runUnit(f: Frame, nameArg: unknown, args: unknown): unknown {
    const name = String(nameArg)
    const u = this.t.units.get(name)
    if (!u) this.throw(`ctx.run: no unit ${q(name)}`)
    if (this.depth >= MAX_RUN_DEPTH) this.throw(`ctx.run: nested deeper than ${MAX_RUN_DEPTH}`)
    const kind = u.runs
    if (f.kind === 'query' && kind !== 'query')
      this.throw(`ctx.run: a query can only run queries (${name} is a ${kind})`)
    if (f.kind === 'mutation' && kind === 'action') this.throw(`ctx.run: a mutation cannot run an action (${name})`)
    const argsJSON = args === undefined ? '' : engineStringify(args)
    let checked: string
    try {
      checked = checkArgs(u, argsJSON)
    } catch (e) {
      return this.throw(`ctx.run: ${e instanceof Failure ? e.text : (e as Error).message}`)
    }
    const argv = parseJSON(checked)
    this.depth++
    try {
      const child: Frame = { unit: u, kind, tx: null, write: false }
      if (f.tx && kind !== 'action') {
        child.tx = f.tx
        child.write = f.write && kind === 'mutation'
      } else if (kind !== 'action') {
        // A query or a mutation from an action outside a transaction: its own.
        if (kind === 'mutation' && this.writeOpen > 0)
          this.throw(`ctx.run: ctx.db.tx is open; run ${name} from inside it`)
        const h = this.hold(kind === 'mutation')
        child.tx = h
        child.write = kind === 'mutation'
        let v: unknown
        try {
          v = u.handler.call(undefined, this.newCtx(child), argv)
        } catch (e) {
          this.end(h, false)
          throw e
        }
        return this.settle(h, v)
      }
      return u.handler.call(undefined, this.newCtx(child), argv)
    } finally {
      this.depth--
    }
  }

  newCtx(f: Frame): Record<string, unknown> {
    const t = this.t
    const cl = this.req.caller
    const job = this.req.job
    const env = Object.freeze(
      Object.fromEntries(
        Object.keys(t.secrets)
          .sort()
          .map((k) => [k, t.secrets[k]]),
      ),
    )
    const log = {
      info: (...a: unknown[]) => this.log('info', a),
      warn: (...a: unknown[]) => this.log('warn', a),
      error: (...a: unknown[]) => this.log('error', a),
      debug: (...a: unknown[]) => this.log('info', a),
    }
    return {
      db: this.newDB(f),
      auth: {
        kind: cl.kind,
        principal: cl.principal,
        subject: cl.subject,
        scopes: [...cl.scopes],
        tables: [...cl.tables],
        claims: JSON.parse(JSON.stringify(cl.claims)) as unknown,
        has: (scope: string) =>
          cl.kind === 'system' || cl.kind === 'admin' || cl.scopes.some((s) => s === scope || s === 'admin'),
      },
      run: (name: unknown, args: unknown) => this.runUnit(f, name, args),
      fetch: (input: unknown, init: unknown) => this.fetch(f, input, init),
      storage: this.newStorage(f),
      request: this.req.http
        ? {
            ...this.req.http,
            query: { ...this.req.http.query },
            headers: { ...this.req.http.headers },
            bytes: new Uint8Array(this.req.http.bytes),
          }
        : null,
      scheduler: {
        after: (delay: unknown, name: unknown, args: unknown) => {
          let ms = this.number('ctx.scheduler.after', delay)
          if (ms < 0) ms = 0
          if (ms > MAX_JOB_DELAY) this.throw('ctx.scheduler.after: a job can be at most 366 days ahead')
          return this.schedule(f, t.clock + Math.trunc(ms), name, args)
        },
        at: (when: unknown, name: unknown, args: unknown) => {
          const at = when instanceof Date ? when.getTime() : Math.trunc(this.number('ctx.scheduler.at', when))
          if (at > t.clock + MAX_JOB_DELAY) this.throw('ctx.scheduler.at: a job can be at most 366 days ahead')
          return this.schedule(f, at, name, args)
        },
        cancel: (id: unknown) => {
          this.jobWriter(f, 'ctx.scheduler.cancel')
          return this.withWrite(
            f,
            () =>
              Number(
                t.raw.prepare(`DELETE FROM ${TABLE_PREFIX}_jobs WHERE id = ? AND state = 'pending'`).run(String(id))
                  .changes,
              ) > 0,
          )
        },
      },
      env,
      log,
      now: () => t.clock,
      uuid: () => {
        const b = t.random(16)
        b[6] = (b[6]! & 0x0f) | 0x40
        b[8] = (b[8]! & 0x3f) | 0x80
        const h = hex(b)
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
      },
      crypto: {
        sha256: (data: unknown) => createHash('sha256').update(bytesArg(data)).digest('hex'),
        hmac: (key: unknown, data: unknown) => createHmac('sha256', bytesArg(key)).update(bytesArg(data)).digest('hex'),
        randomBytes: (n: unknown) => {
          const k = Math.trunc(Number(n))
          if (!(k >= 0 && k <= 65536)) this.throw('randomBytes: n must be in [0, 65536]')
          return new Uint8Array(t.random(k))
        },
        timingSafeEqual: (a: unknown, b: unknown) => {
          const x = bytesArg(a)
          const y = bytesArg(b)
          return x.length === y.length && timingSafeEqual(x, y)
        },
      },
      unit: {
        name: f.unit.name,
        kind: f.unit.kind,
        trigger: this.req.trigger,
        mutationId: this.req.mutationId,
        deploy: 1,
        job: job
          ? {
              id: job.id,
              attempt: job.attempts + 1,
              scheduledAt: job.created_at,
              scheduledBy: job.created_by,
              source: job.source,
            }
          : null,
      },
    }
  }

  number(what: string, v: unknown): number {
    const n = v === null || v === undefined ? NaN : Number(v)
    if (!Number.isFinite(n)) this.throw(`${what}: expected a number of milliseconds`)
    return n
  }

  jobWriter(f: Frame, what: string): void {
    if (f.kind === 'query' || (f.tx && !f.write))
      this.throw(`${what}: a query cannot schedule jobs (make it a mutation or an action)`)
  }

  schedule(f: Frame, atArg: number, nameArg: unknown, args: unknown): string {
    this.jobWriter(f, 'ctx.scheduler')
    if (nameArg === undefined) this.throw('ctx.scheduler: name the unit to run')
    const name = String(nameArg)
    const u = this.t.units.get(name)
    if (!u) this.throw(`ctx.scheduler: no unit ${q(name)}`)
    if (u.kind !== 'mutation' && u.kind !== 'action')
      this.throw(`ctx.scheduler: ${name} is a ${u.kind}; jobs run mutations and actions`)
    const argsJSON = args === undefined ? '' : engineStringify(args)
    if (Buffer.byteLength(argsJSON) > this.t.limits.maxValueBytes) {
      this.throw(
        `ctx.scheduler: arguments are ${Buffer.byteLength(argsJSON)} bytes, over units.max_value_bytes (${this.t.limits.maxValueBytes})`,
      )
    }
    let checked: string
    try {
      checked = checkArgs(u, argsJSON)
    } catch (e) {
      return this.throw(`ctx.scheduler: ${e instanceof Failure ? e.text : (e as Error).message}`)
    }
    if (++this.stmts > this.t.limits.maxStatements)
      this.limit(`more than units.max_statements (${this.t.limits.maxStatements}) statements`)
    const now = this.t.clock
    const at = Math.max(atArg, now)
    const id = 'job_' + base32(this.t.random(16))
    this.withWrite(f, () => {
      const db = this.t.raw
      this.jobsPending ??= Number(
        db.prepare(`SELECT count(*) AS n FROM ${TABLE_PREFIX}_jobs WHERE state = 'pending'`).get()!['n'],
      )
      if (this.jobsPending >= this.t.limits.maxJobs)
        this.limit(`more than units.max_jobs (${this.t.limits.maxJobs}) jobs are waiting`)
      db.prepare(
        `INSERT INTO ${TABLE_PREFIX}_jobs(id, unit, args, run_at, created_at, created_by, source, attempts, state, error) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', '')`,
      ).run(id, name, checked, at, now, this.req.caller.principal, f.unit.name)
      this.jobsPending++
    })
    return id
  }

  fetch(f: Frame, input: unknown, init: unknown): Promise<unknown> {
    return ctxFetch(this, f, input, init)
  }

  /** Runs the top frame's handler and returns its result as JSON, or what it threw. */
  async invoke(f: Frame, args: string): Promise<{ value: string; thrown: Answer['err'] }> {
    const argv = parseJSON(args)
    let v: unknown
    try {
      v = f.unit.handler.call(undefined, this.newCtx(f), argv)
      if (v instanceof Promise) v = await v
    } catch (e) {
      return { value: '', thrown: this.unitError(e) }
    }
    if (this.limitErr) throw this.limitErr
    let s: string
    try {
      s = engineStringify(v)
    } catch (e) {
      return { value: '', thrown: this.unitError(e) }
    }
    const n = Buffer.byteLength(s)
    if (n > this.t.limits.maxValueBytes) {
      throw new Failure(
        'resource_exhausted',
        `unit ${f.unit.name} returned ${n} bytes of JSON, over units.max_value_bytes (${this.t.limits.maxValueBytes})`,
      )
    }
    return { value: s, thrown: null }
  }
}
