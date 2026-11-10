/**
 * File storage over the engine's HTTP API (`/storage/v1`). It uses the
 * address of an `http(s)` connection URL (or a WebSocket URL's host, or
 * the `storageUrl` option) and needs an API key: client tokens cannot
 * call these routes, so browsers upload through signed upload URLs their
 * backend hands out.
 */
import { AzoraError, ErrorCode } from './errors.ts'

/** A stored file. */
export interface StoredObject {
  id: string
  bucket: string
  path?: string
  name: string
  contentType: string
  size: number
  /** Hex SHA-256 of the content. */
  sha256: string
  metadata?: Record<string, string>
  width?: number
  height?: number
  /** How many rows reference the object through file columns. */
  refs: number
  /** The object is deleted when its last reference goes away. */
  autoDelete: boolean
  createdAt: Date
  updatedAt: Date
}

/** What can be uploaded. */
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>

export interface UploadOptions {
  bucket?: string
  /** A path unique within the bucket (`avatars/42.png`); a second upload to it fails unless `overwrite`. */
  path?: string
  /** The file name (default: the last element of `path`). */
  name?: string
  contentType?: string
  overwrite?: boolean
  /** Hex SHA-256 the content must have; the upload is refused otherwise. */
  sha256?: string
  signal?: AbortSignal
}

export interface ResumableUploadOptions extends UploadOptions {
  /** Bytes per request (default 8 MiB). */
  chunkSize?: number
  /** Called after every chunk the server stored. */
  onProgress?: (sent: number, total: number) => void
  /** How many times a failed chunk is retried after asking the server for its offset (default 5). */
  retries?: number
}

export interface ListOptions {
  bucket?: string
  /** Only objects whose path starts with this. */
  prefix?: string
  /** Continue after this cursor (`next` of the previous page). */
  after?: string
  limit?: number
  signal?: AbortSignal
}

export interface SignOptions {
  /** Lifetime in seconds (default: the server's `storage.signed_url_ttl`). */
  ttlSeconds?: number
  /** Serve the file as an attachment. */
  download?: boolean
  filename?: string
  signal?: AbortSignal
}

/** Limits a signed upload URL enforces. */
export interface UploadGrant {
  bucket?: string
  path?: string
  overwrite?: boolean
  /** Comma-separated content types (`image/png,image/jpeg`). */
  allowedTypes?: string
  maxSize?: number
  /** Keep the object when no row references it. */
  keep?: boolean
  metadata?: Record<string, string>
  /** Store the new object's id in this row's column, in the same transaction. */
  table?: string
  column?: string
  /** The column that identifies the row (default `rowid`) and its value. */
  key?: string
  keyValue?: string
  ttlSeconds?: number
  signal?: AbortSignal
}

interface WireObject {
  id: string
  bucket: string
  path?: string
  name: string
  content_type: string
  size: number
  sha256: string
  metadata?: Record<string, string>
  width?: number
  height?: number
  refs: number
  auto_delete: boolean
  created_at: string
  updated_at: string
}

function toObject(w: WireObject): StoredObject {
  const o: StoredObject = {
    id: w.id,
    bucket: w.bucket,
    name: w.name,
    contentType: w.content_type,
    size: w.size,
    sha256: w.sha256,
    refs: w.refs,
    autoDelete: w.auto_delete,
    createdAt: new Date(w.created_at),
    updatedAt: new Date(w.updated_at),
  }
  if (w.path) o.path = w.path
  if (w.metadata) o.metadata = w.metadata
  if (w.width) o.width = w.width
  if (w.height) o.height = w.height
  return o
}

const STATUS_CODE: Record<number, string> = {
  400: ErrorCode.Invalid,
  401: ErrorCode.Unauthenticated,
  403: ErrorCode.PermissionDenied,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  413: ErrorCode.ResourceExhausted,
  429: ErrorCode.ResourceExhausted,
  503: ErrorCode.Unavailable,
  507: ErrorCode.ResourceExhausted,
}

async function failure(res: Response): Promise<AzoraError> {
  let code = STATUS_CODE[res.status] ?? ErrorCode.Internal
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch {
    /* not JSON */
  }
  const retry = Number(res.headers.get('Retry-After') ?? 0)
  return new AzoraError(code, message, { status: res.status, retryAfterMs: Number.isFinite(retry) ? retry * 1000 : 0 })
}

/** File storage of one database. Get it from `db.storage`. */
export class Storage {
  private readonly base: string
  private readonly db: string
  private readonly credential: () => string
  private readonly fetchImpl: typeof fetch | undefined

