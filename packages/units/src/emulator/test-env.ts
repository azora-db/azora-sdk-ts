/** The engine behind a test environment: runs, HTTP requests, triggers, jobs and the clock. */
import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { AzoraError, UnitError as CallError, type UnitJob, type UnitRun } from '@azora-db/client'
import type { HttpRequest } from '../ctx.ts'
import { Call } from './call.ts'
import { FILES_SCHEMA, FileStore } from './files.ts'
import { clientStringify, parseJSON } from './json.ts'
import {
  base32,
  hex,
  INTERNAL_SCHEMA,
  jobBackoff,
  openSqlite,
  type Answer,
  type Caller,
  type Frame,
  type JobRow,
  type Request,
} from './runtime.ts'
import { rowObject, sqlArg, TABLE_PREFIX, type Bound } from './sql.ts'
import type {
  TestCallOptions,
  TestChange,
  TestDb,
  TestEnv,
  TestEnvOptions,
  TestLogLine,
  TestRequest,
  TestResponse,
} from './types.ts'
import { allows, caller, checkArgs, Failure, load, q, SYSTEM, type Def } from './units.ts'

/** @internal The implementation behind {@link TestEnv}. */
export class TestEnvImpl {
  readonly raw: DatabaseSync
  readonly units: Map<string, Def>
  readonly secrets: Record<string, string>
  readonly auth: Caller
  readonly random: (n: number) => Uint8Array
  readonly limits: Required<NonNullable<TestEnvOptions['limits']>>
  readonly jobAttempts: number
  clock: number
  txOpen = 0
  logLines: TestLogLine[] = []
  runLog: UnitRun[] = []
  private seq = 0
  private changeSeq = 0
  private queue: Promise<unknown> = Promise.resolve()
  readonly db: TestDb
  readonly files: FileStore
  readonly unitsProxy: Record<string, (args?: unknown, opts?: TestCallOptions) => Promise<unknown>>

  readonly o: TestEnvOptions

  constructor(mod: Record<string, unknown>, o: TestEnvOptions) {
    this.o = o
    const { DatabaseSync } = openSqlite()
    this.units = load(mod)
    this.raw = new DatabaseSync(':memory:')
    this.raw.exec('PRAGMA foreign_keys = ON')
    for (const s of typeof o.schema === 'string' ? [o.schema] : (o.schema ?? [])) this.raw.exec(s)
    this.raw.exec(INTERNAL_SCHEMA)
    this.raw.exec(FILES_SCHEMA)
    for (const u of this.units.values()) {
      if (
        u.kind === 'onChange' &&
        !this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(u.table)
      ) {
        this.raw.close()
        throw new Error(
          `azora units: onChange unit ${u.name}: table ${q(u.table)} does not exist (create it in the schema option)`,
        )
      }
    }
    this.secrets = { ...o.env }
    this.auth = caller(o.auth)
    this.random = o.random ?? ((n) => new Uint8Array(cryptoRandomBytes(n)))
    this.clock = o.now === undefined ? Date.now() : o.now instanceof Date ? o.now.getTime() : o.now
    const l = o.limits ?? {}
    this.limits = {
      maxStatements: l.maxStatements ?? 10_000,
      maxRows: l.maxRows ?? 100_000,
      maxValueBytes: l.maxValueBytes ?? 1 << 20,
      maxFileBytes: l.maxFileBytes ?? 16 << 20,
      maxJobs: l.maxJobs ?? 100_000,
      fetchCalls: l.fetchCalls ?? 50,
      fetchBytes: l.fetchBytes ?? 5 << 20,
    }
    this.jobAttempts = o.jobAttempts ?? 5
    this.files = new FileStore(
      this.raw,
      () => 'obj_' + base32(this.random(16)),
      () => this.clock,
    )
    const raw = this.raw
    const read = (sql: string, args: unknown[]) => {
      const st = raw.prepare(sql)
      st.setReadBigInts(true)
      return st.all(...args.map(sqlArg)).map((r) => rowObject(r as Record<string, unknown>))
    }
    this.db = {
      raw,
      all: <T>(sql: string, ...args: unknown[]) => read(sql, args) as T[],
      one: <T>(sql: string, ...args: unknown[]) => (read(sql, args)[0] ?? null) as T | null,
      value: <T>(sql: string, ...args: unknown[]) => {
        const r = read(sql, args)[0]
        const k = r && Object.keys(r)[0]
        return (k === undefined || !r ? null : r[k]) as T | null
      },
      exec: (sql: string, ...args: unknown[]) => {
        const r = raw.prepare(sql).run(...args.map(sqlArg))
        return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
      },
    }
    this.unitsProxy = new Proxy({} as Record<string, (args?: unknown, opts?: TestCallOptions) => Promise<unknown>>, {
      get: (_t, name) =>
        typeof name !== 'string' || name === 'then'
          ? undefined
          : (args?: unknown, opts?: TestCallOptions) => this.call(name, args, opts),
    })
  }

