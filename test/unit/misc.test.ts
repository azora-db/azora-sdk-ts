import { describe, expect, test } from 'vitest'
import { Channel, openChannel } from '../../src/channel.ts'
import { parseUrl, resolveOptions } from '../../src/config.ts'
import {
  and, compareValues, decodeServerKey, encodeServerKey, eq, FilterError, gt, inList, isNull, keyString, not, notNull, or, parseFilter, sql,
  startsWith,
} from '../../src/index.ts'
import { generateKeyPair, HandshakeState, type Pattern } from '../../src/noise.ts'
import * as nodeAead from '../../src/platform/aead.node.ts'
import * as webAead from '../../src/platform/aead.web.ts'
import type { Transport } from '../../src/transport.ts'
import { isDDL } from '../../src/util.ts'

describe('connection strings', () => {
  const key = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk'

  test('every documented form', () => {
    expect(parseUrl(`azora://db.example.com/shop?key=${key}`)).toEqual({ host: 'db.example.com', port: 7480, database: 'shop', serverKey: key })
    expect(parseUrl('azora://10.0.0.1:9000/shop?fp=azp1-aaaa-bbbb-cccc-dddd-eeee-ffff')).toMatchObject({ host: '10.0.0.1', port: 9000, fingerprint: 'azp1-aaaa-bbbb-cccc-dddd-eeee-ffff' })
    expect(parseUrl('azora://[::1]:7480/?db=shop&plaintext=1')).toEqual({ host: '::1', port: 7480, database: 'shop', allowPlaintext: true })
    expect(parseUrl(`azoras+ws://db.example.com?db=shop&key=${key}`)).toMatchObject({ webSocketUrl: 'wss://db.example.com/rt/v1', database: 'shop' })
    expect(parseUrl(`azora+ws://localhost:8080/custom/path?db=shop&key=${key}`).webSocketUrl).toBe('ws://localhost:8080/custom/path')
    expect(parseUrl(`wss://db.example.com/rt/v1?db=shop&key=${key}`).webSocketUrl).toBe('wss://db.example.com/rt/v1')
    expect(parseUrl(`  ws://localhost:8080?db=shop&key=${key}  `).webSocketUrl).toBe('ws://localhost:8080/rt/v1')
  })

  test('http(s) URLs: the database is the last path segment, the rest is derived', () => {
    expect(parseUrl(`https://db.example.com/shop?key=${key}`)).toEqual({
      database: 'shop', serverKey: key, webSocketUrl: 'wss://db.example.com/rt/v1', storageUrl: 'https://db.example.com',
    })
    expect(parseUrl('http://127.0.0.1:8090/shop')).toEqual({ database: 'shop', webSocketUrl: 'ws://127.0.0.1:8090/rt/v1', storageUrl: 'http://127.0.0.1:8090' })
    // A prefix before the database belongs to the server's address.
    expect(parseUrl(`https://example.com:8443/azora/eu/shop?key=${key}`)).toMatchObject({
      database: 'shop', webSocketUrl: 'wss://example.com:8443/azora/eu/rt/v1', storageUrl: 'https://example.com:8443/azora/eu',
    })
    expect(parseUrl('HTTPS://DB.Example.com/shop/?fp=azp1-aaaa-bbbb-cccc-dddd-eeee-ffff')).toEqual({
      database: 'shop', fingerprint: 'azp1-aaaa-bbbb-cccc-dddd-eeee-ffff', webSocketUrl: 'wss://db.example.com/rt/v1', storageUrl: 'https://db.example.com',
    })
    expect(parseUrl('http://[::1]:8090/my%20shop?plaintext=1')).toEqual({
      database: 'my shop', allowPlaintext: true, webSocketUrl: 'ws://[::1]:8090/rt/v1', storageUrl: 'http://[::1]:8090',
    })
    expect(resolveOptions({ url: `https://db.example.com/pre/shop?key=${key}`, token: 't' })).toMatchObject({
      database: 'shop', webSocketUrl: 'wss://db.example.com/pre/rt/v1', storageUrl: 'https://db.example.com/pre', host: '', discovery: null, credential: 't',
    })
    // Options still win over the URL.
    expect(resolveOptions({ url: `https://db.example.com/shop?key=${key}`, token: 't', storageUrl: 'https://files.example.com/' }).storageUrl).toBe('https://files.example.com')
    expect(resolveOptions({ url: `https://db.example.com/shop?key=${key}`, token: 't', database: 'other' }).database).toBe('other')
  })

  test('mistakes are named', () => {
    const cases: Array<[string, RegExp]> = [
      ['db.example.com/shop', /missing scheme/],
      ['ftp://db.example.com/shop', /unsupported scheme/],
      ['https://db.example.com', /must end with the database name/],
      ['https://db.example.com/', /must end with the database name/],
      ['http://localhost:8090?key=abc', /must end with the database name/],
      ['https://db.example.com/rt/v1?db=shop', /unknown parameter "db".*last path segment/],
      ['https://user:secret@db.example.com/shop', /user info/],
      ['https://db.example.com/shop#frag', /fragment/],
      ['https://db.example.com/shop?token=azk_x', /unknown parameter "token"/],
      ['https://db.example.com/%zz', /malformed database name/],
      ['https:///shop', /missing host/],
      ['azora://user:secret@host/shop', /user info/],
      ['azora://host/shop#frag', /fragment/],
      ['azora://host/shop?key=a&key=b', /more than once/],
      ['azora://host/shop?apikey=x', /unknown parameter "apikey"/],
      ['azora://host/shop?plaintext=yes', /plaintext/],
      ['azora://host/a/b', /not a database name/],
      ['azora://host/shop?db=other', /both the path and db=/],
      ['azora://host', /missing database/],
      ['wss://host/rt/v1', /missing database/],
      ['azora:///shop', /missing host/],
      ['azora://', /missing host/],
    ]
    for (const [url, want] of cases) expect(() => parseUrl(url), url).toThrow(want)
  })

  test('options resolve with defaults and derive the storage URL', () => {
    const o = resolveOptions({ url: `wss://db.example.com/rt/v1?db=shop&key=${key}`, apiKey: 'k' })
    expect(o).toMatchObject({
      database: 'shop', webSocketUrl: 'wss://db.example.com/rt/v1', storageUrl: 'https://db.example.com', credential: 'k', pool: 1,
      reconnectMinMs: 100, reconnectMaxMs: 30_000, requestTimeoutMs: 30_000, clientName: 'azora-js/0.1',
    })
    expect(resolveOptions({ url: `azora://h/shop?key=${key}`, apiKey: 'k', storageUrl: 'http://files:8080/' }).storageUrl).toBe('http://files:8080')
    expect(resolveOptions({ url: `azora://h/shop?key=${key}`, database: 'other', apiKey: 'k' }).database).toBe('other') // fields win over the URL
    const provider = (): string => 't'
    expect(resolveOptions({ url: `azora://h/shop?key=${key}`, token: provider }).credentialProvider).toBe(provider)
    expect(() => resolveOptions({ url: 'azora://h/shop?fp=azp1-nope', apiKey: 'k' })).toThrow(/fingerprint/)
    expect(() => resolveOptions({ url: 'azora://h/shop?key=short', apiKey: 'k' })).toThrow(/32-byte key/)
    expect(() => resolveOptions({ host: 'h', port: 70000, database: 'd', apiKey: 'k', allowPlaintext: true })).toThrow(/port/)
  })

  test('server keys in every base64 spelling', () => {
    const raw = decodeServerKey(key)
    expect(raw).toHaveLength(32)
    expect(encodeServerKey(raw)).toBe(key)
    const std = Buffer.from(raw).toString('base64')
    expect(decodeServerKey(std)).toEqual(raw)
    expect(decodeServerKey(std.replace(/=+$/, ''))).toEqual(raw)
    expect(decodeServerKey(std.replace(/\+/g, ' '))).toEqual(raw) // a "+" that went through a URL query
    expect(() => decodeServerKey('!!!')).toThrow()
  })
})