  /** @internal */
  constructor(baseUrl: string, database: string, credential: () => string, fetchImpl: typeof fetch | undefined) {
    this.base = baseUrl
    this.db = encodeURIComponent(database)
    this.credential = credential
    this.fetchImpl = fetchImpl
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    if (!this.base) {
      throw new TypeError(
        'azora: file storage needs the engine\'s HTTP address: connect with an http(s) URL (https://db.example.com/<database>), or set the storageUrl option',
      )
    }
    let u = `${this.base}/storage/v1/${path}`
    if (query) {
      const q = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === '' || v === false) continue
        q.set(k, v === true ? '1' : String(v))
      }
      const s = q.toString()
      if (s) u += '?' + s
    }
    return u
  }

  private async request(url: string, init: RequestInit & { duplex?: 'half' }, auth = true): Promise<Response> {
    const f = this.fetchImpl ?? globalThis.fetch
    const headers = new Headers(init.headers)
    if (auth) headers.set('Authorization', `Bearer ${this.credential()}`)
    const res = await f(url, { ...init, headers })
    if (!res.ok) throw await failure(res)
    return res
  }

  private body(body: UploadBody): { body: BodyInit; stream: boolean } {
    if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer) return { body, stream: false }
    if (ArrayBuffer.isView(body)) return { body: body as Uint8Array<ArrayBuffer>, stream: false }
    return { body, stream: true }
  }

  /**
   * Stores one file and returns it. The object is kept until deleted; bind
   * it to a row by writing its `id` into a file column.
   */
  async upload(body: UploadBody, o: UploadOptions = {}): Promise<StoredObject> {
    const b = this.body(body)
    const headers: Record<string, string> = { 'Content-Type': o.contentType ?? (body instanceof Blob && body.type ? body.type : 'application/octet-stream') }
    if (o.sha256) headers['X-Azora-SHA256'] = o.sha256
    const res = await this.request(
      this.url(`b/${this.db}/objects`, { bucket: o.bucket, path: o.path, name: o.name, overwrite: o.overwrite, content_type: o.contentType }),
      { method: 'POST', headers, body: b.body, ...(b.stream ? { duplex: 'half' as const } : {}), ...(o.signal ? { signal: o.signal } : {}) },
    )
    return toObject(((await res.json()) as { object: WireObject }).object)
  }

  /**
   * Uploads a large file in chunks through a resumable session: a chunk
   * that fails is retried from the offset the server reports, so a broken
   * connection costs at most one chunk.
   */
  async uploadResumable(body: Blob | ArrayBuffer | ArrayBufferView, o: ResumableUploadOptions = {}): Promise<StoredObject> {
    const blob = body instanceof Blob ? body : new Blob([body as BlobPart])
    const total = blob.size
    const chunk = Math.max(64 << 10, o.chunkSize ?? 8 << 20)
    const sig = o.signal ? { signal: o.signal } : {}
    const headers: Record<string, string> = { 'Upload-Length': String(total) }
    const type = o.contentType ?? (body instanceof Blob ? body.type : '')
    if (type) headers['X-Azora-Content-Type'] = type
    if (o.sha256) headers['X-Azora-SHA256'] = o.sha256
    const open = await this.request(
      this.url(`b/${this.db}/sessions`, { bucket: o.bucket, path: o.path, name: o.name, overwrite: o.overwrite }),
      { method: 'POST', headers, ...sig },
    )
    const location = open.headers.get('Location') ?? ((await open.json()) as { session: { url: string } }).session.url
    let offset = 0
    let failures = 0
    while (offset < total) {
      try {
        const res = await this.request(
          location,
          { method: 'PATCH', headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: blob.slice(offset, offset + chunk), ...sig },
          false,
        )
        offset = Number(res.headers.get('Upload-Offset') ?? offset + Math.min(chunk, total - offset))
        failures = 0
        o.onProgress?.(offset, total)
      } catch (e) {
        if (o.signal?.aborted || ++failures > (o.retries ?? 5)) throw e
        if (e instanceof AzoraError && e.status !== undefined && e.status !== 409 && e.status < 500 && e.status !== 429) throw e
        await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** failures, 5000)))
        // Ask where the session is: bytes received before the failure are kept.
        const head = await this.request(location, { method: 'HEAD', ...sig }, false)
        offset = Number(head.headers.get('Upload-Offset') ?? offset)
      }
    }
    const done = await this.request(`${location}/complete`, { method: 'POST', ...sig }, false)
    return toObject(((await done.json()) as { object: WireObject }).object)
  }

  /**
   * Downloads an object's content as a fetch `Response` (`.bytes()`,
   * `.text()`, `.body` for streaming). `range` asks for bytes
   * `[start, end]` (end inclusive, optional).
   */
  async download(id: string, o: { range?: readonly [number, number?]; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (o.range) headers['Range'] = `bytes=${o.range[0]}-${o.range[1] ?? ''}`
    return this.request(this.url(`b/${this.db}/objects/${encodeURIComponent(id)}/content`), { headers, ...(o.signal ? { signal: o.signal } : {}) })
  }

  /** Describes an object. */
  async stat(id: string, o: { signal?: AbortSignal } = {}): Promise<StoredObject> {
    const res = await this.request(this.url(`b/${this.db}/objects/${encodeURIComponent(id)}`), o.signal ? { signal: o.signal } : {})
    return toObject(((await res.json()) as { object: WireObject }).object)
  }

  /** One page of objects, in id order; pass `next` as `after` for the following page. */
  async list(o: ListOptions = {}): Promise<{ objects: StoredObject[]; next?: string }> {
    const res = await this.request(
      this.url(`b/${this.db}/objects`, { bucket: o.bucket, prefix: o.prefix, after: o.after, limit: o.limit }),
      o.signal ? { signal: o.signal } : {},
    )
    const body = (await res.json()) as { objects: WireObject[]; next?: string }
    return { objects: body.objects.map(toObject), ...(body.next ? { next: body.next } : {}) }
  }

  /** Iterates every matching object, page by page. */
  async *listAll(o: Omit<ListOptions, 'after'> = {}): AsyncGenerator<StoredObject, void, void> {
    let after: string | undefined
    for (;;) {
      const page = await this.list({ ...o, ...(after ? { after } : {}) })
      yield* page.objects
      if (!page.next) return
      after = page.next
    }
  }

  /**
   * Deletes an object. One that rows still reference is only deleted with
   * `force`, which sets those references to NULL.
   */
  async delete(id: string, o: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    await this.request(this.url(`b/${this.db}/objects/${encodeURIComponent(id)}`, { force: o.force }), {
      method: 'DELETE',
      ...(o.signal ? { signal: o.signal } : {}),
    })
  }

  /** A signed download URL: it opens this one object, without credentials, until it expires. */
  async signUrl(id: string, o: SignOptions = {}): Promise<{ url: string; expiresAt: Date }> {
    const res = await this.request(this.url(`b/${this.db}/sign`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ttl_seconds: o.ttlSeconds ?? 0, download: o.download ?? false, filename: o.filename ?? '' }),
      ...(o.signal ? { signal: o.signal } : {}),
    })
    const body = (await res.json()) as { url: string; expires_at: string }
    return { url: body.url, expiresAt: new Date(body.expires_at) }
  }

  /**
   * A signed upload URL for a client without credentials (a browser):
   * `PUT` or `POST` the file to `url`, or open resumable sessions at
   * `sessionUrl`. The grant's limits are enforced while the content
   * streams in.
   */
  async signUploadUrl(g: UploadGrant = {}): Promise<{ url: string; sessionUrl: string; expiresAt: Date }> {
    const res = await this.request(this.url(`b/${this.db}/sign-upload`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: g.bucket, path: g.path, overwrite: g.overwrite, allowed_types: g.allowedTypes, max_size: g.maxSize, keep: g.keep,
        metadata: g.metadata, table: g.table, column: g.column, key: g.key, key_value: g.keyValue, ttl_seconds: g.ttlSeconds ?? 0,
      }),
      ...(g.signal ? { signal: g.signal } : {}),
    })
    const body = (await res.json()) as { url: string; session_url: string; expires_at: string }
    return { url: body.url, sessionUrl: body.session_url, expiresAt: new Date(body.expires_at) }
  }

  /** The unsigned URL of an object in a public bucket. */
  publicUrl(id: string): string {
    return this.url(`p/${this.db}/${encodeURIComponent(id)}`)
  }
}

/**
 * Uploads a file to a signed upload URL (from `signUploadUrl`, usually
 * minted by your backend). Needs no credentials.
 */
export async function uploadToSignedUrl(
  url: string,
  body: Blob | ArrayBuffer | ArrayBufferView | string,
  o: { contentType?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<StoredObject> {
  const f = o.fetch ?? globalThis.fetch
  const res = await f(url, {
    method: 'PUT',
    headers: { 'Content-Type': o.contentType ?? (body instanceof Blob && body.type ? body.type : 'application/octet-stream') },
    body: body as BodyInit,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  if (!res.ok) throw await failure(res)
  return toObject(((await res.json()) as { object: WireObject }).object)
}
