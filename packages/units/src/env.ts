/** Where the CLI finds AZORA_URL and AZORA_TOKEN: the environment, then a .env file. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

export interface Env {
  url: string
  token: string
  /** The .env file that was read, or null. */
  file: string | null
}

/** A missing setting or an unreadable file. */
export class EnvError extends Error {
  override name = 'EnvError'
}

/**
 * Reads AZORA_URL and AZORA_TOKEN (or AZORA_API_KEY) from env, falling
 * back to the .env file (`file`, default `.env` in the current directory
 * when it exists). Variables already in the environment win.
 */
export function loadEnv(file?: string, env: Record<string, string | undefined> = process.env): Env {
  const path = resolve(file ?? '.env')
  let fromFile: Record<string, string | undefined> = {}
  let used: string | null = null
  if (existsSync(path)) {
    try {
      fromFile = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>
    } catch (e) {
      throw new EnvError(`cannot read ${path}: ${(e as Error).message}`)
    }
    used = path
  } else if (file !== undefined) {
    throw new EnvError(`no env file at ${path}`)
  }
  const get = (k: string): string => env[k] || fromFile[k] || ''
  const url = get('AZORA_URL')
  const token = get('AZORA_TOKEN') || get('AZORA_API_KEY')
  const where = used ? `the environment or ${used}` : 'the environment or a .env file'
  if (!url) throw new EnvError(`AZORA_URL is not set (in ${where}): the database's address, as \`azora connect <database> --key <name>\` prints it`)
  if (!token) throw new EnvError(`AZORA_TOKEN is not set (in ${where}): an API key with the ddl scope`)
  return { url, token, file: used }
}
