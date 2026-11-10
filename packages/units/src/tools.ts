/**
 * The CLI's building blocks, for scripts and build tools (Node only):
 * bundle a units directory, publish it, read the environment, generate
 * Go types.
 *
 * ```ts
 * import { publishUnits } from '@azora-db/units/tools'
 * await publishUnits(db, 'units', { note: 'release 12' })
 * ```
 *
 * @packageDocumentation
 */
export { BundleError, bundleUnits, evaluateBundle, findEntry, manifestOf, type Bundle, type BundleOptions, type ManifestUnit } from './bundle.ts'
export { EnvError, loadEnv, type Env } from './env.ts'
export { generateGo, goName, goPackage, type GoUnit } from './gogen.ts'
export { publishUnits, type PublishOptions, type PublishResult } from './publish.ts'