  /** Runs fn after everything queued before it: one call at a time, as on one connection. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => undefined)
    return p
  }

  private record(c: Call, start: number, wall: number, status: string, error: string): void {
    this.runLog.push({
      id: ++this.seq,
      at: start,
      unit: c.top.name,
      kind: c.top.kind,
      trigger: c.req.trigger,
      principal: c.req.caller.principal,
      durationMs: Math.round((performance.now() - wall) * 1000) / 1000,
      status,
      error: error.slice(0, 8 << 10),
      logs: c.logs,
    })
  }

  /** Engine.Call: runs a unit in the transaction its kind asks for. */
  async exec(req: Request): Promise<Answer> {
    const u = this.units.get(req.unit)
    if (!u) throw new Failure('not_found', `no unit ${q(req.unit)}`)
    const start = this.clock
    const wall = performance.now()
    const c = new Call(this, req, u)
    const reject = (err: Failure): never => {
      this.record(c, start, wall, 'rejected', err.text)
      throw err
    }
    if (req.http) {
      if (u.http === '')
        reject(new Failure('not_found', `no unit ${q(req.unit)} is callable over HTTP (a unit declares http: true)`))
      if (u.http !== 'public' && req.caller.kind === 'public')
        reject(new Failure('permission_denied', `unit ${q(req.unit)} needs a credential`))
    }
    if (req.external && u.internal)
      reject(new Failure('permission_denied', `unit ${q(req.unit)} is internal: only other units can run it`))
    if (req.external && !allows(u, req.caller))
      reject(
        new Failure(
          'permission_denied',
          `unit ${q(req.unit)} needs the ${u.access} scope (declare access: "any" to let every credential call it)`,
        ),
      )
    const size = Buffer.byteLength(req.args)
    if (size > this.limits.maxValueBytes)
      reject(
        new Failure(
          'invalid',
          `arguments are ${size} bytes, over units.max_value_bytes (${this.limits.maxValueBytes})`,
        ),
      )
    if (Buffer.byteLength(req.mutationId) > 128) reject(new Failure('invalid', 'mutation id longer than 128 bytes'))
    let args = req.args
    if (!req.noValidate) {
      try {
        args = checkArgs(u, args)
      } catch (e) {
        reject(e as Failure)
      }
    }
    const kind = u.runs
    const top: Frame = { unit: u, kind, tx: null, write: kind === 'mutation' }
    let value = ''
    let replayed = false
    let thrown: Answer['err'] = null
    const stored = (): string | null => {
      if (req.mutationId === '') return null
      const r = this.raw.prepare(`SELECT result FROM ${TABLE_PREFIX}_results WHERE id = ?`).get(req.mutationId)
      return r ? String(r['result']) : null
    }
    const store = (): void => {
      if (req.mutationId !== '') {
        this.raw
          .prepare(`INSERT OR IGNORE INTO ${TABLE_PREFIX}_results(id, at, unit, result) VALUES (?, ?, ?, ?)`)
          .run(req.mutationId, this.clock, u.name, value)
      }
    }
    try {
      if (kind === 'query' || kind === 'mutation') {
        const h = c.hold(kind === 'mutation')
        top.tx = h
        let commit = false
        try {
          const prev = kind === 'mutation' ? stored() : null
          if (prev !== null) {
            value = prev
            replayed = true
          } else {
            ;({ value, thrown } = await c.invoke(top, args))
            if (!thrown && kind === 'mutation') {
              store()
              req.inTx?.()
            }
          }
          commit = !thrown
        } finally {
          c.end(h, commit)
        }
      } else {
        const prev = stored()
        if (prev !== null) {
          value = prev
          replayed = true
        } else {
          ;({ value, thrown } = await c.invoke(top, args))
          if (!thrown) {
            if (c.limitErr) throw c.limitErr
            if (req.mutationId !== '') {
              this.raw.exec('BEGIN IMMEDIATE')
              try {
                store()
                this.raw.exec('COMMIT')
              } catch (e) {
                this.raw.exec('ROLLBACK')
                throw e
              }
            }
            req.afterAction?.()
          }
        }
      }
      if (c.limitErr) throw c.limitErr
    } catch (e) {
      c.cleanup()
      this.record(c, start, wall, 'error', e instanceof Failure ? e.text : String(e))
      throw e
    }
    c.cleanup()
    if (replayed) this.record(c, start, wall, 'replayed', '')
    else if (thrown)
      this.record(
        c,
        start,
        wall,
        'error',
        `${thrown.code}: ${thrown.message}${thrown.stack ? `\n${thrown.stack}` : ''}`,
      )
    else this.record(c, start, wall, 'ok', '')
    return { value, replayed, err: thrown }
  }

