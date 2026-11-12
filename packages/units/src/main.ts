/**
 * The azora-units commands (cli.ts runs them): publish and operate the
 * units of an Azora database. Reads AZORA_URL and AZORA_TOKEN from the
 * environment or `.env`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  AzoraError, ConnectionError, connect, ErrorCode, TimeoutError, UnitError, type UnitInfo, type UnitJob, type UnitJobList, type UnitRun, type UnitsAdmin,
} from '@azora-db/client'
import { BundleError, bundleUnits, evaluateBundle, findEntry, manifestOf, type Bundle } from './bundle.ts'
import { EnvError, loadEnv } from './env.ts'
import { generateGo, goPackage } from './gogen.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const USAGE = `azora-units: publish and operate the units of an Azora database

Usage: azora-units <command> [options]

Commands:
  publish [dir]               bundle the units directory (default: units) and publish it
      --dry-run               check the bundle on the server without publishing it
      --note <text>           a note for the deploy history
  dev [dir]                   publish, then publish again on every save
  list                        the active deploy's units
  history [--limit n]         the deploy history
  rollback <version>          make an earlier deploy active again
  call <unit> [json]          call a unit (internal ones too) and print its result
  logs [--follow] [--unit name] [--status s] [--limit n]
                              the run log, oldest first; --follow keeps printing new runs;
                              --status is ok, error, replayed or rejected
  jobs [--state pending|failed] [--unit name] [--limit n]
                              jobs scheduled with ctx.scheduler: waiting, then failed
  jobs cancel <id>            remove a job (waiting or failed)
  jobs retry <id>             run a failed job again now
  secrets list                secret names (values are never shown)
  secrets set <name> [value]  set a secret; without a value it is read from stdin
  secrets unset <name>
  types --go <dir> [--package name] [--remote] [units dir]
                              generate Go argument types and typed wrappers (azora.Call)
                              from the units' schemas; --remote reads the published deploy

Options:
  --env-file <path>           read AZORA_URL and AZORA_TOKEN from this file (default: .env, when present)
  --json                      print JSON
  -v, --version
  -h, --help

Publishing and the other commands need an API key with the ddl scope.`

/** Where the CLI writes and reads. */
export interface IO {
  out(line: string): void
  err(line: string): void
  /** All of stdin (piped), or one line typed at the terminal. */
  readSecret(prompt: string): Promise<string>
}

/** What the commands need of a connection. */
export interface Conn {
  unitsAdmin: UnitsAdmin
  close(): Promise<void>
}

export type Connector = (envFile: string | undefined) => Promise<Conn>

/** A usage error: exit code 2. */
class UsageError extends Error {}

const defaultIO: IO = {
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
  async readSecret(prompt) {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(prompt)
      } finally {
        rl.close()
      }
    }
    let s = ''
    for await (const chunk of process.stdin) s += String(chunk)
    return s.replace(/\r?\n$/, '')
  },
}

const defaultConnector: Connector = async (envFile) => {
  const env = loadEnv(envFile)
  return connect(env.url, { token: env.token, clientName: `azora-units/${VERSION}` })
}

// Formatting.