describe('filters', () => {
  test('text parses to the same tree as the builders', () => {
    expect(parseFilter("status = 'paid' AND total > 100")).toEqual(and(eq('status', 'paid'), gt('total', 100)))
    expect(parseFilter('a = 1 OR b = 2 AND c = 3')).toEqual(or(eq('a', 1), and(eq('b', 2), eq('c', 3))))
    expect(parseFilter('NOT (a IS NULL) and b is not null')).toEqual(and(not(isNull('a')), notNull('b')))
    expect(parseFilter("name ^= 'Jo' AND id IN (1, 2.5, 'x', x'00ff', TRUE)")).toEqual(
      and(startsWith('name', 'Jo'), inList('id', [1, 2.5, 'x', Uint8Array.of(0, 255), 1])),
    )
    expect(parseFilter('"my col" <> -3 and x == +4 and y NOT IN (false)')).toEqual(
      and({ op: '!=', col: 'my col', val: -3 }, eq('x', 4), { op: 'not_in', col: 'y', vals: [0] }),
    )
    expect(parseFilter("s = 'it''s'")).toEqual(eq('s', "it's"))
    expect(parseFilter('n = 9223372036854775807')).toEqual(eq('n', 9223372036854775807n))
    expect(parseFilter('n >= 1e3')).toEqual({ op: '>=', col: 'n', val: 1000 })
    expect(parseFilter('   ')).toBeNull()
  })

  test('mistakes point at their position', () => {
    const cases: Array<[string, RegExp]> = [
      ["a = 'open", /at 4: unterminated string/],
      ['a = ', /expected a value/],
      ['= 1', /expected a column name/],
      ['a ~ 1', /unexpected "~"/],
      ['a =! 1', /unknown operator|expected a value/],
      ['a IS 1', /expected NULL/],
      ['a IN 1', /expected \(/],
      ['(a = 1', /expected \)/],
      ['a = 1 b = 2', /unexpected "b"/],
      ["a = x'0g'", /bad blob/],
      ['a = 1.2.3', /bad number/],
      ['a', /expected an operator after "a"/],
    ]
    for (const [text, want] of cases) expect(() => parseFilter(text), text).toThrow(want)
    expect(() => parseFilter('('.repeat(40) + 'a = 1' + ')'.repeat(40))).toThrow(FilterError)
  })
})