  /** The answer as a client sees it: the result, or the client's UnitError / AzoraError. */
  private async answer(name: string, req: Promise<Answer>): Promise<unknown> {
    let a: Answer
    try {
      a = await req
    } catch (e) {
      if (e instanceof Failure) throw new AzoraError(e.code, e.message)
      throw e
    }
    if (a.err) {
      let data: unknown
      try {
        data = a.err.data === '' ? undefined : parseJSON(a.err.data)
      } catch {
        data = a.err.data
      }
      throw new CallError(name, a.err.code, a.err.message, data === null ? undefined : data)
    }
    return parseJSON(a.value)
  }

  call(name: string, args?: unknown, opts: TestCallOptions = {}): Promise<unknown> {
    const as = opts.as ?? 'client'
    const argsJSON = clientStringify(args)
    const mutationId = opts.mutationId ?? (as === 'client' ? 'm-' + hex(this.random(16)) : '')
    const who = as === 'admin' ? caller({ kind: 'admin', ...opts.auth }) : opts.auth ? caller(opts.auth) : this.auth
    const trigger = as === 'client' ? 'call' : as
    return this.serial(() =>
      this.answer(
        name,
        this.exec({ unit: name, args: argsJSON, mutationId, caller: who, external: as === 'client', trigger }),
      ),
    )
  }