function time(ms: number | undefined): string {
  if (!ms) return '-'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function table(rows: string[][]): string[] {
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ').trimEnd())
}

/** A path for messages: relative to the current directory when under it. */
function show(p: string): string {
  const r = relative(process.cwd(), p)
  return r === '' ? '.' : r.startsWith('..') ? p : r
}

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} kB` : `${(n / (1 << 20)).toFixed(1)} MB`
}

function trigger(u: UnitInfo): string {
  if (u.kind === 'schedule') return `${u.cron ? `cron ${u.cron}` : `every ${u.every}`}${u.mode === 'action' ? ' (action)' : ''}`
  if (u.kind === 'onChange') return `on ${u.table} ${(u.ops ?? []).join(',')}${u.mode === 'action' ? ' (action)' : ''}`
  return u.internal ? 'internal' : ''
}

function unitLines(units: readonly UnitInfo[]): string[] {
  return table(units.map((u) => ['  ' + u.kind, u.name, trigger(u), u.description]))
}

/** JSON with blobs back in their {"$bytes"} form. */
function json(v: unknown, indent = 2): string {
  return (
    JSON.stringify(
      v,
      (_k, x: unknown) => (x instanceof Uint8Array ? { $bytes: Buffer.from(x).toString('base64') } : typeof x === 'bigint' ? Number(x) : x),
      indent,
    ) ?? 'undefined'
  )
}

function ms(n: number | undefined): string {
  const x = n ?? 0
  return `${x >= 10 || Number.isInteger(x) ? Math.round(x) : x.toFixed(1)} ms`
}

function logLines(logs: unknown): string[] {
  if (logs == null || logs === '') return []
  if (typeof logs === 'string') return logs.replace(/\n$/, '').split('\n')
  if (!Array.isArray(logs)) return [json(logs, 0)]
  return logs.map((l) => {
    if (typeof l === 'string') return l
    if (typeof l === 'object' && l !== null) {
      const o = l as { level?: unknown; message?: unknown; msg?: unknown; args?: unknown }
      const text = o.message ?? o.msg ?? (Array.isArray(o.args) ? o.args.map((a) => (typeof a === 'string' ? a : json(a, 0))).join(' ') : undefined)
      if (text !== undefined) return `${o.level ? `${String(o.level)} ` : ''}${typeof text === 'string' ? text : json(text, 0)}`
    }
    return json(l, 0)
  })
}

function runLines(r: UnitRun): string[] {
  const out = [`${time(r.at)}  ${String(r.status).padEnd(8)}  ${r.unit}  ${r.trigger}  ${r.principal}  ${ms(r.durationMs)}`]
  // A rejected call never ran: the caller's mistake, not the unit's.
  if (r.error) out.push(`    ${r.status === 'rejected' ? 'rejected' : 'error'}: ${r.error}`)
  for (const l of logLines(r.logs)) out.push(`    ${l}`)
  return out
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function jobLines(r: UnitJobList): string[] {
  const head = `${r.pending} waiting, ${r.failed} failed${r.jobs.length < r.pending + r.failed ? ` (${r.jobs.length} shown)` : ''}`
  if (r.jobs.length === 0) return [r.pending + r.failed === 0 ? 'No jobs.' : `${head}; none match.`]
  const rows = [['  ID', 'UNIT', 'STATE', 'WHEN', 'ATTEMPTS', 'FROM', 'ARGS']]
  const errors = new Map<number, string>()
  r.jobs.forEach((j: UnitJob, i) => {
    // A waiting job's time is when it is due, a failed job's when it failed.
    const when = `${j.state === 'failed' ? 'failed' : 'due'} ${time(j.runAt)}`
    rows.push([`  ${j.id}`, j.unit, j.state, when, String(j.attempts), `${j.source} (${j.createdBy})`, j.args === undefined ? '' : clip(json(j.args, 0), 40)])
    if (j.error) errors.set(i + 1, j.error)
  })
  const out = [`${head}:`]
  table(rows).forEach((l, i) => {
    out.push(l)
    const e = errors.get(i)
    if (e) out.push(`      error: ${e.split('\n')[0]}`)
  })
  return out
}

/** A message for an error, with what to do about it. */
export function describe(e: unknown): string {
  if (e instanceof EnvError || e instanceof BundleError || e instanceof UsageError) return e.message
  if (e instanceof UnitError) {
    return `unit ${e.unit} threw ${e.code}: ${e.message}${e.data !== undefined ? `\ndata: ${json(e.data)}` : ''}`
  }
  if (e instanceof AzoraError) {
    if (e.code === ErrorCode.PermissionDenied) {
      return `${e.message}\nManaging units needs an API key with the ddl (or admin) scope: check AZORA_TOKEN (\`azora meta key create <db> --name <name> --scope read,write,ddl\`).`
    }
    if (e.code === ErrorCode.Unauthenticated) return `${e.message}\nThe server refused AZORA_TOKEN: is it a valid API key for this database?`
    return e.message
  }
  if (e instanceof ConnectionError || e instanceof TimeoutError) return `cannot reach the database: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

// Commands.

interface Flags {
  json: boolean
  'env-file'?: string
  'dry-run': boolean
  note?: string
  follow: boolean
  unit?: string
  status?: string
  state?: string
  limit?: string
  go?: string
  package?: string
  remote: boolean
  interval?: string
}

function int(s: string | undefined, what: string, dflt: number): number {
  if (s === undefined) return dflt
  const n = Number(s)
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${what} must be a non-negative integer, not ${JSON.stringify(s)}`)
  return n
}

