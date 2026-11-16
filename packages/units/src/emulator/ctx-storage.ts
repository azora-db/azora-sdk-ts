/** ctx.storage of a run. */
import type { FileOptions, StoredFile } from '../ctx.ts'
import type { Call } from './call.ts'
import { PendingUpload } from './files.ts'
import { bytesOf } from './json.ts'
import { bytesArg, type Frame } from './runtime.ts'

/** ctx.storage (the engine's newStorage in files.go, with its messages). */
export function newStorage(c: Call, f: Frame): Record<string, unknown> {
  const files = c.t.files
  const max = c.t.limits.maxFileBytes
  const id = (v: unknown): string =>
    typeof v === 'string' && v !== '' ? v : c.throw("ctx.storage: the file's id is required")
  const mayWrite = (what: string): void => {
    if (f.kind === 'query') c.throw(`a query cannot ${what} (make it a mutation or an action)`)
  }
  const stage = (content: unknown, opts: unknown, keep: boolean): PendingUpload => {
    if (content === null || content === undefined)
      c.throw('ctx.storage: the content is required: a string or a Uint8Array')
    if (typeof content !== 'string' && !bytesOf(content))
      c.throw('ctx.storage: the content must be a string or a Uint8Array')
    const b = bytesArg(content)
    if (b.length > max) c.throw(`ctx.storage: the content is ${b.length} bytes, over units.max_file_bytes (${max})`)
    if (opts !== undefined && opts !== null && typeof opts !== 'object')
      c.throw('ctx.storage: the options must be an object')
    const o = (opts ?? {}) as FileOptions
    return new PendingUpload(
      new Uint8Array(b),
      { ...o, ...(o.metadata && { metadata: { ...o.metadata } }) },
      keep || Boolean(o.keep),
    )
  }
  const read = (v: unknown): Uint8Array => {
    const file = c.withRead(f, () => files.stat(id(v)))
    if (!file) c.throw(`ctx.storage: no file ${String(v)}`)
    if (file.size > max) {
      c.throw(
        `ctx.storage: file ${String(v)} is larger than units.max_file_bytes (${max}): check stat(id).size first, or hand out ctx.storage.url(id)`,
      )
    }
    return c.withRead(f, () => files.read(file.id)) as Uint8Array
  }
  const ttl = (o: unknown): number => {
    const t = (o as { ttl?: unknown } | undefined)?.ttl
    if (t === undefined || t === null) return 0
    if (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t > 366 * 24 * 3600)
      c.throw('ctx.storage: ttl is a number of seconds, at most a year')
    return t
  }
  return {
    stat: (v: unknown) => c.withRead(f, () => files.stat(id(v))),
    statPath: (path: unknown, bucket: unknown) => {
      if (typeof path !== 'string' || path === '') c.throw('ctx.storage: the path is required')
      return c.withRead(f, () => files.statPath(path as string, typeof bucket === 'string' ? bucket : undefined))
    },
    read,
    text: (v: unknown) => new TextDecoder().decode(read(v)),
    url: (v: unknown, o: unknown) => {
      const fileId = id(v)
      if (!c.withRead(f, () => files.stat(fileId))) c.throw(`ctx.storage: no file ${fileId}`)
      const d = (o as { download?: unknown } | undefined)?.download
      return files.url(fileId, ttl(o), typeof d === 'string' ? d : Boolean(d))
    },
    uploadUrl: (grant: unknown, o: unknown) => {
      mayWrite('sign upload links')
      if (grant !== undefined && grant !== null && (typeof grant !== 'object' || Array.isArray(grant)))
        c.throw('ctx.storage: the grant must be an object')
      return files.uploadUrl((grant ?? {}) as Record<string, unknown>, ttl(o))
    },
    upload: (content: unknown, opts: unknown) => {
      mayWrite('store files')
      return stage(content, opts, false)
    },
    put: (content: unknown, opts: unknown): StoredFile => {
      mayWrite('store files')
      const up = stage(content, opts, true)
      return c.withWrite(f, () => files.store(up))
    },
    delete: (v: unknown, o: unknown) => {
      mayWrite('delete files')
      void (o as { force?: boolean } | undefined)?.force // references are not counted here: every delete goes through
      const fileId = id(v)
      return c.withWrite(f, () => files.delete(fileId))
    },
  }
}
