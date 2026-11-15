import { describe, expect, test } from 'vitest'
import { AzoraError } from '../../src/errors.ts'
import { resumeUpload, Storage } from '../../src/storage.ts'

const URL_ = 'http://db.test/storage/v1/s/shop/sess1'
const CHUNK = 64 << 10

/** A fake session endpoint: it holds `offset` bytes of a `size` byte upload. */
function fakeSession(o: { offset: number; size: number; gone?: boolean }) {
  const calls: string[] = []
  const received: Uint8Array[] = []
  let offset = o.offset
  const headers = (): Record<string, string> => ({ 'Upload-Offset': String(offset), ...(o.size ? { 'Upload-Length': String(o.size) } : {}) })
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.slice(URL_.length) || '/'}`)
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    if (o.gone) {
      const gone = { error: { code: 'not_found', message: 'upload session not found or expired' } }
      return new Response(method === 'HEAD' ? null : JSON.stringify(gone), { status: 404 })
    }
    if (method === 'HEAD') return new Response(null, { status: 200, headers: headers() })
    if (method === 'PATCH') {
      const at = Number(new Headers(init?.headers).get('Upload-Offset'))
      if (at !== offset) return new Response(JSON.stringify({ error: { code: 'offset_mismatch', message: 'wrong offset' } }), { status: 409, headers: headers() })
      const part = new Uint8Array(await (init?.body as Blob).arrayBuffer())
      received.push(part)
      offset += part.length
      return new Response(null, { status: 204, headers: headers() })
    }
    if (method === 'POST' && url === `${URL_}/complete`) {
      const now = '2026-01-01T00:00:00Z'
      const object = { id: 'obj1', bucket: 'default', name: 'f.bin', content_type: 'application/octet-stream', size: offset, sha256: 'ab', refs: 0, auto_delete: true, created_at: now, updated_at: now }
      return new Response(JSON.stringify({ object }), { status: 201 })
    }
    return new Response(null, { status: 500 })
  }
  return { fetch: fetchStub, calls, bytes: () => new Uint8Array(received.flatMap((p) => [...p])) }
}

const content = new Uint8Array(3 * CHUNK + 100).map((_, i) => (i * 7) % 256)

describe('resumeUpload', () => {
  test('from offset 0 sends everything', async () => {
    const s = fakeSession({ offset: 0, size: content.length })
    const progress: number[] = []
    const obj = await resumeUpload(URL_, content, { fetch: s.fetch, chunkSize: CHUNK, onProgress: (sent, total) => progress.push(sent, total) })
    expect(obj).toMatchObject({ id: 'obj1', size: content.length, contentType: 'application/octet-stream' })
    expect(s.calls).toEqual(['HEAD /', 'PATCH /', 'PATCH /', 'PATCH /', 'PATCH /', 'POST /complete'])
    expect(s.bytes()).toEqual(content)
    expect(progress.filter((_, i) => i % 2 === 0)).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK, content.length])
    expect(new Set(progress.filter((_, i) => i % 2 === 1))).toEqual(new Set([content.length]))
  })

  test('from the middle sends only the rest, and progress starts at the offset', async () => {
    const at = CHUNK + 5000
    const s = fakeSession({ offset: at, size: content.length })
    const progress: number[] = []
    await Storage.resumeUpload(URL_, new Blob([content]), { fetch: s.fetch, chunkSize: CHUNK, onProgress: (sent) => progress.push(sent) })
    expect(s.bytes()).toEqual(content.subarray(at))
    expect(progress[0]).toBe(at)
    expect(progress.at(-1)).toBe(content.length)
    expect(s.calls.filter((c) => c === 'PATCH /')).toHaveLength(2)
  })

  test('an upload the server holds entirely is only completed', async () => {
    const s = fakeSession({ offset: content.length, size: content.length })
    const progress: number[] = []
    const obj = await resumeUpload(URL_, content.buffer, { fetch: s.fetch, onProgress: (sent) => progress.push(sent) })
    expect(obj.size).toBe(content.length)
    expect(s.calls).toEqual(['HEAD /', 'POST /complete'])
    expect(progress).toEqual([content.length])
  })

  test('an expired session is a clear not_found error', async () => {
    const s = fakeSession({ offset: 0, size: content.length, gone: true })
    const err = await resumeUpload(URL_, content, { fetch: s.fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AzoraError)
    expect(err).toMatchObject({ code: 'not_found', status: 404 })
    expect((err as Error).message).toMatch(/expired/)
    expect(s.calls).toEqual(['HEAD /'])
  })

  test('a body of another length is refused before a byte is sent', async () => {
    const s = fakeSession({ offset: CHUNK, size: content.length })
    const err = await resumeUpload(URL_, content.subarray(0, content.length - 1), { fetch: s.fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AzoraError)
    expect(err).toMatchObject({ code: 'invalid' })
    expect((err as Error).message).toContain(`opened for ${content.length}`)
    expect(s.calls).toEqual(['HEAD /'])
    // Without a declared size, a body shorter than what the server holds is refused too.
    const undeclared = fakeSession({ offset: 2 * CHUNK, size: 0 })
    await expect(resumeUpload(URL_, content.subarray(0, CHUNK), { fetch: undeclared.fetch })).rejects.toMatchObject({ code: 'invalid' })
    expect(undeclared.calls).toEqual(['HEAD /'])
  })
})

describe('uploadResumable', () => {
  test('reports the session URL before the first chunk', async () => {
    const s = fakeSession({ offset: 0, size: content.length })
    const order: string[] = []
    const f: typeof fetch = async (input, init) => {
      if (String(input).includes('/sessions')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key')
        expect(new Headers(init?.headers).get('Upload-Length')).toBe(String(content.length))
        return new Response(JSON.stringify({ session: { url: URL_ } }), { status: 201, headers: { Location: URL_ } })
      }
      order.push(init?.method ?? 'GET')
      return s.fetch(input, init)
    }
    const storage = new Storage('http://db.test', 'shop', () => 'key', f)
    const obj = await storage.uploadResumable(content, { chunkSize: CHUNK, onSession: (url) => order.push(url) })
    expect(obj.id).toBe('obj1')
    expect(order[0]).toBe(URL_)
    expect(order.slice(1)).toEqual(['PATCH', 'PATCH', 'PATCH', 'PATCH', 'POST'])
    expect(s.bytes()).toEqual(content)
  })
})
