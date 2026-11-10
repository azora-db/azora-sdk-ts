/**
 * Starts a real Azora engine for integration tests: a temporary data root
 * with a seeded `shop` database, served on free local ports. The binary
 * comes from AZORA_BIN or ../azora-engine/bin/azora.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/** The engine binary, or null when there is none (integration tests are then skipped). */
export function engineBinary(): string | null {
  const bin = process.env['AZORA_BIN'] ?? resolve(here, '../../../azora-engine/bin/azora')
  return existsSync(bin) ? bin : null
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

export interface EngineOptions {
  /** Statements run on the `shop` database before serving (one per entry). */
  schema?: string[]
  /** Tables to publish for realtime (`files` publishes stored files). */
  publish?: string[]
  /** Extra realtime settings (JSON values). */
  realtime?: Record<string, unknown>
  /** Client tokens to mint: name -> arguments of `azora realtime token create shop`. */
  tokens?: Record<string, string[]>
}

export interface Engine {
  dir: string
  database: string
  httpUrl: string
  wsUrl: string
  host: string
  port: number
  /** `azora://host:port/shop` without key parameters. */
  tcpUrl: string
  serverKey: string
  fingerprint: string
  /** API key with read, write and ddl. */
  apiKey: string
  /** API key with read only. */
  readKey: string
  tokens: Record<string, string>
  /** Runs a CLI command (only while the server is stopped: it holds the data-root lock). */
  cli(...args: string[]): string
  stop(): Promise<void>
  /** Kills the server without a goodbye (SIGKILL), as a crash would. */
  kill(): Promise<void>
  start(): Promise<void>
  restart(): Promise<void>
  running: boolean
}

export const DEFAULT_SCHEMA = [
  'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, note TEXT)',
  'CREATE TABLE items(order_id INTEGER NOT NULL, sku TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY(order_id, sku)) WITHOUT ROWID',
  'CREATE TABLE kv(k TEXT PRIMARY KEY, v BLOB)',
  'CREATE TABLE plain(id INTEGER PRIMARY KEY, v TEXT)',
]

export async function startEngine(o: EngineOptions = {}): Promise<Engine> {
  const bin = engineBinary()
  if (!bin) throw new Error('no azora binary: set AZORA_BIN or build ../azora-engine (make build)')
  const dir = mkdtempSync(join(tmpdir(), 'azora-js-'))
  const config = join(dir, 'azora.json')
  writeFileSync(
    config,
    JSON.stringify({
      data_root: join(dir, 'root'),
      realtime: { allow_plaintext: true, ...o.realtime },
      storage: { cors_origins: '*' },
    }),
  )
  const cli = (...args: string[]): string =>
    execFileSync(bin, ['--config', config, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  cli('init', '--json')
  cli('db', 'create', 'shop', '--json')
  for (const stmt of o.schema ?? DEFAULT_SCHEMA) cli('db', 'exec', 'shop', stmt)
  const publish = o.publish ?? ['orders', 'items', 'kv', 'files']
  if (publish.length > 0) cli('realtime', 'publish', 'shop', ...publish, '--json')
  const key = (name: string, scope: string): string =>
    (JSON.parse(cli('meta', 'key', 'create', 'shop', '--name', name, '--scope', scope, '--json')) as { secret: string }).secret
  const apiKey = key('app', 'read,write,ddl')
  const readKey = key('reader', 'read')
  const tokens: Record<string, string> = {}
  for (const [name, args] of Object.entries(o.tokens ?? {})) {
    tokens[name] = (JSON.parse(cli('realtime', 'token', 'create', 'shop', ...args, '--json')) as { token: string }).token
  }
  const http = await freePort()
  const tcp = await freePort()
  let child: ChildProcess | null = null
  const e: Engine = {
    dir,
    database: 'shop',
    httpUrl: `http://127.0.0.1:${http}`,
    wsUrl: `ws://127.0.0.1:${http}/rt/v1`,
    host: '127.0.0.1',
    port: tcp,
    tcpUrl: `azora://127.0.0.1:${tcp}/shop`,
    serverKey: '',
    fingerprint: '',
    apiKey,
    readKey,
    tokens,
    running: false,
    cli(...args) {
      if (e.running) throw new Error('the engine holds the data-root lock: stop it before running CLI commands')
      return cli(...args)
    },
    async start() {
      if (child) return
      const p = spawn(
        bin,
        ['--config', config, 'serve', '--addr', `127.0.0.1:${http}`, '--rt-addr', `127.0.0.1:${tcp}`, '--public-url', e.httpUrl],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      child = p
      let out = ''
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`azora serve did not start:\n${out}`)), 20_000)
        const onData = (b: Buffer): void => {
          out += b.toString()
          const m = /server key (\S+) \(fingerprint (azp1-[a-z2-7-]+)\)/.exec(out)
          if (m && out.includes('Serving storage')) {
            clearTimeout(timer)
            e.serverKey = m[1] as string
            e.fingerprint = m[2] as string
            ok()
          }
        }
        p.stdout?.on('data', onData)
        p.stderr?.on('data', onData)
        p.once('exit', (code) => {
          clearTimeout(timer)
          fail(new Error(`azora serve exited with ${code}:\n${out}`))
        })
      })
      e.running = true
    },
    async stop() {
      const p = child
      if (!p) return
      child = null
      await new Promise<void>((ok) => {
        p.once('exit', () => ok())
        p.kill('SIGTERM')
        setTimeout(() => p.kill('SIGKILL'), 10_000).unref()
      })
      e.running = false
    },
    async kill() {
      const p = child
      if (!p) return
      child = null
      await new Promise<void>((ok) => {
        p.once('exit', () => ok())
        p.kill('SIGKILL')
      })
      e.running = false
    },
    async restart() {
      await e.stop()
      await e.start()
    },
  }
  await e.start()
  return e
}