  /**
   * A request to /units/v1/<database>/<unit>, answered as the server's
   * handler does (pkg/azora/unitshttp): the JSON body or the query are the
   * arguments, the unit's result or what it threw becomes the response.
   */
  request(name: string, init: TestRequest = {}): Promise<TestResponse> {
    const method = (init.method ?? (init.body === undefined ? 'GET' : 'POST')).toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    let bytes = new Uint8Array()
    if (typeof init.body === 'string') bytes = new TextEncoder().encode(init.body)
    else if (init.body instanceof Uint8Array) bytes = new Uint8Array(init.body)
    else if (init.body !== undefined && init.body !== null) {
      bytes = new TextEncoder().encode(JSON.stringify(init.body))
      headers['content-type'] ??= 'application/json'
    }
    const text = new TextDecoder().decode(bytes)
    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.query ?? {})) query[k] = String(v)
    const respond = (
      status: number,
      body: Uint8Array | string,
      type: string,
      extra: Record<string, string> = {},
    ): TestResponse => {
      const b = typeof body === 'string' ? new TextEncoder().encode(body) : body
      const hd: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(type && { 'content-type': type }),
        ...extra,
      }
      const out = method === 'HEAD' || status === 204 || status === 304 ? new Uint8Array() : b
      return {
        status,
        headers: hd,
        body: new TextDecoder().decode(out),
        bytes: out,
        json: () => JSON.parse(new TextDecoder().decode(out)) as unknown,
      }
    }
    const error = (status: number, code: string, message: string, data?: string): TestResponse =>
      // As the server writes its error answers: with a charset and a final newline.
      respond(
        status,
        JSON.stringify({
          error: {
            code,
            message,
            ...(data !== undefined && data !== '' && data !== 'null' && { data: JSON.parse(data) as unknown }),
          },
        }) + '\n',
        'application/json; charset=utf-8',
      )
    // The arguments: a JSON body, or without a body the query as an object of strings.
    let args = ''
    if (text.trim() !== '') {
      const ct = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (ct === 'application/json' || ct.endsWith('+json')) {
        try {
          JSON.parse(text)
        } catch {
          return Promise.resolve(error(400, 'invalid', 'the request body is declared as JSON and is not valid JSON'))
        }
        args = text
      }
    } else if (Object.keys(query).length > 0) args = JSON.stringify(query)
    if (bytes.length > this.limits.maxValueBytes) {
      return Promise.resolve(
        error(413, 'too_large', `the request body is larger than units.max_value_bytes (${this.limits.maxValueBytes})`),
      )
    }
    const ip = init.ip ?? '127.0.0.1'
    const who: Caller = init.auth
      ? caller(init.auth)
      : { kind: 'public', principal: `http:${ip}`, subject: '', scopes: [], tables: [], claims: {} }
    const mutationId = headers['idempotency-key'] ?? ''
    const http: HttpRequest = { method, path: init.path ?? '', query, headers, body: text, bytes, ip }
    delete http.headers['authorization']
    const STATUS: Record<string, number> = {
      invalid: 400,
      not_found: 404,
      permission_denied: 403,
      conflict: 409,
      resource_exhausted: 429,
    }
    return this.serial(async () => {
      let a: Answer
      try {
        a = await this.exec({ unit: name, args, mutationId, caller: who, external: true, trigger: 'http', http })
      } catch (e) {
        if (!(e instanceof Failure)) throw e
        if (who.kind === 'public' && e.code === 'permission_denied') {
          return error(
            401,
            'unauthenticated',
            'this unit needs a credential: send Authorization: Bearer with an API key or a token',
          )
        }
        return error(STATUS[e.code] ?? 500, e.code, e.message)
      }
      const replayed: Record<string, string> = a.replayed ? { 'azora-replayed': 'true' } : {}
      if (a.err)
        return {
          ...error(STATUS[a.err.code] ?? 500, a.err.code, a.err.message, a.err.data),
          headers: { ...error(500, '', '').headers, ...replayed },
        }
      const value = a.value === '' ? 'null' : a.value
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>)['~http'] !== 1)
        return respond(200, value, 'application/json', replayed)
      // The unit described its own response (httpResponse).
      const r = parsed as { status?: number; headers?: Record<string, string>; body?: unknown }
      const status = r.status ?? 200
      if (!Number.isInteger(status) || status < 200 || status > 599)
        return error(500, 'internal', 'the unit answered with an invalid HTTP status')
      const hd: Record<string, string> = { ...replayed }
      for (const [k, v] of Object.entries(r.headers ?? {})) hd[k.toLowerCase()] = v
      const b = r.body
      let out: Uint8Array | string = ''
      let type = ''
      if (typeof b === 'string') [out, type] = [b, 'text/plain; charset=utf-8']
      else if (typeof b === 'object' && b !== null && typeof (b as { $bytes?: unknown }).$bytes === 'string') {
        ;[out, type] = [
          new Uint8Array(Buffer.from((b as { $bytes: string }).$bytes, 'base64')),
          'application/octet-stream',
        ]
      } else if (b !== null && b !== undefined) [out, type] = [JSON.stringify(b), 'application/json']
      return respond(status, out, hd['content-type'] ?? type, hd)
    })
  }

  private trigger(name: string, kind: 'schedule' | 'onChange'): Def {
    const u = this.units.get(name)
    if (!u) throw new Error(`azora units: no unit ${q(name)}`)
    if (u.kind !== kind)
      throw new Error(
        `azora units: ${name} is ${u.kind === 'onChange' || u.kind === 'action' ? 'an' : 'a'} ${u.kind}, not ${kind === 'schedule' ? 'a schedule' : 'an onChange'} unit`,
      )
    return u
  }

  async runSchedule(name: string): Promise<void> {
    this.trigger(name, 'schedule')
    return this.serial(async () => {
      await this.answer(
        name,
        this.exec({
          unit: name,
          args: '',
          mutationId: '',
          caller: SYSTEM,
          external: false,
          trigger: 'schedule',
          noValidate: true,
        }),
      )
    })
  }

  async change(name: string, changes: readonly TestChange[], o: { gap?: boolean } = {}): Promise<void> {
    const u = this.trigger(name, 'onChange')
    const pk = (
      this.raw.prepare(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).all(u.table) as {
        name: string
      }[]
    ).map((r) => r.name)
    const list = changes
      .map((c) => {
        const row = c.new ?? c.old ?? {}
        return {
          seq: c.seq ?? ++this.changeSeq,
          op: c.op,
          key: c.key ?? Object.fromEntries(pk.map((k) => [k, row[k] ?? null])),
          old: c.op === 'insert' ? null : (c.old ?? null),
          new: c.op === 'delete' ? null : (c.new ?? null),
        }
      })
      .filter((c) => u.ops.includes(c.op))
    return this.serial(async () => {
      for (let i = 0; i < list.length; i += u.batch) {
        const args = clientStringify({ changes: list.slice(i, i + u.batch), gap: o.gap ?? false })
        await this.answer(
          name,
          this.exec({
            unit: name,
            args,
            mutationId: '',
            caller: SYSTEM,
            external: false,
            trigger: 'change',
            noValidate: true,
          }),
        )
      }
    })
  }

  // Jobs.

  private jobRows(where = '1 = 1', ...args: Bound[]): JobRow[] {
    const st = this.raw.prepare(`SELECT * FROM ${TABLE_PREFIX}_jobs WHERE ${where} ORDER BY state DESC, run_at, id`)
    return st.all(...args) as unknown as JobRow[]
  }

  jobs(f: { state?: 'pending' | 'failed'; unit?: string } = {}): UnitJob[] {
    return this.jobRows()
      .filter((j) => (f.state === undefined || j.state === f.state) && (f.unit === undefined || j.unit === f.unit))
      .map((j) => ({
        id: j.id,
        unit: j.unit,
        args: j.args === '' ? undefined : parseJSON(j.args),
        runAt: j.run_at,
        createdAt: j.created_at,
        createdBy: j.created_by,
        source: j.source,
        attempts: j.attempts,
        state: j.state,
        error: j.error,
      }))
  }

  private writeTx(fn: () => void): void {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.raw.exec('COMMIT')
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  private deleteJob(id: string): boolean {
    return Number(this.raw.prepare(`DELETE FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).run(id).changes) > 0
  }

  /** runJob of pkg/azora/units_jobs.go. */
  private async runJob(j: JobRow): Promise<void> {
    let err: string | null = null
    let gone = false
    try {
      const a = await this.exec({
        unit: j.unit,
        args: j.args,
        mutationId: j.id,
        trigger: 'job',
        job: j,
        external: false,
        caller: { kind: 'system', principal: `job:${j.id}`, subject: '', scopes: [], tables: [], claims: {} },
        inTx: () => void this.deleteJob(j.id),
        afterAction: () => this.writeTx(() => void this.deleteJob(j.id)),
      })
      if (!a.err) {
        if (a.replayed) this.writeTx(() => void this.deleteJob(j.id))
        return
      }
      err = `${a.err.code}: ${a.err.message}`
    } catch (e) {
      if (!(e instanceof Failure)) throw e
      err = e.text
      gone = e.code === 'not_found'
    }
    const now = this.clock
    this.writeTx(() => {
      const cur = this.raw.prepare(`SELECT attempts FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).get(j.id)
      if (!cur) return
      const attempts = Number(cur['attempts']) + 1
      const failed = attempts >= (gone ? 1 : this.jobAttempts)
      // A failed job's run_at is when it failed; a pending one's when it runs again.
      this.raw
        .prepare(`UPDATE ${TABLE_PREFIX}_jobs SET attempts = ?, state = ?, error = ?, run_at = ? WHERE id = ?`)
        .run(
          attempts,
          failed ? 'failed' : 'pending',
          err.slice(0, 8 << 10),
          failed ? now : now + jobBackoff(j.attempts + 1),
          j.id,
        )
    })
  }

  /** Runs the jobs due now, in rounds (jobs they schedule for now run too); reports how many ran and whether it stopped early. */
  private async due(): Promise<{ ran: number; capped: boolean }> {
    let ran = 0
    for (let round = 0; round < 100; round++) {
      const list = this.jobRows("state = 'pending' AND run_at <= ?", this.clock).slice(0, 64)
      if (list.length === 0) return { ran, capped: false }
      for (const j of list) {
        await this.runJob(j)
        ran++
      }
    }
    return { ran, capped: true }
  }

  private nextDue(): number | null {
    const r = this.raw.prepare(`SELECT min(run_at) AS at FROM ${TABLE_PREFIX}_jobs WHERE state = 'pending'`).get()
    return r?.['at'] == null ? null : Number(r['at'])
  }

  runJobs(): Promise<number> {
    return this.serial(async () => {
      const r = await this.due()
      if (r.capped) throw new Error('azora units: jobs keep scheduling jobs due now: stopped after 100 rounds')
      return r.ran
    })
  }

  advance(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ms must be a non-negative number, not ${ms}`)
    return this.serial(async () => {
      const target = this.clock + ms
      let ran = 0
      for (;;) {
        const next = this.nextDue()
        if (next === null || next > target) break
        if (next > this.clock) this.clock = next
        const r = await this.due()
        ran += r.ran
        if (r.capped) throw new Error('azora units: jobs keep scheduling jobs due now: stopped after 100 rounds')
      }
      this.clock = Math.max(this.clock, target)
      return ran
    })
  }

  cancelJob(id: string): boolean {
    return this.deleteJob(id)
  }

  retryJob(id: string): void {
    const r = this.raw
      .prepare(
        `UPDATE ${TABLE_PREFIX}_jobs SET state = 'pending', attempts = 0, error = '', run_at = ? WHERE id = ? AND state = 'failed'`,
      )
      .run(this.clock, id)
    if (Number(r.changes) > 0) return
    const j = this.raw.prepare(`SELECT state FROM ${TABLE_PREFIX}_jobs WHERE id = ?`).get(id)
    if (!j) throw new AzoraError('not_found', `no job ${q(id)}`)
    throw new AzoraError('invalid', `job ${id} is ${String(j['state'])}, not failed`)
  }
}