async function deploy(db: Conn, b: Bundle, f: Flags) {
  return db.unitsAdmin.deploy({
    bundle: b.bundle,
    ...(b.sourceMap !== '' && { sourceMap: b.sourceMap }),
    ...(f.note !== undefined && { note: f.note }),
    ...(f['dry-run'] && { dryRun: true }),
  })
}

function deployLines(r: Awaited<ReturnType<typeof deploy>>, b: Bundle): string[] {
  const n = `${r.units.length} unit${r.units.length === 1 ? '' : 's'}`
  const head = r.dryRun
    ? `Dry run: the bundle (${size(b.bundle.length)}) is valid; publishing it would deploy ${n}:`
    : r.unchanged
      ? `Unchanged: version ${r.version} is already active with this bundle (${n}).`
      : `Published version ${r.version} (${size(b.bundle.length)}, sha256 ${r.sha256.slice(0, 12)}) with ${n}:`
  return r.unchanged && !r.dryRun ? [head] : [head, ...unitLines(r.units)]
}

async function publish(dir: string, f: Flags, io: IO, connector: Connector): Promise<void> {
  const b = await bundleUnits(dir) // before connecting: a broken bundle needs no network
  const db = await connector(f['env-file'])
  try {
    const r = await deploy(db, b, f)
    if (f.json) io.out(json(r))
    else for (const l of deployLines(r, b)) io.out(l)
  } finally {
    await db.close()
  }
}

