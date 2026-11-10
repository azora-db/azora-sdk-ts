/** Publishing: bundle a units directory and deploy it. */
import type { DeployResult, UnitsAdmin } from '@azora-db/client'
import { bundleUnits, type Bundle, type BundleOptions } from './bundle.ts'

export interface PublishOptions extends BundleOptions {
  note?: string
  /** Checks the bundle on the server without publishing it. */
  dryRun?: boolean
}

export interface PublishResult extends DeployResult {
  /** The bundle that was sent. */
  built: Bundle
}

/**
 * Bundles the units directory (default `units`) and deploys it through
 * db (an API key with the `ddl` scope):
 *
 * ```ts
 * const db = await connectEnv()
 * const { version, units } = await publishUnits(db, 'units', { note: 'release 12' })
 * ```
 */
export async function publishUnits(db: { unitsAdmin: UnitsAdmin }, dir = 'units', o: PublishOptions = {}): Promise<PublishResult> {
  const built = await bundleUnits(dir, o)
  const r = await db.unitsAdmin.deploy({
    bundle: built.bundle,
    ...(built.sourceMap !== '' && { sourceMap: built.sourceMap }),
    ...(o.note !== undefined && { note: o.note }),
    ...(o.dryRun && { dryRun: true }),
  })
  return { ...r, built }
}
