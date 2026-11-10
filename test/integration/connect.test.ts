/**
 * Connecting to a real engine with the two values: the http URL (with a
 * pinned key, and without one on loopback) and a token.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { connect, connectEnv, HandshakeError, type Database } from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'
import { until } from '../helpers/wait.ts'

describe.skipIf(!engineBinary())('connecting with a URL and a token', () => {
  let engine: Engine
  let open: Database[] = []
  const keep = (db: Database): Database => (open.push(db), db)

  beforeAll(async () => {
    engine = await startEngine({
      tokens: { reader: ['--sub', 'user:42', '--scope', 'read', '--ttl', '1h', '--table', 'orders', '--filter', 'orders: customer = 42'] },
    })
  })
  afterEach(async () => {
    await Promise.all(open.map((d) => d.close()))
    open = []
    vi.unstubAllEnvs()
  })
  afterAll(async () => {
    await engine?.stop()
  })

  /** The global fetch, recording the URLs asked. */
  const countingFetch = (): { fetch: typeof fetch; urls: string[] } => {
    const urls: string[] = []
    return { urls, fetch: ((input: RequestInfo | URL, init?: RequestInit) => (urls.push(String(input)), fetch(input, init))) as typeof fetch }
  }

  test('the http URL with a pinned key, a fingerprint, or plaintext', async () => {
    const { fetch, urls } = countingFetch()
    const db = keep(await connect(`${engine.connectUrl}?key=${engine.serverKey}`, { token: engine.apiKey, fetch }))
    expect(db.name).toBe('shop')
    expect(db.session).toMatchObject({ mode: 'IK', serverKey: engine.serverKey, fingerprint: engine.fingerprint })
    expect(db.session?.scopes.sort()).toEqual(['ddl', 'read', 'write'])
    const { lastInsertId } = await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [42, 'open', 12.5])
    expect(await db.queryValue('SELECT total FROM orders WHERE id = ?', [lastInsertId])).toBe(12.5)

    const xx = keep(await connect(`${engine.connectUrl}?fp=${engine.fingerprint}`, { token: engine.readKey, fetch }))
    expect(xx.session).toMatchObject({ mode: 'XX', serverKey: engine.serverKey })
    const plain = keep(await connect(`${engine.connectUrl}?plaintext=1`, { token: engine.readKey, fetch }))
    expect(plain.session?.mode).toBe('plaintext')
    expect(await plain.queryValue('SELECT 7')).toBe(7)
    expect(urls).toEqual([]) // nothing was discovered

    const wrongKey = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk'
    await expect(connect(`${engine.connectUrl}?key=${wrongKey}`, { token: engine.apiKey })).rejects.toBeInstanceOf(HandshakeError)
    await expect(connect(`${engine.httpUrl}/nosuchdb?key=${engine.serverKey}`, { token: engine.apiKey })).rejects.toMatchObject({ name: 'AzoraError' })
    await expect(connect(`${engine.connectUrl}?key=${engine.serverKey}`, { token: 'azk_nope_nope' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test('without a key, the loopback server is asked for it', async () => {
    const doc = (await (await fetch(`${engine.httpUrl}/.well-known/azora.json`)).json()) as Record<string, unknown>
    expect(doc).toEqual({ azora: 1, server_key: engine.serverKey, fingerprint: engine.fingerprint, websocket: '/rt/v1' })

    const { fetch: counting, urls } = countingFetch()
    const db = keep(await connect(engine.connectUrl, { token: engine.apiKey, fetch: counting }))
    expect(urls).toEqual([`${engine.httpUrl}/.well-known/azora.json`])
    expect(db.session).toMatchObject({ mode: 'IK', serverKey: engine.serverKey, fingerprint: engine.fingerprint })
    expect(await db.queryValue('SELECT count(*) FROM orders')).toBeGreaterThanOrEqual(0)

    // The same through `localhost`, with the runtime's own fetch and a pool.
    const pooled = keep(await connect(`http://localhost:${new URL(engine.httpUrl).port}/shop`, { token: engine.readKey, pool: 3 }))
    expect(pooled.session).toMatchObject({ mode: 'IK', serverKey: engine.serverKey })
    expect(pooled.stats.connects).toBe(3)

    // Nothing answers on this port: the error names the discovery URL.
    await expect(connect('http://127.0.0.1:1/shop', { token: engine.apiKey, timeoutMs: 5000 })).rejects.toThrow(
      /discovery: http:\/\/127\.0\.0\.1:1\/\.well-known\/azora\.json/,
    )
  })

  test('file storage goes through the same URL, with no storageUrl', async () => {
    for (const url of [`${engine.connectUrl}?key=${engine.serverKey}`, engine.connectUrl]) {
      const db = keep(await connect(url, { token: engine.apiKey }))
      const path = `notes/${url.includes('?') ? 'pinned' : 'discovered'}.txt`
      const obj = await db.storage.upload('one address for everything', { path, contentType: 'text/plain' })
      expect(obj).toMatchObject({ path, size: 26, contentType: 'text/plain' })
      expect(await (await db.storage.download(obj.id)).text()).toBe('one address for everything')
      const signed = await db.storage.signUrl(obj.id, { ttlSeconds: 60 })
      expect(await (await fetch(signed.url)).text()).toBe('one address for everything')
      expect((await db.storage.list({ prefix: 'notes/' })).objects.map((o) => o.path)).toContain(path)
      await db.storage.delete(obj.id)
    }
  })

  test('the same URL with a client token', async () => {
    const url = `${engine.connectUrl}?key=${engine.serverKey}`
    const backend = keep(await connect(url, { token: engine.apiKey }))
    const user = keep(await connect(url, { token: () => engine.tokens['reader'] as string }))
    expect(user.session).toMatchObject({ principal: 'user:42', scopes: ['read'], mode: 'IK' })
    const mine = await user.live<{ id: number; customer: number }>('orders')
    const before = mine.size
    await backend.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [43, 'theirs', 1])
    await backend.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [42, 'mine', 2])
    await until(() => mine.size === before + 1, 'the row of customer 42')
    expect(mine.rows.every((o) => o.customer === 42)).toBe(true)
    await expect(user.query('SELECT * FROM orders')).rejects.toMatchObject({ code: 'permission_denied' })
    await mine.close()
  })

  test('connectEnv with the two lines `azora connect` prints', async () => {
    // The CLI needs the data-root lock: stop the server for it.
    await engine.stop()
    const printed = engine.cli('connect', 'shop', '--key', 'sdk', '--scope', 'read,write', '--url', engine.httpUrl)
    await engine.start()
    const lines = printed.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`AZORA_URL=${engine.connectUrl}?key=${engine.serverKey}`)
    expect(lines[1]).toMatch(/^AZORA_TOKEN=azk_\S+$/)
    vi.stubEnv('AZORA_API_KEY', '')
    for (const line of lines) vi.stubEnv(line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1))

    const db = keep(await connectEnv())
    expect(db.name).toBe('shop')
    expect(db.session).toMatchObject({ mode: 'IK', serverKey: engine.serverKey })
    expect(db.session?.scopes.sort()).toEqual(['read', 'write'])
    await db.exec('INSERT INTO plain(v) VALUES (?)', ['from the environment'])
    expect(await db.queryValue('SELECT count(*) FROM plain WHERE v = ?', ['from the environment'])).toBe(1)
    const obj = await db.storage.upload('env', { path: 'env.txt' })
    expect(await (await db.storage.download(obj.id)).text()).toBe('env')

    // AZORA_URL without the key works too on loopback; AZORA_API_KEY is the older name of the token.
    vi.stubEnv('AZORA_URL', engine.connectUrl)
    vi.stubEnv('AZORA_API_KEY', engine.readKey)
    vi.stubEnv('AZORA_TOKEN', '')
    const reader = keep(await connectEnv({ clientName: 'env-test/1' }))
    expect(reader.session?.scopes).toEqual(['read'])
    vi.stubEnv('AZORA_API_KEY', '')
    await expect(connectEnv()).rejects.toThrow(/AZORA_TOKEN is not set/)
  })

  test('a rotated server key is discovered again; a pinned one is refused', async () => {
    const { fetch, urls } = countingFetch()
    const errors: Error[] = []
    const db = keep(await connect(engine.connectUrl, {
      token: engine.apiKey, fetch, reconnectMinMs: 20, reconnectMaxMs: 200, onError: (e) => errors.push(e),
    }))
    const oldKey = engine.serverKey
    const pinned = keep(await connect(`${engine.connectUrl}?key=${oldKey}`, { token: engine.apiKey, reconnectMinMs: 20, reconnectMaxMs: 200, onError: () => {} }))
    expect(urls).toHaveLength(1)

    // Replace the server's key while it is down.
    await engine.stop()
    const keys = JSON.parse(engine.cli('keys', 'show', '--json')) as Array<{ id: string; public_key: string }>
    expect(keys.map((k) => k.public_key)).toEqual([oldKey])
    engine.cli('keys', 'rotate')
    engine.cli('keys', 'remove', (keys[0] as { id: string }).id)
    await engine.start()
    expect(engine.serverKey).not.toBe(oldKey)

    await until(() => db.session?.serverKey === engine.serverKey, 'a connection with the new key', 20_000)
    expect(urls).toHaveLength(2) // asked again once, after the old key was refused
    expect(errors.some((e) => e instanceof HandshakeError)).toBe(true)
    expect(await db.queryValue('SELECT 1')).toBe(1)
    expect(pinned.connected).toBe(false)
    await expect(connect(`${engine.connectUrl}?key=${oldKey}`, { token: engine.apiKey })).rejects.toBeInstanceOf(HandshakeError)
  })
})
