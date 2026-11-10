#!/usr/bin/env node
/** The azora-units command. */
import { describe, main } from './main.ts'

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`azora-units: ${describe(e)}\n`)
    process.exit(1)
  },
)
