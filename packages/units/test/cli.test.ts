import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AzoraError, UnitError, UnitsAdmin } from '@azora-db/client'
import { describe as describeError, main, type Conn, type IO } from '../src/main.ts'
import { loadEnv } from '../src/env.ts'

const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname

/** An admin facade whose server is a function of (op, body). */
function server(answer: (op: string, body: any) => unknown): { conn: Conn; ops: Array<[string, any]>; closed: () => number } {
  const ops: Array<[string, any]> = []
  let closed = 0
  const unitsAdmin = new UnitsAdmin(async (op, body) => {
    const b = JSON.parse(body) as unknown
    ops.push([op, b])
    const r = answer(op, b)
    if (r instanceof Error) throw r
    return JSON.stringify(r)
  })
  return { conn: { unitsAdmin, close: async () => void closed++ }, ops, closed: () => closed }
}

function io(secret = ''): IO & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), readSecret: async () => secret }
}

const unit = { name: 'checkout', kind: 'mutation', internal: false, description: 'Pay for a cart', args: null }

describe('azora-units', () => {
  test('publish bundles the directory and deploys it with its source map and note', async () => {
    const s = server(() => ({ version: 3, sha256: 'ab'.repeat(32), unchanged: false, dry_run: false, units: [unit] }))
    const out = io()
    expect(await main(['publish', fixture('shop'), '--note', 'release 12'], out, async () => s.conn)).toBe(0)
    const [op, body] = s.ops[0]!
    expect(op).toBe('deploy')
    expect(body.bundle).toContain('globalThis.__azora_units')
    expect(JSON.parse(body.source_map).sources).toContain('index.ts')
    expect(body).toMatchObject({ note: 'release 12' })
    expect(body.dry_run).toBeUndefined()
    expect(out.lines[0]).toMatch(/^Published version 3 \(\d+\.\d kB, sha256 abababababab\) with 1 unit:$/)
    expect(out.lines[1]).toBe('  mutation  checkout    Pay for a cart')
    expect(s.closed()).toBe(1)

    const dry = server(() => ({ version: 0, sha256: '', unchanged: false, dry_run: true, units: [unit, { ...unit, name: 'x', kind: 'schedule', cron: '0 3 * * *', internal: true, description: '' }] }))
    const o2 = io()
    expect(await main(['publish', fixture('shop'), '--dry-run'], o2, async () => dry.conn)).toBe(0)
    expect(dry.ops[0]![1].dry_run).toBe(true)
    expect(o2.lines).toEqual([
      expect.stringMatching(/^Dry run: the bundle \(.*\) is valid; publishing it would deploy 2 units:$/),
      '  mutation  checkout                  Pay for a cart',
      '  schedule  x         cron 0 3 * * *',
    ])

    const same = server(() => ({ version: 3, sha256: 'x', unchanged: true, dry_run: false, units: [unit] }))
    const o3 = io()
    await main(['publish', fixture('shop'), '--json'], o3, async () => same.conn)
    expect(JSON.parse(o3.lines.join('\n'))).toMatchObject({ version: 3, unchanged: true, dryRun: false })
  })

  test('a bundle that does not build fails before connecting', async () => {
    const out = io()
    const connector = vi.fn()
    expect(await main(['publish', join(tmpdir(), 'nope-units')], out, connector)).toBe(1)
    expect(connector).not.toHaveBeenCalled()
    expect(out.errors[0]).toMatch(/^azora-units: no units directory at/)
  })

  test('list, history, rollback', async () => {
    const s = server((op) => {
      if (op === 'list') return { version: 2, units: [unit, { ...unit, name: 'audit', internal: true, description: '' }] }
      if (op === 'deploys') {
        return { active: 2, deploys: [
          { version: 2, at: Date.UTC(2026, 10, 10, 9, 30), by: 'key:ci', note: 'second', sha256: 'f'.repeat(64), size: 9000, units: 2, active: true },
          { version: 1, at: Date.UTC(2026, 10, 9, 8, 0), by: 'key:ci', note: '', sha256: 'e'.repeat(64), size: 8000, units: ['checkout'], active: false },
        ] }
      }
      if (op === 'activate') return { version: 1, units: [unit] }
      return {}
    })
    const c = async (): Promise<Conn> => s.conn
    let out = io()
    await main(['list'], out, c)
    expect(out.lines).toEqual(['Version 2 is active, with 2 units:', '  mutation  checkout            Pay for a cart', '  mutation  audit     internal'])
    out = io()
    await main(['history', '--limit', '5'], out, c)
    expect(s.ops.at(-1)).toEqual(['deploys', { limit: 5 }])
    expect(out.lines).toEqual([
      '  VERSION  AT                   BY      UNITS  SHA256        NOTE',
      '* 2        2026-11-10 09:30:00  key:ci  2      ffffffffffff  second',
      '  1        2026-11-09 08:00:00  key:ci  1      eeeeeeeeeeee',
    ])
    out = io()
    await main(['rollback', '1'], out, c)
    expect(s.ops.at(-1)).toEqual(['activate', { version: 1 }])
    expect(out.lines[0]).toBe('Version 1 is active again, with 1 unit:')
    out = io()
    expect(await main(['rollback', 'latest'], out, c)).toBe(2)
    expect(out.errors[0]).toMatch(/the version must be a non-negative integer/)

    const empty = server(() => ({ version: 0, units: [] }))
    out = io()
    await main(['list'], out, async () => empty.conn)
    expect(out.lines).toEqual(['Nothing is published yet: azora-units publish'])
  })

  test('call prints the result, with blobs as {"$bytes"}; a unit error fails', async () => {
    const s = server((_op, b) => (b.unit === 'boom'
      ? { ok: false, value: null, error: { code: 'conflict', message: 'already paid', data: { order: 7 } } }
      : { ok: true, value: { echo: b.args, blob: { $bytes: 'AAE=' } } }))
    const c = async (): Promise<Conn> => s.conn
    let out = io()
    expect(await main(['call', 'checkout', '{"cartId":"c1"}'], out, c)).toBe(0)
    expect(s.ops[0]).toEqual(['call', { unit: 'checkout', args: { cartId: 'c1' } }])
    expect(JSON.parse(out.lines.join('\n'))).toEqual({ echo: { cartId: 'c1' }, blob: { $bytes: 'AAE=' } })
    out = io()
    await main(['call', 'ping'], out, c)
    expect(s.ops[1]).toEqual(['call', { unit: 'ping' }])
    out = io()
    expect(await main(['call', 'boom'], out, c)).toBe(1)
    expect(out.errors[0]).toBe('azora-units: unit boom threw conflict: already paid\ndata: {\n  "order": 7\n}')
    out = io()
    expect(await main(['call', 'boom', '--json'], out, c)).toBe(1)
    expect(JSON.parse(out.lines.join('\n'))).toEqual({ ok: false, error: { code: 'conflict', message: 'already paid', data: { order: 7 } } })
    out = io()
    expect(await main(['call', 'x', '{bad'], out, c)).toBe(2)
    expect(out.errors[0]).toMatch(/the arguments are not JSON/)
  })

  test('logs prints runs oldest first with their logs; secrets are set from stdin', async () => {
    const at = Date.UTC(2026, 10, 10, 12, 0, 0)
    const s = server((op) => {
      if (op === 'runs') {
        return { runs: [
          { id: 2, at: at + 1000, unit: 'checkout', kind: 'mutation', trigger: 'call', principal: 'user:42', duration_ms: 3.456, status: 'error', error: 'not_found: no such cart', logs: '' },
          { id: 1, at, unit: 'checkout', kind: 'mutation', trigger: 'call', principal: 'user:42', duration_ms: 2, status: 'ok', error: '', logs: 'info paid 7\nwarn low stock' },
        ] }
      }
      if (op === 'secrets.list') return { secrets: [{ name: 'STRIPE_KEY', updated_at: at }] }
      if (op === 'secrets.unset') return { removed: false }
      return {}
    })
    const c = async (): Promise<Conn> => s.conn
    let out = io()
    await main(['logs', '--unit', 'checkout', '--limit', '2'], out, c)
    expect(s.ops[0]).toEqual(['runs', { limit: 2, unit: 'checkout' }])
    expect(out.lines).toEqual([
      '2026-11-10 12:00:00  ok        checkout  call  user:42  2 ms',
      '    info paid 7',
      '    warn low stock',
      '2026-11-10 12:00:01  error     checkout  call  user:42  3.5 ms',
      '    error: not_found: no such cart',
    ])
    out = io('sk_test_123')
    await main(['secrets', 'set', 'STRIPE_KEY'], out, c)
    expect(s.ops.at(-1)).toEqual(['secrets.set', { name: 'STRIPE_KEY', value: 'sk_test_123' }])
    expect(out.lines).toEqual(['Set STRIPE_KEY.'])
    out = io()
    await main(['secrets', 'set', 'A', 'inline'], out, c)
    expect(s.ops.at(-1)).toEqual(['secrets.set', { name: 'A', value: 'inline' }])
    out = io('')
    expect(await main(['secrets', 'set', 'A'], out, c)).toBe(2)
    out = io()
    await main(['secrets', 'list'], out, c)
    expect(out.lines).toEqual(['STRIPE_KEY  updated 2026-11-10 12:00:00'])
    out = io()
    await main(['secrets', 'unset', 'A'], out, c)
    expect(out.lines).toEqual(['There was no secret A.'])
  })

  test('types --go writes Go from the local units', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azora-units-types-'))
    const out = io()
    expect(await main(['types', '--go', join(dir, 'shop-units'), fixture('shop')], out, vi.fn())).toBe(0)
    const src = readFileSync(join(dir, 'shop-units', 'units.go'), 'utf8')
    expect(src).toMatch(/^package shopunits$/m)
    expect(src).toMatch(/type CheckoutArgs struct \{\n\tCartID\s+string\s+`json:"cartId"`/)
    expect(src).toMatch(/func MyOrders\[R any\]/)
    expect(src).not.toMatch(/Audit|Nightly|Paid/)
    expect(out.lines[0]).toMatch(/^Wrote .*units\.go \(package shopunits, 2 units\)\.$/)
    const bad = io()
    expect(await main(['types', fixture('shop')], bad, vi.fn())).toBe(2)
    expect(bad.errors[0]).toMatch(/types needs --go <dir>/)
  })

  test('usage, and errors that say what to do', async () => {
    let out = io()
    expect(await main([], out)).toBe(2)
    expect(out.errors[0]).toMatch(/^azora-units: publish and operate/)
    out = io()
    expect(await main(['--help'], out)).toBe(0)
    out = io()
    expect(await main(['frobnicate'], out, vi.fn())).toBe(2)
    expect(out.errors[0]).toMatch(/unknown command "frobnicate"/)
    out = io()
    expect(await main(['publish', '--bogus'], out)).toBe(2)
    expect(out.errors[0]).toMatch(/Unknown option '--bogus'/)

    expect(describeError(new AzoraError('permission_denied', 'scope ddl required'))).toMatch(/needs an API key with the ddl \(or admin\) scope/)
    expect(describeError(new AzoraError('unauthenticated', 'bad key'))).toMatch(/refused AZORA_TOKEN/)
    expect(describeError(new UnitError('u', 'invalid', 'nope'))).toBe('unit u threw invalid: nope')
    const denied = server(() => new AzoraError('permission_denied', 'unit admin needs the ddl scope'))
    out = io()
    expect(await main(['list'], out, async () => denied.conn)).toBe(1)
    expect(out.errors[0]).toMatch(/permission_denied: unit admin needs the ddl scope\nManaging units needs an API key with the ddl/)
  })
})

describe('environment', () => {
  afterEach(() => vi.unstubAllEnvs())
  test('AZORA_URL and AZORA_TOKEN from the environment, then the .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'azora-units-env-'))
    const file = join(dir, '.env')
    writeFileSync(file, '# local engine\nAZORA_URL=http://127.0.0.1:8090/shop?key=abc\nAZORA_TOKEN="azk_file"\n')
    expect(loadEnv(file, {})).toEqual({ url: 'http://127.0.0.1:8090/shop?key=abc', token: 'azk_file', file })
    expect(loadEnv(file, { AZORA_TOKEN: 'azk_env' }).token).toBe('azk_env') // the environment wins
    expect(loadEnv(undefined, { AZORA_URL: 'u', AZORA_API_KEY: 'k' })).toEqual({ url: 'u', token: 'k', file: null }) // no .env here
    expect(() => loadEnv(join(dir, 'missing.env'), {})).toThrow(/no env file at/)
    writeFileSync(file, 'AZORA_URL=u\n')
    expect(() => loadEnv(file, {})).toThrow(/AZORA_TOKEN is not set .*an API key with the ddl scope/)
    expect(() => loadEnv(undefined, {})).toThrow(/AZORA_URL is not set \(in the environment or a \.env file\)/)
  })
})
