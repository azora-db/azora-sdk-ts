/**
 * Bundling: one script that sets `globalThis.__azora_units` to the unit
 * definitions keyed by export name (docs/units.md, Bundle format).
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build, type BuildFailure, type Message } from 'esbuild'

/** A built bundle. */
export interface Bundle {
  /** The script. */
  bundle: string
  /** Its source map (JSON), sources relative to the units directory. */
  sourceMap: string
  /** The units directory. */
  dir: string
  /** The entry file, or null when every file of the directory is one. */
  entry: string | null
  /** The files the bundle was built from (absolute paths, dependencies included). */
  inputs: string[]
}

/** Bundling failed (a syntax error, an unresolved import, ...). */
export class BundleError extends Error {
  override name = 'BundleError'
}

export interface BundleOptions {
  /** Module aliases (tests). */
  alias?: Record<string, string>
}

const GLOBAL = '__azora_units_exports'
// Keeps the exports made with the helpers: the bundle's units.
const FOOTER = `globalThis.__azora_units = (function (m) {
  var units = {};
  for (var k in m) if (m[k] && m[k]["~azora"] === 1) units[k] = m[k];
  return units;
})(${GLOBAL});`

const INDEX = ['index.ts', 'index.mts', 'index.js', 'index.mjs']
const SOURCE = /\.(m?[jt]s|tsx|jsx)$/

/** This package's library entry: user code's `@azora-db/units` imports resolve to it. */
const SELF = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './index.ts' : './index.js', import.meta.url))

/** The entry of a units directory: its index file, or all its source files. */
export function findEntry(dir: string): { entry: string | null; files: string[] } {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new BundleError(`no units directory at ${dir}: create units/index.ts, or pass the directory (azora-units publish <dir>)`)
  }
  for (const f of INDEX) {
    const p = join(dir, f)
    if (existsSync(p)) return { entry: p, files: [p] }
  }
  const files = readdirSync(dir)
    .filter((f) => SOURCE.test(f) && !/\.d\.[mc]?ts$/.test(f) && !/\.(test|spec)\.[^.]+$/.test(f))
    .sort()
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
  if (files.length === 0) throw new BundleError(`no units in ${dir}: add an index.ts that exports query(), mutation(), ... definitions`)
  return { entry: null, files }
}

/** A path for messages: relative to the current directory when under it. */
function show(p: string): string {
  const r = relative(process.cwd(), resolve(p))
  return r === '' ? '.' : r.startsWith('..') ? resolve(p) : r
}

function format(errors: readonly Message[], dir: string): string {
  return errors
    .map((m) => (m.location ? `${show(resolve(dir, m.location.file))}:${m.location.line}:${m.location.column + 1}: ${m.text}` : m.text))
    .join('\n')
}

/** Bundles the units directory (default `units`) with esbuild. */
export async function bundleUnits(dirArg = 'units', o: BundleOptions = {}): Promise<Bundle> {
  const dir = resolve(dirArg)
  const { entry, files } = findEntry(dir)
  let result
  try {
    result = await build({
      ...(entry
        ? { entryPoints: [entry] }
        : {
            stdin: {
              contents: files.map((f) => `export * from ${JSON.stringify('./' + relative(dir, f))};`).join('\n'),
              resolveDir: dir,
              sourcefile: '<units>',
              loader: 'ts' as const,
            },
          }),
      // Paths in the output are relative to the units directory, so the same
      // sources make the same bundle wherever the command runs.
      absWorkingDir: dir,
      bundle: true,
      write: false,
      format: 'iife',
      globalName: GLOBAL,
      footer: { js: FOOTER },
      target: 'es2020',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      sourcemap: 'external',
      outfile: join(dir, 'units.js'),
      metafile: true,
      logLevel: 'silent',
      alias: { '@azora-db/units': SELF, ...o.alias },
    })
  } catch (e) {
    const errors = (e as Partial<BuildFailure>).errors
    if (errors?.length) throw new BundleError(`bundling ${show(dir)} failed:\n${format(errors, dir)}`)
    throw e
  }
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))
  const map = result.outputFiles.find((f) => f.path.endsWith('.map'))
  if (!js) throw new BundleError('esbuild produced no output')
  return {
    bundle: js.text,
    sourceMap: map?.text ?? '',
    dir,
    entry,
    inputs: Object.keys(result.metafile.inputs)
      .filter((p) => !p.startsWith('<'))
      .map((p) => resolve(dir, p)),
  }
}

/** A unit as the server's manifest describes it (the `Unit` of docs/units.md). */
export interface ManifestUnit {
  name: string
  kind: string
  internal: boolean
  description: string
  args: Record<string, unknown> | null
  mode?: string
  cron?: string
  every?: string
  table?: string
  ops?: string[]
  batch?: number
}

/**
 * Runs a bundle in a fresh JavaScript context, as the engine does, and
 * returns what it set `globalThis.__azora_units` to. Only the module's
 * top level runs, not the handlers.
 */
export function evaluateBundle(bundle: string, timeoutMs = 5000): Record<string, Record<string, unknown>> {
  const sandbox: Record<string, unknown> = {}
  runInNewContext(bundle, sandbox, { timeout: timeoutMs, filename: 'units.js' })
  const units = sandbox['__azora_units']
  if (typeof units !== 'object' || units === null) throw new BundleError('the bundle did not set globalThis.__azora_units')
  return units as Record<string, Record<string, unknown>>
}

/** The manifest of evaluated definitions (what the server reports for them). */
export function manifestOf(units: Record<string, Record<string, unknown>>): ManifestUnit[] {
  return Object.entries(units).map(([name, d]) => {
    const u: ManifestUnit = {
      name,
      kind: String(d['kind']),
      internal: Boolean(d['internal']),
      description: String(d['description'] ?? ''),
      args: d['args'] == null ? null : (JSON.parse(JSON.stringify(d['args'])) as Record<string, unknown>),
    }
    if (d['kind'] === 'schedule' || d['kind'] === 'onChange') u.mode = String(d['mode'])
    if (d['kind'] === 'schedule') Object.assign(u, { cron: String(d['cron'] ?? ''), every: String(d['every'] ?? '') })
    if (d['kind'] === 'onChange') Object.assign(u, { table: String(d['table']), ops: [...(d['ops'] as string[])], batch: Number(d['batch']) })
    return u
  })
}
