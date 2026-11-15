/**
 * ctx.storage for the local test environment: files kept in the same
 * in-memory SQLite database as the tables, so a file a mutation stores or
 * deletes is rolled back with it, as in the engine (internal/units
 * files.go). What it does not emulate is listed in the README: bucket
 * limits and allowed types, reference counting of file columns, and
 * content type detection from the bytes.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FileOptions, StoredFile } from '../ctx.ts'

/** The catalog table has the engine's name, so units that read it in SQL find it. */
export const FILES_SCHEMA = `
CREATE TABLE azora_objects(id TEXT PRIMARY KEY, bucket TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
  refs INTEGER NOT NULL DEFAULT 0, auto_delete INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX azora_objects_path ON azora_objects(bucket, path) WHERE path <> '';
CREATE TABLE azora_test_content(id TEXT PRIMARY KEY REFERENCES azora_objects(id) ON DELETE CASCADE, content BLOB NOT NULL);`

const TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css', csv: 'text/csv', json: 'application/json', js: 'text/javascript',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

/** A file waiting to be stored: the value of `ctx.storage.upload`. */
export class PendingUpload {
  readonly '~upload' = true as const
  used = false
  readonly content: Uint8Array
  readonly opts: FileOptions
  readonly keep: boolean
  constructor(content: Uint8Array, opts: FileOptions, keep: boolean) {
    this.content = content
    this.opts = opts
    this.keep = keep
  }
}

interface ObjectRow {
  id: string
  bucket: string
  path: string
  name: string
  content_type: string
  size: number | bigint
  sha256: string
  metadata: string
  created_at: number | bigint
}

function fileOf(r: ObjectRow): StoredFile {
  return {
    id: r.id, bucket: r.bucket, path: r.path, name: r.name, contentType: r.content_type, size: Number(r.size), sha256: r.sha256,
    metadata: JSON.parse(r.metadata) as Record<string, string>, createdAt: Number(r.created_at),
  }
}

const COLS = 'id, bucket, path, name, content_type, size, sha256, metadata, created_at'

/** The files of a test environment. Every method runs on the database's current transaction. */
export class FileStore {
  private readonly db: DatabaseSync
  private readonly newId: () => string
  private readonly now: () => number
  private readonly origin: string
  constructor(db: DatabaseSync, newId: () => string, now: () => number, origin = 'http://storage.test') {
    this.db = db
    this.newId = newId
    this.now = now
    this.origin = origin
  }

  stat(id: string): StoredFile | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM azora_objects WHERE id = ?`).get(id) as ObjectRow | undefined
    return r ? fileOf(r) : null
  }

  statPath(path: string, bucket = 'default'): StoredFile | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM azora_objects WHERE bucket = ? AND path = ?`).get(bucket || 'default', path) as ObjectRow | undefined
    return r ? fileOf(r) : null
  }

  list(): StoredFile[] {
    return (this.db.prepare(`SELECT ${COLS} FROM azora_objects ORDER BY created_at, id`).all() as unknown as ObjectRow[]).map(fileOf)
  }

  read(id: string): Uint8Array | null {
    const r = this.db.prepare('SELECT content FROM azora_test_content WHERE id = ?').get(id) as { content: Uint8Array } | undefined
    return r ? new Uint8Array(r.content) : null
  }

  /** Stores an upload and returns the file (the engine's resolver of an upload argument). */
  store(u: PendingUpload): StoredFile {
    const o = u.opts
    const bucket = o.bucket || 'default'
    const path = o.path ?? ''
    const name = o.name || path.slice(path.lastIndexOf('/') + 1)
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const type = o.contentType || TYPES[ext] || 'application/octet-stream'
    const sha = createHash('sha256').update(u.content).digest('hex')
    const meta = JSON.stringify(o.metadata ?? {})
    const at = this.now()
    const existing = path ? this.statPath(path, bucket) : null
    if (existing) {
      if (!o.overwrite) throw new Error(`object exists: ${bucket}/${path} (pass overwrite to replace its content)`)
      // The content changes, the id stays.
      this.db.prepare('UPDATE azora_objects SET name = ?, content_type = ?, size = ?, sha256 = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run(name, type, u.content.length, sha, meta, at, existing.id)
      this.db.prepare('UPDATE azora_test_content SET content = ? WHERE id = ?').run(u.content, existing.id)
      return this.stat(existing.id) as StoredFile
    }
    const id = this.newId()
    this.db.prepare(`INSERT INTO azora_objects(${COLS}, auto_delete, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, bucket, path, name, type, u.content.length, sha, meta, at, u.keep ? 0 : 1, at)
    this.db.prepare('INSERT INTO azora_test_content(id, content) VALUES (?, ?)').run(id, u.content)
    return this.stat(id) as StoredFile
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM azora_objects WHERE id = ?').run(id).changes) > 0
  }

  /** A link that looks like the engine's; nothing serves it. */
  url(id: string, ttlSeconds: number, download: boolean | string): string {
    const q = new URLSearchParams({ exp: String(Math.floor(this.now() / 1000) + (ttlSeconds || 3600)), sig: 'test' })
    if (download) q.set('dl', typeof download === 'string' ? download : '1')
    return `${this.origin}/storage/v1/o/test/${id}?${q}`
  }

  uploadUrl(grant: Record<string, unknown>, ttlSeconds: number): { url: string; expiresAt: number } {
    const expiresAt = this.now() + (ttlSeconds || 900) * 1000
    const q = new URLSearchParams({ grant: JSON.stringify(grant), exp: String(Math.floor(expiresAt / 1000)), sig: 'test' })
    return { url: `${this.origin}/storage/v1/u/test?${q}`, expiresAt }
  }
}
