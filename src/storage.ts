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
  /**
   * Called once with the session's URL when the session is open, before
   * the first chunk: store it to continue the upload in a later process
   * or page load with `resumeUpload`. The URL is the only credential the
   * chunks and the completion need, so keep it private. The session
   * expires 24 hours (the server's `storage.upload_session_ttl`) after
   * it was opened.
   */
  onSession?: (sessionUrl: string) => void
}

/** Options of `resumeUpload`. */
export interface ResumeUploadOptions {
  /** Bytes per request (default 8 MiB). */
  chunkSize?: number
  /** Called with the offset the server holds when the upload resumes, then after every chunk it stored. */
  onProgress?: (sent: number, total: number) => void
  /** How many times a failed chunk is retried after asking the server for its offset (default 5). */
  retries?: number
  signal?: AbortSignal
  /** The fetch to use (default: the global one). */
  fetch?: typeof fetch
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
        "azora: file storage needs the engine's HTTP address: connect with an http(s) URL (https://db.example.com/<database>), or set the storageUrl option",
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
    const headers: Record<string, string> = {
      'Content-Type': o.contentType ?? (body instanceof Blob && body.type ? body.type : 'application/octet-stream'),
    }
    if (o.sha256) headers['X-Azora-SHA256'] = o.sha256
    const res = await this.request(
      this.url(`b/${this.db}/objects`, {
        bucket: o.bucket,
        path: o.path,
        name: o.name,
        overwrite: o.overwrite,
        content_type: o.contentType,
      }),
      {
        method: 'POST',
        headers,
        body: b.body,
        ...(b.stream ? { duplex: 'half' as const } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
    )
    return toObject(((await res.json()) as { object: WireObject }).object)
  }

  /**
   * Uploads a large file in chunks through a resumable session: a chunk
   * that fails is retried from the offset the server reports, so a broken
   * connection costs at most one chunk. To continue after your own
   * process or page ends, store the URL `onSession` reports and pass it
   * to `resumeUpload` with the same content.
   */
  async uploadResumable(
    body: Blob | ArrayBuffer | ArrayBufferView,
    o: ResumableUploadOptions = {},
  ): Promise<StoredObject> {
    const blob = body instanceof Blob ? body : new Blob([body as BlobPart])
    const sig = o.signal ? { signal: o.signal } : {}
    const headers: Record<string, string> = { 'Upload-Length': String(blob.size) }
    const type = o.contentType ?? (body instanceof Blob ? body.type : '')
    if (type) headers['X-Azora-Content-Type'] = type
    if (o.sha256) headers['X-Azora-SHA256'] = o.sha256
    const open = await this.request(
      this.url(`b/${this.db}/sessions`, { bucket: o.bucket, path: o.path, name: o.name, overwrite: o.overwrite }),
      { method: 'POST', headers, ...sig },
    )
    const location = open.headers.get('Location') ?? ((await open.json()) as { session: { url: string } }).session.url
    o.onSession?.(location)
    return sendToSession(this.fetchImpl ?? globalThis.fetch, location, blob, 0, o)
  }

  /** `resumeUpload`, reachable from the class: see the function of that name. */
  static resumeUpload(
    sessionUrl: string,
    body: Blob | ArrayBuffer | ArrayBufferView,
    o: ResumeUploadOptions = {},
  ): Promise<StoredObject> {
    return resumeUpload(sessionUrl, body, o)
  }

  /**
   * Downloads an object's content as a fetch `Response` (`.bytes()`,
   * `.text()`, `.body` for streaming). `range` asks for bytes
   * `[start, end]` (end inclusive, optional).
   */
  async download(id: string, o: { range?: readonly [number, number?]; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (o.range) headers['Range'] = `bytes=${o.range[0]}-${o.range[1] ?? ''}`
    return this.request(this.url(`b/${this.db}/objects/${encodeURIComponent(id)}/content`), {
      headers,
      ...(o.signal ? { signal: o.signal } : {}),
    })
  }

  /** Describes an object. */
  async stat(id: string, o: { signal?: AbortSignal } = {}): Promise<StoredObject> {
    const res = await this.request(
      this.url(`b/${this.db}/objects/${encodeURIComponent(id)}`),
      o.signal ? { signal: o.signal } : {},
    )
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
      body: JSON.stringify({
        id,
        ttl_seconds: o.ttlSeconds ?? 0,
        download: o.download ?? false,
        filename: o.filename ?? '',
      }),
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
        bucket: g.bucket,
        path: g.path,
        overwrite: g.overwrite,
        allowed_types: g.allowedTypes,
        max_size: g.maxSize,
        keep: g.keep,
        metadata: g.metadata,
        table: g.table,
        column: g.column,
        key: g.key,
        key_value: g.keyValue,
        ttl_seconds: g.ttlSeconds ?? 0,
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
 * The URL that opens resumable upload sessions under the grant of a
 * signed upload URL: the same query (the signature does not cover the
 * path) under `/storage/v1/s/` instead of `/storage/v1/u/`. "" when the
 * URL is not a signed upload URL.
 */
export function sessionUrlOf(signedUploadUrl: string): string {
  const q = signedUploadUrl.indexOf('?')
  const base = q < 0 ? signedUploadUrl : signedUploadUrl.slice(0, q)
  const i = base.lastIndexOf('/storage/v1/u/')
  if (i < 0 || q < 0) return ''
  return base.slice(0, i) + '/storage/v1/s/' + base.slice(i + '/storage/v1/u/'.length) + signedUploadUrl.slice(q)
}

/** A session answers `not_found` once it expired, was completed or was aborted. */
function sessionGone(e: unknown): unknown {
  if (!(e instanceof AzoraError) || e.status !== 404) return e
  return new AzoraError(
    ErrorCode.NotFound,
    'azora: storage: the upload session is gone: it expired, was completed or was aborted; start the upload again',
    { status: 404 },
  )
}

/**
 * Sends the bytes of `blob` from `offset` on to an open session in
 * chunks, then completes it. The session's URL authorises the requests:
 * no credential is sent.
 */
async function sendToSession(
  f: typeof fetch,
  location: string,
  blob: Blob,
  offset: number,
  o: { chunkSize?: number; onProgress?: (sent: number, total: number) => void; retries?: number; signal?: AbortSignal },
): Promise<StoredObject> {
  const total = blob.size
  const chunk = Math.max(64 << 10, o.chunkSize ?? 8 << 20)
  const sig = o.signal ? { signal: o.signal } : {}
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const res = await f(url, { ...init, ...sig })
    if (!res.ok) throw await failure(res)
    return res
  }
  let failures = 0
  while (offset < total) {
    try {
      const res = await request(location, {
        method: 'PATCH',
        headers: { 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
        body: blob.slice(offset, offset + chunk),
      })
      offset = Number(res.headers.get('Upload-Offset') ?? offset + Math.min(chunk, total - offset))
      failures = 0
      o.onProgress?.(offset, total)
    } catch (e) {
      if (o.signal?.aborted || ++failures > (o.retries ?? 5)) throw e
      if (e instanceof AzoraError && e.status !== undefined && e.status !== 409 && e.status < 500 && e.status !== 429)
        throw sessionGone(e)
      await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** failures, 5000)))
      // Ask where the session is: bytes received before the failure are kept.
      const head = await request(location, { method: 'HEAD' })
      offset = Number(head.headers.get('Upload-Offset') ?? offset)
    }
  }
  if (offset > total) {
    throw new AzoraError(
      ErrorCode.Invalid,
      `azora: storage: the session holds ${offset} bytes, more than the ${total} to upload`,
    )
  }
  const done = await request(`${location}/complete`, { method: 'POST' }).catch((e: unknown) => {
    throw sessionGone(e)
  })
  return toObject(((await done.json()) as { object: WireObject }).object)
}

/**
 * Continues a resumable upload from its session URL (what `onSession` of
 * `uploadResumable` reported), in another process or page load: it asks
 * the server how many bytes it holds, uploads the rest of `body` in
 * chunks and resolves to the stored object. `body` must be the same
 * content the upload started with.
 *
 * Needs no credentials: the session URL carries the right to append to
 * and complete the upload, so keep it private (do not log it or put it
 * where other users can read it). A session expires 24 hours (the
 * server's `storage.upload_session_ttl`) after it was opened, whatever
 * its progress; one that expired, was completed or was aborted fails
 * with a `not_found` error, a body whose length is not the one the
 * session was opened with fails with `invalid` before a byte is sent.
 */
export async function resumeUpload(
  sessionUrl: string,
  body: Blob | ArrayBuffer | ArrayBufferView,
  o: ResumeUploadOptions = {},
): Promise<StoredObject> {
  const f = o.fetch ?? globalThis.fetch
  const blob = body instanceof Blob ? body : new Blob([body as BlobPart])
  const total = blob.size
  const head = await f(sessionUrl, { method: 'HEAD', ...(o.signal ? { signal: o.signal } : {}) })
  if (!head.ok) throw sessionGone(await failure(head))
  const offset = Number(head.headers.get('Upload-Offset') ?? 0)
  const declared = Number(head.headers.get('Upload-Length') ?? 0)
  if (!Number.isFinite(offset) || offset < 0) {
    throw new AzoraError(ErrorCode.Internal, "azora: storage: the server did not report the session's offset")
  }
  if (declared > 0 && declared !== total) {
    throw new AzoraError(
      ErrorCode.Invalid,
      `azora: storage: the body is ${total} bytes but the session was opened for ${declared}: resume with the same content`,
    )
  }
  if (offset > total) {
    throw new AzoraError(
      ErrorCode.Invalid,
      `azora: storage: the session holds ${offset} bytes, more than the ${total} of the body: resume with the same content`,
    )
  }
  o.onProgress?.(offset, total)
  return sendToSession(f, sessionUrl, blob, offset, o)
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
    headers: {
      'Content-Type': o.contentType ?? (body instanceof Blob && body.type ? body.type : 'application/octet-stream'),
    },
    body: body as BodyInit,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  if (!res.ok) throw await failure(res)
  return toObject(((await res.json()) as { object: WireObject }).object)
}
