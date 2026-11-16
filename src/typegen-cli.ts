#!/usr/bin/env node
/**
 * The azora-gen command: writes TypeScript row types for a database's
 * tables and views (typegen.ts). Reads AZORA_URL and AZORA_TOKEN from the
 * environment or `.env` when --url and --token are absent.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { connect } from './database.ts'
import { AzoraError, ConnectionError, ErrorCode, TimeoutError } from './errors.ts'
import { generateTypes, readSchema, TypegenError, type Schema } from './typegen.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version

const USAGE = `azora-gen: TypeScript row types from the schema of an Azora database

Usage: azora-gen [options]

Options:
  -o, --out <file>      write the types to this file (default: print them)
      --check           write nothing; exit 1 when <file> differs from what would be
                        generated (for CI)
      --tables <a,b>    only these tables or views
      --bigint          type integer columns number | bigint (the SDK returns a bigint
                        beyond 2^53 - 1)
      --url <url>       the database's address (default: AZORA_URL)
      --token <token>   an API key or client token with the read scope (default:
                        AZORA_TOKEN, or AZORA_API_KEY)
      --env-file <path> read AZORA_URL and AZORA_TOKEN from this file (default: .env,
                        when present)
  -h, --help            this help
  -v, --version         the version

Exit codes: 0 done, 1 failed (or --check found a difference), 2 bad usage.
`

export interface IO {
  out(text: string): void
  err(line: string): void
}

export interface Flags {
  out?: string
  url?: string
  token?: string
  tables?: string
  'env-file'?: string
  check: boolean
  bigint: boolean
}

/** Reads the schema with the connection the flags and the environment describe. */
export type SchemaSource = (f: Flags, tables: string[] | undefined) => Promise<Schema>

/** A usage error: exit code 2. */
class UsageError extends Error {}

/** A missing setting or an unreadable env file. */
class EnvError extends Error {}

const defaultIO: IO = {
  out: (t) => process.stdout.write(t),
  err: (l) => process.stderr.write(l + '\n'),
}

/** --url and --token, then the environment, then the env file (`.env` when present). */
export function settings(
  f: Flags,
  env: Record<string, string | undefined> = process.env,
): { url: string; token: string } {
  const path = resolve(f['env-file'] ?? '.env')
  let fromFile: Record<string, string | undefined> = {}
  let used: string | null = null
  if (existsSync(path)) {
    try {
      fromFile = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>
    } catch (e) {
      throw new EnvError(`cannot read ${path}: ${(e as Error).message}`)
    }
    used = path
  } else if (f['env-file'] !== undefined) {
    throw new EnvError(`no env file at ${path}`)
  }
  const get = (k: string): string => env[k] || fromFile[k] || ''
  const url = f.url || get('AZORA_URL')
  const token = f.token || get('AZORA_TOKEN') || get('AZORA_API_KEY')
  const where = used ? `the environment or ${used}` : 'the environment or a .env file'
  if (!url)
    throw new EnvError(
      `no database address: pass --url or set AZORA_URL (in ${where}), as \`azora connect <database> --key <name>\` prints it`,
    )
  if (!token)
    throw new EnvError(`no credential: pass --token or set AZORA_TOKEN (in ${where}), an API key with the read scope`)
  return { url, token }
}

const defaultSource: SchemaSource = async (f, tables) => {
  const { url, token } = settings(f)
  const db = await connect(url, { token, clientName: `azora-gen/${VERSION}` })
  try {
    return await readSchema(db, tables ? { tables } : {})
  } finally {
    await db.close()
  }
}

/** One or two lines for a failure, with what to do about it. */
export function describe(e: unknown): string {
  if (e instanceof EnvError || e instanceof UsageError || e instanceof TypegenError) return e.message
  if (e instanceof AzoraError) {
    if (e.code === ErrorCode.PermissionDenied) {
      return `${e.message}\nReading the schema needs a credential with the read scope that may query the whole database: an API key (\`azora meta key create <db> --name <name> --scope read\`), not a client token limited to some tables.`
    }
    if (e.code === ErrorCode.Unauthenticated)
      return `${e.message}\nThe server refused the credential: is AZORA_TOKEN a valid API key for this database?`
    return `${e.message} (${e.code})`
  }
  if (e instanceof ConnectionError || e instanceof TimeoutError) return `cannot reach the database: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

/** Runs the command with argv (without node and the script) and returns the exit code. */
export async function main(argv: string[], io: IO = defaultIO, source: SchemaSource = defaultSource): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        out: { type: 'string', short: 'o' },
        url: { type: 'string' },
        token: { type: 'string' },
        tables: { type: 'string' },
        'env-file': { type: 'string' },
        check: { type: 'boolean', default: false },
        bigint: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
  } catch (e) {
    io.err(`azora-gen: ${(e as Error).message}\nRun azora-gen --help for the options.`)
    return 2
  }
  const f = parsed.values as Flags & { help: boolean; version: boolean }
  if (f.version) {
    io.out(VERSION + '\n')
    return 0
  }
  if (f.help) {
    io.out(USAGE)
    return 0
  }
  try {
    if (f.check && !f.out) throw new UsageError('--check needs --out <file>: the file to compare with')
    const tables = f.tables
      ?.split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '')
    if (f.tables !== undefined && tables?.length === 0) throw new UsageError('--tables needs at least one name')

    const schema = await source(f, tables)
    if (schema.tables.length === 0) throw new TypegenError('the database has no tables or views: nothing to generate')
    const command = [
      'azora-gen',
      ...(f.out ? ['--out', f.out] : []),
      ...(tables ? ['--tables', tables.join(',')] : []),
      ...(f.bigint ? ['--bigint'] : []),
    ].join(' ')
    const text = generateTypes(schema, { bigint: f.bigint, command })

    if (!f.out) {
      io.out(text)
      return 0
    }
    const path = resolve(f.out)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (f.check) {
      if (current === text) {
        io.err(`azora-gen: ${f.out} is up to date`)
        return 0
      }
      io.err(
        `azora-gen: ${f.out} ${current === null ? 'does not exist' : 'is out of date with the database schema'}\nRegenerate it with: ${command}`,
      )
      return 1
    }
    if (current !== text) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const n = schema.tables.length
    io.err(`azora-gen: ${current === text ? 'no change in' : 'wrote'} ${f.out} (${n} ${n === 1 ? 'table' : 'tables'})`)
    return 0
  } catch (e) {
    io.err(`azora-gen: ${describe(e)}`)
    return e instanceof UsageError ? 2 : 1
  }
}

// Run when this file is the program (the bin), not when it is imported.
const entry = process.argv[1]
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`azora-gen: ${describe(e)}\n`)
      process.exit(1)
    },
  )
}
