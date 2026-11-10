import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { BundleError, bundleUnits, evaluateBundle, manifestOf } from '../src/tools.ts'

const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname

describe('bundle', () => {
  test('one script that sets globalThis.__azora_units to the unit definitions', async () => {
    const b = await bundleUnits(fixture('shop'))
    expect(b.entry).toMatch(/shop\/index\.ts$/)
    expect(b.bundle).not.toMatch(/^\s*(import|export)\s/m) // a script, not a module
    expect(b.bundle).not.toContain('sourceMappingURL') // the map travels separately

    // A fresh context, with nothing but the language: what the engine gives a bundle.
    const ctx: Record<string, unknown> = {}
    runInNewContext(b.bundle, ctx)
    const units = ctx['__azora_units'] as Record<string, Record<string, unknown>>
    expect(Object.keys(units).sort()).toEqual(['audit', 'checkout', 'myOrders', 'nightly', 'paid']) // notAUnit is left out
    for (const d of Object.values(units)) {
      expect(d['~azora']).toBe(1)
      expect(typeof d['handler']).toBe('function')
    }
    expect(units['checkout']).toMatchObject({
      kind: 'mutation', internal: false, description: '',
      args: { type: 'object', properties: { cartId: { type: 'string', minLength: 1 }, note: { type: 'string' } }, required: ['cartId'], additionalProperties: false },
    })
    expect(units['myOrders']).toMatchObject({ kind: 'query', args: null, description: 'the caller’s orders' })
    expect(units['audit']).toMatchObject({ internal: true })
    expect(units['paid']).toMatchObject({ kind: 'onChange', table: 'orders', ops: ['update'], mode: 'action', batch: 100, internal: true })
    expect(units['nightly']).toMatchObject({ kind: 'schedule', cron: '0 3 * * *', every: '', mode: 'mutation' })

    expect(manifestOf(evaluateBundle(b.bundle)).find((u) => u.name === 'paid')).toEqual({
      name: 'paid', kind: 'onChange', internal: true, description: '', args: null, mode: 'action', table: 'orders', ops: ['update'], batch: 100,
    })
  })

  test('handlers run in the bundle, and a thrown UnitError is recognizable by its name', async () => {
    const b = await bundleUnits(fixture('shop'))
    const ctx: Record<string, unknown> = {}
    runInNewContext(b.bundle, ctx)
    const fake = (cart: unknown) => ({
      db: {
        one: () => cart,
        exec: (_sql: string, ...args: unknown[]) => ({ rowsAffected: 1, lastInsertId: 7, args }),
      },
    })
    // Like the engine: call the handler inside the context and inspect what it threw.
    ctx['run'] = (cart: unknown) => {
      try {
        return { ok: true, value: (ctx['__azora_units'] as any).checkout.handler(fake(cart), { cartId: 'c1' }) }
      } catch (e) {
        const x = e as { name: unknown; code: unknown; message: unknown; data: unknown }
        return { ok: false, name: x.name, code: x.code, message: x.message, data: x.data }
      }
    }
    expect(runInNewContext('run({ owner: "user:1", total: 10 })', ctx)).toEqual({ ok: true, value: { orderId: 7 } })
    expect(runInNewContext('run(null)', ctx)).toEqual({ ok: false, name: 'UnitError', code: 'not_found', message: 'no such cart', data: { cartId: 'c1' } })
  })

  test('the same sources make the same bundle from any working directory', async () => {
    const a = await bundleUnits(fixture('shop'))
    const cwd = process.cwd()
    process.chdir(tmpdir())
    try {
      const b = await bundleUnits(fixture('shop'))
      expect(b.bundle).toBe(a.bundle)
      expect(b.sourceMap).toBe(a.sourceMap)
    } finally {
      process.chdir(cwd)
    }
  })

  test('the source map points at the TypeScript sources', async () => {
    const b = await bundleUnits(fixture('shop'))
    const map = JSON.parse(b.sourceMap) as { sources: string[]; sourcesContent: string[] }
    expect(map.sources).toContain('index.ts')
    expect(map.sources).toContain('tax.ts')
    expect(map.sourcesContent[map.sources.indexOf('tax.ts')]).toContain('TAX = 0.2')
    expect(b.inputs.some((p) => p.endsWith('fixtures/shop/tax.ts'))).toBe(true)
  })

  test('without an index, every source file of the directory is an entry (tests excluded)', async () => {
    const b = await bundleUnits(fixture('multi'))
    expect(b.entry).toBeNull()
    expect(Object.keys(evaluateBundle(b.bundle)).sort()).toEqual(['a', 'b'])
  })

  test('errors say where', async () => {
    await expect(bundleUnits(join(tmpdir(), 'azora-units-does-not-exist'))).rejects.toThrow(/no units directory at .*create units\/index\.ts/)
    const empty = mkdtempSync(join(tmpdir(), 'azora-units-'))
    await expect(bundleUnits(empty)).rejects.toThrow(/no units in/)
    writeFileSync(join(empty, 'index.ts'), 'export const x = query({ handler: () => 1 \n')
    const err = await bundleUnits(empty).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BundleError)
    expect((err as Error).message).toMatch(/^bundling \/.*failed:\n\/.*index\.ts:2:1: Expected "\}" but found end of file$/)
    writeFileSync(join(empty, 'index.ts'), 'import { nope } from "./missing.ts"\nexport const x = nope')
    await expect(bundleUnits(empty)).rejects.toThrow(/index\.ts:1:\d+: Could not resolve "\.\/missing\.ts"/)
    writeFileSync(join(empty, 'index.ts'), 'export const x = 1')
    expect(() => evaluateBundle('globalThis.__azora_units = 1')).toThrow(/did not set globalThis.__azora_units/)
    expect(evaluateBundle((await bundleUnits(empty)).bundle)).toEqual({})
  })
})
