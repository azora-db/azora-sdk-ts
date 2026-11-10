/**
 * Connecting with the two values: a URL (where the database is) and a
 * token (who the client is). Covers the token option, connectEnv, and
 * discovery of the server key for a URL without one.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolveOptions } from '../../src/config.ts'
import { Discovery } from '../../src/discovery.ts'
import { connect, connectEnv, ConnectionError, HandshakeError, type ConnectOptions, type Database } from '../../src/index.ts'
import { MsgType } from '../../src/messages.ts'
import { FakeServer } from '../helpers/fake-server.ts'
import { KeyedServer } from '../helpers/keyed-server.ts'
import { until } from '../helpers/wait.ts'

let open: Database[] = []
const keep = (db: Database): Database => (open.push(db), db)
afterEach(async () => {
  await Promise.all(open.map((d) => d.close()))
  open = []
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that records the URLs asked and answers with what `answer` returns. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const f = async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(String(input))
    return answer(String(input))
  }
  return { fetch: f as typeof fetch, urls }
}

describe('the token option', () => {
  const hello = async (o: Partial<ConnectOptions>): Promise<string> => {
    const s = new FakeServer()
    keep(await connect('http://10.0.0.5:8090/shop?plaintext=1', { transport: s.transport, ...o }))
    const m = s.last.received[0]
    return m?.type === MsgType.Hello ? m.credential : ''
  }

  test('takes an API key or a client token, as a string or a function; apiKey is an alias', async () => {
    expect(await hello({ token: 'azk_live_key' })).toBe('azk_live_key')
    expect(await hello({ token: 'azt1.client.token' })).toBe('azt1.client.token')
    expect(await hello({ token: () => 'azk_from_function' })).toBe('azk_from_function')
    expect(await hello({ token: async () => 'azt1.async' })).toBe('azt1.async')
    expect(await hello({ apiKey: 'azk_alias' })).toBe('azk_alias')
  })

  test('giving both token and apiKey, or neither, is an error', async () => {
    await expect(hello({ token: 'a', apiKey: 'b' })).rejects.toThrow(/give one of token, apiKey/)
    await expect(hello({})).rejects.toThrow(/credential is required: the token option/)
  })
})

describe('connectEnv', () => {
  test('reads AZORA_URL and AZORA_TOKEN', async () => {
    const s = new FakeServer()
    vi.stubEnv('AZORA_URL', 'http://10.0.0.5:8090/shop?plaintext=1')
    vi.stubEnv('AZORA_TOKEN', 'azk_from_env')
    vi.stubEnv('AZORA_API_KEY', 'azk_ignored')
    const db = keep(await connectEnv({ transport: s.transport, clientName: 'env-test/1' }))
    expect(db.name).toBe('shop')
    expect(s.last.received[0]).toMatchObject({ type: MsgType.Hello, database: 'shop', credential: 'azk_from_env', client: 'env-test/1' })
  })

  test('falls back to AZORA_API_KEY; a credential in options wins over the environment', async () => {
    const s = new FakeServer()
    vi.stubEnv('AZORA_URL', 'http://10.0.0.5:8090/shop?plaintext=1')
    vi.stubEnv('AZORA_TOKEN', '')
    vi.stubEnv('AZORA_API_KEY', 'azk_old_name')
    keep(await connectEnv({ transport: s.transport }))
    expect(s.last.received[0]).toMatchObject({ credential: 'azk_old_name' })
    vi.stubEnv('AZORA_TOKEN', 'azk_from_env')
    keep(await connectEnv({ transport: s.transport, token: () => 'azt1.from.options' }))
    expect(s.last.received[0]).toMatchObject({ credential: 'azt1.from.options' })
  })

  test('names the missing variable', async () => {
    vi.stubEnv('AZORA_URL', '')
    vi.stubEnv('AZORA_TOKEN', 'azk_x')
    vi.stubEnv('AZORA_API_KEY', '')
    await expect(connectEnv()).rejects.toThrow(/AZORA_URL is not set/)
    vi.stubEnv('AZORA_URL', 'http://10.0.0.5:8090/shop?plaintext=1')
    vi.stubEnv('AZORA_TOKEN', '')
    await expect(connectEnv()).rejects.toThrow(/AZORA_TOKEN is not set/)
  })

  test('where there is no process (a browser) it fails with the same clear error', async () => {
    vi.stubGlobal('process', undefined)
    const attempt = connectEnv()
    vi.unstubAllGlobals()
    await expect(attempt).rejects.toThrow(/AZORA_URL is not set/)
  })
})

describe('discovery: a URL without a server key', () => {
  test('over https the key and the WebSocket path come from /.well-known/azora.json', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    const db = keep(await connect('https://db.example.com/shop', { token: 'azk_k', transport: server.transport, fetch }))
    expect(urls).toEqual(['https://db.example.com/.well-known/azora.json'])
    expect(db.session).toMatchObject({ mode: 'IK', serverKey: server.serverKey, principal: 'azk_k' })
    expect(await db.queryValue('SELECT 1')).toBe('SELECT 1')

    // The document's path is used, under the URL's prefix; an explicit webSocketUrl option stays.
    const custom = fakeFetch(() => json(server.document('/realtime/v2')))
    const ac = new AbortController()
    const o = resolveOptions({ url: 'https://example.com/azora/eu/shop', token: 't', fetch: custom.fetch })
    expect(o).toMatchObject({ storageUrl: 'https://example.com/azora/eu', discovery: { base: 'https://example.com/azora/eu' } })
    const at = await new Discovery(o).get(ac.signal)
    expect(custom.urls).toEqual(['https://example.com/azora/eu/.well-known/azora.json'])
    expect(at.webSocketUrl).toBe('wss://example.com/azora/eu/realtime/v2')
    expect(at.security.serverKey).toHaveLength(32)
    const fixed = resolveOptions({ url: 'https://example.com/shop', token: 't', fetch: custom.fetch, webSocketUrl: 'wss://rt.example.com/rt/v1' })
    expect((await new Discovery(fixed).get(ac.signal)).webSocketUrl).toBe('wss://rt.example.com/rt/v1')
  })

  test('over plain http it is allowed for loopback hosts only', async () => {
    const server = new KeyedServer()
    for (const host of ['localhost:8090', '127.0.0.1:8090', '127.8.9.10', '[::1]:8090', 'LOCALHOST']) {
      const { fetch, urls } = fakeFetch(() => json(server.document()))
      const db = keep(await connect(`http://${host}/shop`, { token: 'k', transport: server.transport, fetch }))
      expect(urls, host).toEqual([`http://${host.toLowerCase()}/.well-known/azora.json`])
      expect(db.session?.serverKey, host).toBe(server.serverKey)
    }
  })

  test('over plain http to another machine it is refused before any network call', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    let dialed = 0
    const transport: ConnectOptions['transport'] = (signal) => (dialed++, server.transport(signal))
    for (const host of ['db.example.com', '10.0.0.5:8090', '192.168.1.20', '128.0.0.1', 'localhost.example.com', '[::2]', '0.0.0.0:8090']) {
      const err = await connect(`http://${host}/shop`, { token: 'k', transport, fetch }).catch((e: unknown) => e)
      expect(err, host).toBeInstanceOf(TypeError)
      expect((err as Error).message, host).toMatch(/has no server key: add \?key=<server key> to the URL/)
      expect((err as Error).message, host).toMatch(/only over https or for a loopback address/)
    }
    expect(urls).toEqual([])
    expect(dialed).toBe(0)
  })

  test('a URL or options that name the key ask nothing', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    const o = { token: 'k', transport: server.transport, fetch }
    expect(keep(await connect(`http://db.example.com/shop?key=${server.serverKey}`, o)).session?.mode).toBe('IK')
    expect(keep(await connect(`https://db.example.com/shop?key=${server.serverKey}`, o)).session?.mode).toBe('IK')
    expect(keep(await connect('http://db.example.com/shop', { ...o, serverKey: server.serverKey })).session?.mode).toBe('IK')
    expect(resolveOptions({ url: 'http://db.example.com/shop?fp=azp1-aaaa-bbbb-cccc-dddd-eeee-ffff', token: 'k' }).discovery).toBeNull()
    expect(resolveOptions({ url: 'http://db.example.com/shop', fingerprint: 'azp1-aaaa-bbbb-cccc-dddd-eeee-ffff', token: 'k' }).discovery).toBeNull()
    expect(resolveOptions({ url: 'http://db.example.com/shop?plaintext=1', token: 'k' })).toMatchObject({ discovery: null, security: { allowPlaintext: true } })
    // The other URL forms never discover: without a key they are refused as before.
    expect(() => resolveOptions({ url: 'wss://db.example.com/rt/v1?db=shop', token: 'k' })).toThrow(/serverKey/)
    expect(() => resolveOptions({ url: 'azora://localhost/shop', token: 'k' })).toThrow(/serverKey/)
    expect(urls).toEqual([])
  })

  test('a failed or invalid answer is a clear connect error', async () => {
    const server = new KeyedServer()
    const good = server.document()
    const cases: Array<[string, () => Response | Promise<Response>, RegExp]> = [
      ['not found', () => new Response('404 page not found', { status: 404 }), /HTTP 404: this server does not publish its key; add \?key=/],
      ['server error', () => new Response('no active server key', { status: 503 }), /HTTP 503/],
      ['not JSON', () => new Response('<html>hello</html>'), /not JSON/],
      ['not an object', () => json([good]), /not a discovery document/],
      ['another version', () => json({ ...good, azora: 2 }), /unsupported document version 2/],
      ['no version', () => json({ server_key: good['server_key'], websocket: '/rt/v1' }), /unsupported document version/],
      ['no key', () => json({ azora: 1, websocket: '/rt/v1' }), /"server_key" is not a base64 32-byte key/],
      ['a short key', () => json({ ...good, server_key: 'c2hvcnQ' }), /"server_key" is not a base64 32-byte key/],
      ['no path', () => json({ azora: 1, server_key: good['server_key'] }), /"websocket" is not a path/],
      ['another host as path', () => json({ ...good, websocket: '//evil.example/rt/v1' }), /"websocket" is not a path/],
      ['a URL as path', () => json({ ...good, websocket: 'wss://evil.example/rt/v1' }), /"websocket" is not a path/],
      ['unreachable', () => Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 203.0.113.9:443') })), /fetch failed \(connect ECONNREFUSED/],
      ['redirected to plain http', () => Object.defineProperties(json(good), { redirected: { value: true }, url: { value: 'http://elsewhere.example/.well-known/azora.json' } }), /redirected to http:\/\/elsewhere.example, which is not https/],
    ]
    for (const [name, answer, want] of cases) {
      const { fetch, urls } = fakeFetch(answer)
      const err = await connect('https://db.example.com/shop', { token: 'k', transport: server.transport, fetch }).catch((e: unknown) => e)
      expect(err, name).toBeInstanceOf(ConnectionError)
      expect((err as Error).message, name).toMatch(/^azora: discovery: https:\/\/db\.example\.com\/\.well-known\/azora\.json: /)
      expect((err as Error).message, name).toMatch(want)
      expect(urls, name).toHaveLength(1)
    }
    expect(server.accepted + server.refused).toBe(0)
  })

  test('a document with the wrong key fails the handshake', async () => {
    const server = new KeyedServer()
    const stranger = new KeyedServer()
    const { fetch } = fakeFetch(() => json(stranger.document()))
    await expect(connect('https://db.example.com/shop', { token: 'k', transport: server.transport, fetch })).rejects.toBeInstanceOf(HandshakeError)
    expect(server.refused).toBe(1)
  })

  test('after a failed handshake on reconnect the server is asked again (a rotated key)', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    const errors: Error[] = []
    const db = keep(await connect('https://db.example.com/shop', {
      token: 'k', transport: server.transport, fetch, reconnectMinMs: 1, reconnectMaxMs: 5, onError: (e) => errors.push(e),
    }))
    const first = server.serverKey

    // A dropped connection alone does not ask again: the key still works.
    server.dropAll()
    await until(() => db.stats.connects === 2, 'the reconnect')
    expect(urls).toHaveLength(1)
    expect(db.session?.serverKey).toBe(first)

    // The server comes back with another key: one refused handshake, one new question, connected again.
    server.rotate()
    server.dropAll()
    await until(() => db.stats.connects === 3, 'the reconnect with the new key')
    expect(urls).toHaveLength(2)
    expect(server.refused).toBe(1)
    expect(errors.map((e) => e.constructor)).toEqual([HandshakeError])
    expect(db.session?.serverKey).toBe(server.serverKey)
    expect(db.session?.serverKey).not.toBe(first)
    expect(await db.queryValue('SELECT 2')).toBe('SELECT 2')
  })

  test('a pool asks once, and once again after a rotation', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    const db = keep(await connect('http://localhost:8090/shop', {
      token: 'k', transport: server.transport, fetch, pool: 4, reconnectMinMs: 1, reconnectMaxMs: 5, onError: () => {},
    }))
    expect(db.stats.connects).toBe(4)
    expect(urls).toHaveLength(1)
    server.rotate()
    server.dropAll()
    await until(() => db.stats.connects === 8, 'four reconnects')
    expect(urls).toHaveLength(2)
  })

  test('a pinned key is never replaced: a rotated key keeps failing', async () => {
    const server = new KeyedServer()
    const { fetch, urls } = fakeFetch(() => json(server.document()))
    const errors: Error[] = []
    const db = keep(await connect(`https://db.example.com/shop?key=${server.serverKey}`, {
      token: 'k', transport: server.transport, fetch, reconnectMinMs: 1, reconnectMaxMs: 5, onError: (e) => errors.push(e),
    }))
    server.rotate()
    server.dropAll()
    await until(() => errors.length >= 3, 'refused reconnects')
    expect(errors.every((e) => e instanceof HandshakeError)).toBe(true)
    expect(db.connected).toBe(false)
    expect(urls).toEqual([])
  })
})
