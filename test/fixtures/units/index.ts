/** Units for the integration tests: the example shop's, and a few that probe the engine. */
import { httpResponse, mutation, query, UnitError, v } from '@azora-db/units'

export * from '../../../examples/units/units/index.ts'

/** Returns its argument (blobs included). */
export const echo = query({ args: v.any(), handler: (_ctx, a) => a })

/** Who called, as the unit sees it. */
export const whoami = query({
  handler: (ctx) => ({ kind: ctx.auth.kind, principal: ctx.auth.principal, subject: ctx.auth.subject, unit: ctx.unit.name, trigger: ctx.unit.trigger }),
})

/** Counts its runs: a retried call with the same mutation id must not count twice. */
export const bump = mutation({
  args: { by: v.int({ min: 1 }) },
  handler: (ctx, { by }) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET n = n + excluded.n', by)
    return { n: ctx.db.value<number>('SELECT n FROM counter WHERE id = 1'), mutationId: ctx.unit.mutationId }
  },
})

/** Writes, then throws: the write must roll back. */
export const boom = mutation({
  handler: (ctx) => {
    ctx.db.exec('INSERT INTO counter(id, n) VALUES (99, 1)')
    throw new Error('boom')
  },
})

/** Throws a UnitError with data. */
export const refuse = query({ handler: () => { throw new UnitError('conflict', 'already paid', { order: 7 }) } })

/** Whether a secret is set (never its value). */
export const hasSecret = query({ args: { name: v.string() }, handler: (ctx, { name }) => ctx.env[name] !== undefined })

// Files (ctx.storage). The docs table has a FILE column.

const fileView = (f: { bucket: string; path: string; name: string; contentType: string; size: number; sha256: string; metadata: Record<string, string> } | null) =>
  f && { bucket: f.bucket, path: f.path, name: f.name, contentType: f.contentType, size: f.size, sha256: f.sha256, metadata: f.metadata }

/** Stores a file with the row that references it, in one transaction. */
export const saveDoc = mutation({
  args: { title: v.string(), text: v.string() },
  handler: (ctx, { title, text }) => {
    const up = ctx.storage.upload(text, { name: `${title}.txt`, contentType: 'text/plain', metadata: { title } })
    return { id: ctx.db.exec('INSERT INTO docs(title, file) VALUES (?, ?)', title, up).lastInsertId }
  },
})

/** Reads a row's file: attributes, content, a signed link. */
export const readDoc = query({
  args: { id: v.int() },
  handler: (ctx, { id }) => {
    const fileId = ctx.db.value<string>('SELECT file FROM docs WHERE id = ?', id)
    if (!fileId) throw new UnitError('not_found', 'no such document')
    return {
      file: fileView(ctx.storage.stat(fileId)),
      text: ctx.storage.text(fileId),
      bytes: ctx.storage.read(fileId).length,
      link: /^https?:\/\/.+\/storage\/v1\/o\//.test(ctx.storage.url(fileId, { ttl: 60 })),
      missing: ctx.storage.stat('obj_nope'),
    }
  },
})

/** A file on its own, at a path. */
export const putReport = mutation({
  args: { path: v.string(), text: v.string() },
  handler: (ctx, { path, text }) => fileView(ctx.storage.put(text, { path, contentType: 'text/plain' })),
})

export const findReport = query({ args: { path: v.string() }, handler: (ctx, { path }) => fileView(ctx.storage.statPath(path)) })

/** Deletes the report at a path; false when there is none. */
export const dropReport = mutation({
  args: { path: v.string() },
  handler: (ctx, { path }) => {
    const f = ctx.storage.statPath(path)
    return f ? ctx.storage.delete(f.id) : false
  },
})

/** Stores a file, then throws: the file must not be there afterwards. */
export const putThenFail = mutation({
  args: { path: v.string() },
  handler: (ctx, { path }) => {
    ctx.storage.put('never stored', { path })
    throw new UnitError('conflict', 'changed my mind')
  },
})

/** A query cannot store files. */
export const queryPut = query({ handler: (ctx) => (ctx.storage as unknown as { put(c: string): unknown }).put('x') })

/** Reading a file that is not there. */
export const readMissing = query({ handler: (ctx) => ctx.storage.text('obj_nope') })

/** A link the caller can upload with, for a grant the unit chose. */
export const avatarUpload = mutation({
  handler: (ctx) => {
    const g = ctx.storage.uploadUrl({ max_size: 1 << 20, allowed_types: 'image/*' }, { ttl: 300 })
    return { link: /^https?:\/\/.+\/storage\/v1\/u\//.test(g.url), inFuture: g.expiresAt > ctx.now() }
  },
})

// Plain HTTP (units that declare http).

/** What an HTTP caller sent, as the unit sees it. No credential needed. */
export const httpEcho = query({
  http: 'public',
  handler: (ctx, args: unknown) => {
    const r = ctx.request
    return { args: args ?? null, method: r?.method, path: r?.path, query: r?.query, body: r?.body, test: r?.headers['x-test'] ?? null, kind: ctx.auth.kind, via: ctx.unit.trigger }
  },
})

/** Needs a credential; its arguments come from the JSON body. */
export const httpSum = query({
  http: true,
  args: { a: v.number(), b: v.number() },
  handler: (_ctx, { a, b }) => ({ sum: a + b }),
})

/** A webhook: verifies a signature over the raw body, then answers with a status of its own. */
export const httpHook = mutation({
  http: 'public',
  handler: (ctx, event: { type?: string }) => {
    const r = ctx.request
    if (!r) throw new UnitError('invalid', 'call me over HTTP')
    const want = ctx.crypto.hmac(ctx.env['HOOK_SECRET'] ?? '', r.body)
    if (!ctx.crypto.timingSafeEqual(want, r.headers['x-signature'] ?? '')) throw new UnitError('permission_denied', 'bad signature')
    ctx.db.exec('INSERT INTO audit(at, what, detail) VALUES (?, ?, ?)', ctx.now(), 'hook', event.type ?? '')
    return httpResponse(`accepted ${event.type ?? ''}`, { status: 202, headers: { 'X-Handled': 'yes' } })
  },
})