describe('sql tag and helpers', () => {
  test('values become arguments, never text', () => {
    const name = "Robert'); DROP TABLE students;--"
    const s = sql`SELECT * FROM students WHERE name = ${name} AND year > ${2020}`
    expect(s.sql).toBe('SELECT * FROM students WHERE name = ? AND year > ?')
    expect(s.args).toEqual([name, 2020])
  })

  test('nesting, lists, identifiers', () => {
    const where = sql`status = ${'open'}`
    const s = sql`SELECT ${sql.id('my "col"')} FROM ${sql.id('orders')} WHERE ${where} AND id IN (${sql.join([1, 2, 3])}) ${sql.raw('ORDER BY 1')}`
    expect(s.sql).toBe('SELECT "my ""col""" FROM "orders" WHERE status = ? AND id IN (?, ?, ?) ORDER BY 1')
    expect(s.args).toEqual(['open', 1, 2, 3])
    expect(sql.join([sql`a = ${1}`, sql`b = ${2}`], ' AND ')).toMatchObject({ sql: 'a = ? AND b = ?', args: [1, 2] })
  })

  test('schema changes are recognised the way the server does', () => {
    for (const q of ['CREATE TABLE t(x)', '  create index i on t(x)', '/* c */ ALTER TABLE t ADD y', '-- c\nDROP TABLE t', ';;drop table t']) expect(isDDL(q), q).toBe(true)
    for (const q of ['INSERT INTO t VALUES (1)', 'SELECT 1', '', '/* unterminated CREATE', 'creates', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x']) expect(isDDL(q), q).toBe(false)
  })

  test('keys and value order', () => {
    expect(keyString([5])).toBe(keyString([5n]))
    expect(keyString([1, 'a'])).not.toBe(keyString(['1', 'a']))
    expect(keyString(['a|b', 'c'])).not.toBe(keyString(['a', 'b|c']))
    expect(keyString([Uint8Array.of(1, 2)])).toBe(keyString([Uint8Array.of(1, 2)]))
    const sorted = ['b', 2, null, Uint8Array.of(1), 1.5, 'a', 10n, Uint8Array.of(0, 9)].sort(compareValues)
    expect(sorted).toEqual([null, 1.5, 2, 10n, 'a', 'b', Uint8Array.of(0, 9), Uint8Array.of(1)])
  })
})

describe('secure channel', () => {
  test('both AEAD implementations agree', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i)
    const nonce = Uint8Array.from({ length: 12 }, (_, i) => 255 - i)
    for (const [ad, pt] of [[new Uint8Array(0), new Uint8Array(0)], [Uint8Array.of(1, 2, 3), new TextEncoder().encode('attack at dawn')], [new Uint8Array(32), new Uint8Array(70_000).fill(7)]] as const) {
      const a = nodeAead.seal(key, nonce, ad, pt)
      expect(webAead.seal(key, nonce, ad, pt)).toEqual(a)
      expect(nodeAead.open(key, nonce, ad, a)).toEqual(pt)
      expect(webAead.open(key, nonce, ad, a)).toEqual(pt)
      const bad = a.slice()
      bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1
      expect(() => nodeAead.open(key, nonce, ad, bad)).toThrow()
      expect(() => webAead.open(key, nonce, ad, bad)).toThrow()
    }
  })

  /** A pair of in-memory transports wired to each other. */
  function pipe(): [Transport, Transport] {
    const make = (): Transport => ({ send: () => {}, close: () => {}, onFrame: () => {}, onClose: () => {}, bufferedAmount: 0 })
    const a = make()
    const b = make()
    a.send = (f) => {
      const copy = f.slice()
      queueMicrotask(() => b.onFrame(copy))
    }
    b.send = (f) => {
      const copy = f.slice()
      queueMicrotask(() => a.onFrame(copy))
    }
    a.close = () => queueMicrotask(() => b.onClose())
    b.close = () => queueMicrotask(() => a.onClose())
    return [a, b]
  }

  /** Plays the server's side of the handshake over t and returns its channel. */
  async function serve(t: Transport, server: ReturnType<typeof generateKeyPair>, rekeyFrames: number): Promise<Channel> {
    const frames: Uint8Array[] = []
    let wake: (() => void) | null = null
    t.onFrame = (f) => {
      frames.push(f)
      wake?.()
    }
    const read = async (): Promise<Uint8Array> => {
      while (frames.length === 0) await new Promise<void>((r) => (wake = r))
      return frames.shift() as Uint8Array
    }
    const first = await read()
    const kidLen = first[6] as number
    const preamble = first.subarray(0, 7 + kidLen)
    const pattern: Pattern = first[5] === 0x4b ? 'IK' : 'XX'
    const prologue = new Uint8Array([...preamble, ...new TextEncoder().encode('azora-rt/1')])
    const hs = new HandshakeState({ pattern, initiator: false, prologue, s: server })
    hs.readMessage(first.subarray(preamble.length))
    t.send(Uint8Array.of(0, ...hs.writeMessage()))
    if (pattern === 'XX') hs.readMessage(await read())
    const keys = hs.split()
    const ch = new Channel(t, pattern, { rekeyFrames })
    ch.start(keys.send, keys.recv, frames.splice(0), null)
    return ch
  }

  for (const pattern of ['IK', 'XX'] as const) {
    test(`${pattern}: messages of every size survive chunking and rekeying`, async () => {
      const server = generateKeyPair()
      const [c, s] = pipe()
      const serverSide = serve(s, server, 7)
      let verified: Uint8Array | null = null
      const client = await openChannel(c, pattern === 'IK' ? { serverKey: server.publicKey, rekeyFrames: 7 } : { verifyServer: (k) => void (verified = k), rekeyFrames: 7 })
      const sch = await serverSide
      expect(client.mode).toBe(pattern)
      expect(client.serverKey).toEqual(server.publicKey)
      if (pattern === 'XX') expect(verified).toEqual(server.publicKey)
      const got: Uint8Array[] = []
      const echoed: Uint8Array[] = []
      sch.onMessage = (m) => {
        got.push(m.slice())
        sch.send(m)
      }
      client.onMessage = (m) => echoed.push(m.slice())
      const sizes = [0, 1, 100, 65517, 65518, 65519, 131036, 200_000, 3, 0, 70_000]
      const msgs = sizes.map((n, i) => new Uint8Array(n).map((_, j) => (i * 31 + j) & 0xff))
      for (let round = 0; round < 3; round++) for (const m of msgs) client.send(m)
      await new Promise((r) => setTimeout(r, 50))
      expect(got).toHaveLength(33)
      expect(echoed).toHaveLength(33)
      for (let i = 0; i < 33; i++) {
        expect(got[i], `message ${i}`).toEqual(msgs[i % msgs.length])
        expect(echoed[i], `echo ${i}`).toEqual(msgs[i % msgs.length])
      }
    })
  }

  test('a wrong pinned key, a tampered frame and an oversized message', async () => {
    const server = generateKeyPair()
    const [c, s] = pipe()
    void serve(s, server, 1 << 20).catch(() => s.close()) // a real server hangs up on a failed handshake
    await expect(openChannel(c, { serverKey: generateKeyPair().publicKey, keyId: 'abcd' })).rejects.toThrow(/closed/)

    const [c2, s2] = pipe()
    const serverSide = serve(s2, server, 1 << 20)
    const client = await openChannel(c2, { serverKey: server.publicKey, maxMessage: 1000 })
    const sch = await serverSide
    expect(() => client.send(new Uint8Array(1001))).toThrow(/exceeds the limit/)
    let closedWith: Error | undefined
    client.onClose = (e) => (closedWith = e)
    const realSend = s2.send
    s2.send = (f) => {
      const copy = f.slice()
      copy[0] = (copy[0] as number) ^ 0x80
      realSend(copy)
    }
    sch.send(Uint8Array.of(1, 2, 3))
    await new Promise((r) => setTimeout(r, 20))
    expect(closedWith?.message).toMatch(/failed authentication/)
    expect(() => client.send(Uint8Array.of(1))).toThrow(/closed/)
  })
})
