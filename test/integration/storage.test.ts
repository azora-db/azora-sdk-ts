import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { AzoraError, connect, uploadToSignedUrl, type Database } from '../../src/index.ts'
import { resumeUpload } from '../../src/storage.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'

describe.skipIf(!engineBinary())('file storage', () => {
  let engine: Engine
  let db: Database

  beforeAll(async () => {
    engine = await startEngine({
      schema: ['CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, avatar FILE)', "INSERT INTO users(id, name) VALUES (1, 'ann')"],
      publish: [],
      tokens: { writer: ['--sub', 'user:9', '--scope', 'read,write'], reader: ['--sub', 'user:8', '--scope', 'read'] },
    })
    db = await connect(`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, { apiKey: engine.apiKey })
  })
  afterAll(async () => {
    await db?.close()
    await engine?.stop()
  })

  test('upload, stat, download, ranges, list, delete', async () => {
    const obj = await db.storage.upload('hello, storage', { path: 'notes/hello.txt', contentType: 'text/plain' })
    expect(obj).toMatchObject({ bucket: 'default', path: 'notes/hello.txt', name: 'hello.txt', contentType: 'text/plain', size: 14 })
    expect(obj.sha256).toBe(createHash('sha256').update('hello, storage').digest('hex'))
    expect(obj.createdAt).toBeInstanceOf(Date)
    expect(await db.storage.stat(obj.id)).toEqual(obj)
    expect(await (await db.storage.download(obj.id)).text()).toBe('hello, storage')
    expect(await (await db.storage.download(obj.id, { range: [7, 13] })).text()).toBe('storage')
    expect(await (await db.storage.download(obj.id, { range: [7] })).text()).toBe('storage')

    const bytes = new Uint8Array(100_000).map((_, i) => i % 251)
    const bin = await db.storage.upload(bytes, { path: 'data/blob.bin' })
    expect(new Uint8Array(await (await db.storage.download(bin.id)).arrayBuffer())).toEqual(bytes)
    await db.storage.upload(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), { path: 'data/table.csv' })

    expect((await db.storage.list({ prefix: 'data/' })).objects.map((o) => o.path).sort()).toEqual(['data/blob.bin', 'data/table.csv'])
    const page = await db.storage.list({ limit: 2 })
    expect(page.objects).toHaveLength(2)
    expect(page.next).toBeTruthy()
    const all: string[] = []
    for await (const o of db.storage.listAll({ limit: 1 })) all.push(o.path ?? '')
    expect(all.sort()).toEqual(['data/blob.bin', 'data/table.csv', 'notes/hello.txt'])

    await expect(db.storage.upload('again', { path: 'notes/hello.txt' })).rejects.toMatchObject({ status: 409 })
    const replaced = await db.storage.upload('again', { path: 'notes/hello.txt', overwrite: true })
    expect(await (await db.storage.download(replaced.id)).text()).toBe('again')
    await db.storage.delete(bin.id)
    const gone = await db.storage.stat(bin.id).catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(AzoraError)
    expect(gone).toMatchObject({ code: 'not_found', status: 404 })
  })

  test('signed download URLs need no credentials', async () => {
    const obj = await db.storage.upload('signed content', { path: 'signed.txt' })
    const viaHttp = await db.storage.signUrl(obj.id, { ttlSeconds: 60, download: true, filename: 'report.txt' })
    expect(viaHttp.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const res = await fetch(viaHttp.url)
    expect(await res.text()).toBe('signed content')
    expect(res.headers.get('content-disposition')).toContain('report.txt')
    const viaRealtime = await db.signUrl(obj.id, 60)
    expect(await (await fetch(viaRealtime.url)).text()).toBe('signed content')
    const tampered = await fetch(viaHttp.url.replace(/sig=[^&]+/, 'sig=AAAA'))
    expect(tampered.status).toBe(403)
  })

  test('a signed upload URL fills a row column', async () => {
    const grant = await db.storage.signUploadUrl({
      bucket: 'default', maxSize: 1 << 20, allowedTypes: 'image/png', table: 'users', column: 'avatar', keyValue: '1', ttlSeconds: 60,
    })
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const obj = await uploadToSignedUrl(grant.url, png, { contentType: 'image/png' })
    expect(obj.contentType).toBe('image/png')
    expect(await db.queryValue('SELECT avatar FROM users WHERE id = 1')).toBe(obj.id)
    await expect(uploadToSignedUrl(grant.url, 'not a png', { contentType: 'text/plain' })).rejects.toBeInstanceOf(AzoraError)
    const url = await db.queryValue<string>('SELECT azora_url(avatar) FROM users WHERE id = 1')
    expect(new Uint8Array(await (await fetch(url as string)).arrayBuffer())).toEqual(png)
  })

  test('a client token signs an upload URL over the connection', async () => {
    const app = await connect(`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, { token: engine.tokens['writer'] as string })
    const reader = await connect(`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, { token: engine.tokens['reader'] as string })
    try {
      const grant = await app.signUploadUrl({ path: 'from-app/note.txt', maxSize: 64, allowedTypes: 'text/plain', ttlSeconds: 60 })
      expect(grant.url).toContain('/storage/v1/u/shop')
      expect(grant.sessionUrl).toContain('/storage/v1/s/shop')
      expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now())
      const obj = await uploadToSignedUrl(grant.url, 'from the app', { contentType: 'text/plain' })
      expect(obj.path).toBe('from-app/note.txt')
      await expect(uploadToSignedUrl(grant.url, 'x'.repeat(100), { contentType: 'text/plain' })).rejects.toBeInstanceOf(AzoraError)
      // No write scope, no link.
      await expect(reader.signUploadUrl()).rejects.toMatchObject({ code: 'permission_denied' })
      await expect(app.signUploadUrl({ ttlSeconds: -1 })).rejects.toThrow(TypeError)
    } finally {
      await Promise.all([app.close(), reader.close()])
    }
  })

  test('a resumable upload survives a failing chunk', async () => {
    const bytes = new Uint8Array(1_000_000).map((_, i) => (i * 31) % 256)
    let patches = 0
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method === 'PATCH' && ++patches === 3) throw new TypeError('network down')
      return fetch(input, init)
    }
    const flakyDb = await connect(`${engine.wsUrl}?db=shop&key=${engine.serverKey}`, { apiKey: engine.apiKey, fetch: flaky })
    const progress: number[] = []
    const obj = await flakyDb.storage.uploadResumable(bytes, {
      path: 'big/video.bin', chunkSize: 128 << 10, contentType: 'application/octet-stream', onProgress: (sent) => progress.push(sent),
    })
    expect(obj.size).toBe(bytes.length)
    expect(obj.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(patches).toBeGreaterThan(8) // every chunk plus the retried one
    expect(progress.at(-1)).toBe(bytes.length)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    await flakyDb.close()
  })

  test('an aborted resumable upload resumes from its stored session URL alone', async () => {
    const bytes = new Uint8Array(1_000_000).map((_, i) => (i * 17 + 3) % 256)
    const stop = new AbortController()
    let stored = ''
    let sentBefore = 0
    const first = await db.storage
      .uploadResumable(bytes, {
        path: 'big/resumed.bin', chunkSize: 128 << 10, signal: stop.signal,
        onSession: (url) => (stored = url),
        onProgress: (sent) => {
          sentBefore = sent
          if (sent >= 2 * (128 << 10)) stop.abort()
        },
      })
      .catch((e: unknown) => e)
    expect(first).toBeInstanceOf(Error)
    expect(stored).toContain('/storage/v1/s/shop/')
    expect(sentBefore).toBe(2 * (128 << 10))

    // A later process: only the URL and the same bytes, no client, no key.
    const progress: number[] = []
    await expect(resumeUpload(stored, bytes.subarray(0, 999_999))).rejects.toMatchObject({ code: 'invalid' })
    const obj = await resumeUpload(stored, bytes, { chunkSize: 128 << 10, onProgress: (sent) => progress.push(sent) })
    expect(progress[0]).toBe(sentBefore)
    expect(progress.at(-1)).toBe(bytes.length)
    expect(obj).toMatchObject({ path: 'big/resumed.bin', size: bytes.length })
    expect(obj.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(new Uint8Array(await (await db.storage.download(obj.id)).arrayBuffer())).toEqual(bytes)
    // The session ended with its completion.
    await expect(resumeUpload(stored, bytes)).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  test('storage needs an API key and a storage URL', async () => {
    const tcp = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.apiKey })
    await expect(tcp.storage.list()).rejects.toThrow(/storageUrl/)
    await tcp.close()
    const reader = await connect(`${engine.tcpUrl}?key=${engine.serverKey}`, { apiKey: engine.readKey, storageUrl: engine.httpUrl })
    expect((await reader.storage.list()).objects.length).toBeGreaterThan(0)
    await expect(reader.storage.upload('x', { path: 'denied.txt' })).rejects.toMatchObject({ status: 403 })
    await reader.close()
  })
})
