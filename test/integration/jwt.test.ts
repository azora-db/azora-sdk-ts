/**
 * Signing in with a token of an external identity provider: the SDK
 * passes it as any credential; the engine verifies it against the
 * provider's keys and maps its claims.
 */
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { AzoraError, connect, type Database } from '../../src/index.ts'
import { engineBinary, startEngine, type Engine } from '../helpers/engine.ts'

const b64 = (v: Buffer | string): string => Buffer.from(v).toString('base64url')

describe.skipIf(!engineBinary())('a token of an identity provider', () => {
  let engine: Engine
  let jwks: Server
  let open: Database[] = []
  const keep = (db: Database): Database => (open.push(db), db)
  const provider = generateKeyPairSync('ec', { namedCurve: 'P-256' })

  /** A token of the provider (or signed by another key), an hour long unless the claims say otherwise. */
  const token = (claims: Record<string, unknown> = {}, key: KeyObject = provider.privateKey): string => {
    const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))
    const body = b64(
      JSON.stringify({
        iss: 'https://id.test/',
        aud: 'shop-api',
        sub: '42',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
      }),
    )
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
    return `${head}.${body}.${b64(sig)}`
  }

  beforeAll(async () => {
    jwks = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ keys: [{ ...provider.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' }] }))
    })
    await new Promise<void>((ok) => jwks.listen(0, '127.0.0.1', ok))
    const url = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`
    // The provider is on loopback here; a real one is public and https.
    engine = await startEngine({ server: { jwks_allow_private: true } })
    await engine.stop()
    engine.cli(
      'meta',
      'issuer',
      'add',
      'shop',
      '--issuer',
      'https://id.test/',
      '--jwks-url',
      url,
      '--audience',
      'shop-api',
      '--scope',
      'read,write',
      '--scopes-claim',
      'scope',
      '--table',
      'orders',
      '--filter',
      'orders: customer = {sub:int}',
    )
    await engine.start()
  })
  afterEach(async () => {
    await Promise.all(open.map((d) => d.close()))
    open = []
  })
  afterAll(async () => {
    await engine?.stop()
    await new Promise<void>((ok) => jwks?.close(() => ok()))
  })

  test('signs in as the user and sees only its rows', async () => {
    const admin = keep(await connect(`${engine.connectUrl}?key=${engine.serverKey}`, { token: engine.apiKey }))
    await admin.exec(
      "INSERT INTO orders(id, customer, status, total) VALUES (1, 42, 'open', 5), (2, 7, 'open', 6), (3, 42, 'paid', 7)",
    )

    const user = keep(
      await connect(`${engine.connectUrl}?key=${engine.serverKey}`, { token: token({ scope: 'read openid' }) }),
    )
    expect(user.session).toMatchObject({ principal: 'user:42', scopes: ['read'] })
    const mine = await user.live<{ id: number }>('orders')
    await mine.ready
    expect(mine.rows.map((r) => r.id).sort()).toEqual([1, 3])
    mine.close()
    // Pinned to rows: no SQL, as for a client token with a filter.
    await expect(user.query('SELECT * FROM orders')).rejects.toMatchObject({ code: 'permission_denied' })
  })

  test('refuses what the provider did not sign for this database', async () => {
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    const bad: Record<string, string> = {
      forged: token({ scope: 'read' }, stranger),
      'another audience': token({ scope: 'read', aud: 'billing-api' }),
      expired: token({ scope: 'read', exp: Math.floor(Date.now() / 1000) - 3600 }),
      'no scope of this database': token({ scope: 'openid email' }),
      'a subject that is not an integer': token({ scope: 'read', sub: 'auth0|abc' }),
    }
    for (const [name, t] of Object.entries(bad)) {
      const err = await connect(`${engine.connectUrl}?key=${engine.serverKey}`, { token: t }).then(
        (db) => (keep(db), null),
        (e: unknown) => e,
      )
      expect(err, name).toBeInstanceOf(AzoraError)
      expect((err as AzoraError).code, name).toBe('unauthenticated')
    }
  })
})