async function dev(dir: string, f: Flags, io: IO, connector: Connector): Promise<void> {
  const abs = resolve(dir)
  findEntry(abs) // a missing directory fails now, not in the watcher
  const db = await connector(f['env-file'])
  const watchers = new Map<string, FSWatcher>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  const now = (): string => new Date().toTimeString().slice(0, 8)
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => void once(), 150)
  }
  // Files the bundle imports from outside the directory are watched too.
  const follow = (inputs: readonly string[]): void => {
    const want = new Set(inputs.filter((p) => !p.startsWith(abs + sep) && !p.includes(`${sep}node_modules${sep}`)))
    for (const [p, w] of watchers) if (p !== abs && !want.has(p)) (w.close(), watchers.delete(p))
    for (const p of want) if (!watchers.has(p) && existsSync(p)) watchers.set(p, watch(p, schedule))
  }
  const once = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const b = await bundleUnits(abs)
      follow(b.inputs)
      const r = await deploy(db, b, f)
      if (f.json) io.out(json({ at: Date.now(), ...r }, 0))
      else {
        const what = r.unchanged ? `unchanged (version ${r.version})` : `published version ${r.version}`
        io.out(`${now()} ${what}: ${r.units.map((u) => u.name).join(', ') || 'no units'}`)
      }
    } catch (e) {
      io.err(`${now()} ${describe(e)}`)
    } finally {
      running = false
      if (again) {
        again = false
        void once()
      }
    }
  }
  watchers.set(abs, watch(abs, { recursive: true }, (_ev, name) => {
    if (!name || !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(name))) schedule()
  }))
  if (!f.json) io.out(`Watching ${show(abs)}: every save publishes again. Ctrl+C stops.`)
  await once()
  await new Promise<void>((done) => {
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
  clearTimeout(timer)
  for (const w of watchers.values()) w.close()
  await db.close()
}

async function withDb<T>(f: Flags, connector: Connector, run: (a: UnitsAdmin) => Promise<T>): Promise<T> {
  const db = await connector(f['env-file'])
  try {
    return await run(db.unitsAdmin)
  } finally {
    await db.close()
  }
}

async function logs(f: Flags, io: IO, connector: Connector): Promise<void> {
  const limit = int(f.limit, '--limit', 20)
  const interval = int(f.interval, '--interval', 1000)
  const statuses = ['ok', 'error', 'replayed', 'rejected'] as const
  const status = f.status as (typeof statuses)[number] | undefined
  if (status !== undefined && !statuses.includes(status)) throw new UsageError(`--status must be one of ${statuses.join(', ')}, not ${JSON.stringify(f.status)}`)
  const q = { limit, ...(f.unit !== undefined && { unit: f.unit }), ...(status !== undefined && { status }) }
  await withDb(f, connector, async (a) => {
    let last = 0 // the newest run id printed
    const print = (runs: UnitRun[]): void => {
      for (const r of [...runs].reverse()) {
        if (r.id <= last) continue
        last = r.id
        if (f.json) io.out(json(r, 0))
        else for (const l of runLines(r)) io.out(l)
      }
    }
    print(await a.runs(q))
    if (!f.follow) return
    let stop = false
    const onSignal = (): void => {
      stop = true
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      while (!stop) {
        await new Promise((r) => setTimeout(r, interval))
        if (stop) break
        try {
          print(await a.runs({ ...q, limit: 100, ...(last > 0 && { after: last }) }))
        } catch (e) {
          io.err(describe(e))
        }
      }
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  })
}

async function types(pos: string[], f: Flags, io: IO, connector: Connector): Promise<void> {
  if (!f.go) throw new UsageError('types needs --go <dir> (the only target so far)')
  let units: UnitInfo[]
  let source: string
  if (f.remote) {
    const r = await withDb(f, connector, (a) => a.list())
    if (r.version === 0) throw new UsageError('nothing is published yet: publish first, or leave out --remote to read the local units')
    units = r.units
    source = `deploy version ${r.version}`
  } else {
    const dir = pos[0] ?? 'units'
    const b = await bundleUnits(dir)
    units = manifestOf(evaluateBundle(b.bundle)) as UnitInfo[]
    source = show(b.dir)
  }
  const outDir = resolve(f.go)
  const pkg = f.package ?? goPackage(basename(outDir))
  let src = generateGo(units, { package: pkg, source })
  const fmt = spawnSync('gofmt', [], { input: src, encoding: 'utf8' })
  if (fmt.status === 0 && fmt.stdout) src = fmt.stdout
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'units.go')
  writeFileSync(file, src)
  const n = units.filter((u) => ['query', 'mutation', 'action'].includes(u.kind) && !u.internal).length
  if (f.json) io.out(json({ file, package: pkg, units: n }))
  else io.out(`Wrote ${show(file)} (package ${pkg}, ${n} unit${n === 1 ? '' : 's'}).`)
}

/** Runs the CLI with argv (without node and the script) and returns the exit code. */
export async function main(argv: string[], io: IO = defaultIO, connector: Connector = defaultConnector): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        'env-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        note: { type: 'string' },
        follow: { type: 'boolean', short: 'f', default: false },
        unit: { type: 'string' },
        status: { type: 'string' },
        state: { type: 'string' },
        limit: { type: 'string' },
        interval: { type: 'string' },
        go: { type: 'string' },
        package: { type: 'string' },
        remote: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
  } catch (e) {
    io.err(`azora-units: ${(e as Error).message}\nRun azora-units --help for the commands and options.`)
    return 2
  }
  const f = parsed.values as Flags & { help: boolean; version: boolean }
  const [cmd, ...pos] = parsed.positionals
  if (f.version) {
    io.out(VERSION)
    return 0
  }
  if (f.help || !cmd) {
    ;(cmd || f.help ? io.out : io.err)(USAGE)
    return f.help ? 0 : 2
  }
  const need = (n: number, usage: string): void => {
    if (pos.length < n) throw new UsageError(`usage: azora-units ${usage}`)
  }
  try {
    switch (cmd) {
      case 'publish':
        await publish(pos[0] ?? 'units', f, io, connector)
        break
      case 'dev':
        await dev(pos[0] ?? 'units', f, io, connector)
        break
      case 'list': {
        const r = await withDb(f, connector, (a) => a.list())
        if (f.json) io.out(json(r))
        else if (r.version === 0) io.out('Nothing is published yet: azora-units publish')
        else {
          io.out(`Version ${r.version} is active, with ${r.units.length} unit${r.units.length === 1 ? '' : 's'}:`)
          for (const l of unitLines(r.units)) io.out(l)
        }
        break
      }
      case 'history': {
        const r = await withDb(f, connector, (a) => a.deploys({ limit: int(f.limit, '--limit', 20) }))
        if (f.json) io.out(json(r))
        else if (r.deploys.length === 0) io.out('Nothing is published yet: azora-units publish')
        else {
          const rows = [['  VERSION', 'AT', 'BY', 'UNITS', 'SHA256', 'NOTE']]
          for (const d of r.deploys) {
            const n = Array.isArray(d.units) ? d.units.length : d.units
            rows.push([`${d.active || d.version === r.active ? '*' : ' '} ${d.version}`, time(d.at), d.by, String(n ?? ''), (d.sha256 ?? '').slice(0, 12), d.note ?? ''])
          }
          for (const l of table(rows)) io.out(l)
        }
        break
      }
      case 'rollback': {
        need(1, 'rollback <version>')
        const version = int(pos[0], 'the version', 0)
        const r = await withDb(f, connector, (a) => a.activate(version))
        if (f.json) io.out(json(r))
        else {
          io.out(`Version ${r.version} is active again, with ${r.units.length} unit${r.units.length === 1 ? '' : 's'}:`)
          for (const l of unitLines(r.units)) io.out(l)
        }
        break
      }
      case 'call': {
        need(1, 'call <unit> [json]')
        let args: unknown
        if (pos[1] !== undefined) {
          try {
            args = JSON.parse(pos[1])
          } catch (e) {
            throw new UsageError(`the arguments are not JSON: ${(e as Error).message}`)
          }
        }
        const unit = pos[0] as string
        try {
          const value = await withDb(f, connector, (a) => a.call(unit, args))
          io.out(f.json ? json({ ok: true, value }) : json(value))
        } catch (e) {
          if (!(e instanceof UnitError) || !f.json) throw e
          io.out(json({ ok: false, error: { code: e.code, message: e.message, data: e.data } }))
          return 1
        }
        break
      }
      case 'logs':
        await logs(f, io, connector)
        break
      case 'secrets': {
        const [sub, name, value] = pos
        if (sub === 'list') {
          const r = await withDb(f, connector, (a) => a.secrets.list())
          if (f.json) io.out(json(r))
          else if (r.length === 0) io.out('No secrets.')
          else for (const l of table(r.map((s) => [s.name, `updated ${time(s.updatedAt)}`]))) io.out(l)
        } else if (sub === 'set') {
          need(2, 'secrets set <name> [value]   (without a value, it is read from stdin)')
          const v = value ?? (await io.readSecret(`Value of ${name}: `))
          if (v === '') throw new UsageError(`empty value: use \`azora-units secrets unset ${name}\` to remove a secret`)
          await withDb(f, connector, (a) => a.secrets.set(name as string, v))
          io.out(f.json ? json({ name }) : `Set ${name}.`)
        } else if (sub === 'unset') {
          need(2, 'secrets unset <name>')
          const removed = await withDb(f, connector, (a) => a.secrets.unset(name as string))
          io.out(f.json ? json({ name, removed }) : removed ? `Removed ${name}.` : `There was no secret ${name}.`)
        } else {
          throw new UsageError('usage: azora-units secrets list | set <name> [value] | unset <name>')
        }
        break
      }
      case 'jobs': {
        const [sub, id] = pos
        if (sub === undefined || sub === 'list') {
          const state = f.state as 'pending' | 'failed' | undefined
          if (state !== undefined && state !== 'pending' && state !== 'failed') throw new UsageError(`--state must be pending or failed, not ${JSON.stringify(f.state)}`)
          const o = { limit: int(f.limit, '--limit', 100), ...(state !== undefined && { state }), ...(f.unit !== undefined && { unit: f.unit }) }
          const r = await withDb(f, connector, (a) => a.jobs.list(o))
          if (f.json) io.out(json(r))
          else for (const l of jobLines(r)) io.out(l)
        } else if (sub === 'cancel') {
          need(2, 'jobs cancel <id>')
          const removed = await withDb(f, connector, (a) => a.jobs.cancel(id as string))
          io.out(f.json ? json({ id, removed }) : removed ? `Removed ${id}.` : `There was no job ${id}.`)
        } else if (sub === 'retry') {
          need(2, 'jobs retry <id>')
          await withDb(f, connector, (a) => a.jobs.retry(id as string))
          io.out(f.json ? json({ id }) : `${id} runs again now.`)
        } else {
          throw new UsageError('usage: azora-units jobs [--state pending|failed] [--unit name] [--limit n] | cancel <id> | retry <id>')
        }
        break
      }
      case 'types':
        await types(pos, f, io, connector)
        break
      default:
        throw new UsageError(`unknown command ${JSON.stringify(cmd)}: run azora-units --help for the commands`)
    }
    return 0
  } catch (e) {
    io.err(`azora-units: ${describe(e)}`)
    return e instanceof UsageError ? 2 : 1
  }
}
