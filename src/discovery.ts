/**
 * Discovery: a connection URL without a server key
 * (`https://db.example.com/shop`) asks the server for it at
 * `<base>/.well-known/azora.json`. config.ts allows that only over https
 * or on loopback, where the answer can be trusted.
 */
import type { ChannelSecurity } from './channel.ts'
import { decodeServerKey, isLoopbackHost, type ResolvedOptions } from './config.ts'
import { ConnectionError } from './errors.ts'

/** Where a server publishes its key, relative to its base URL. */
export const DISCOVERY_PATH = '/.well-known/azora.json'

/** Where a connection goes and how its server is authenticated. */
export interface Endpoint {
  webSocketUrl: string
  security: ChannelSecurity
}

/**
 * @internal The discovered endpoint of one database, shared by its
 * connections: asked once, and again after `invalidate`.
 */
export class Discovery {
  /** How many times the server was asked. */
  fetches = 0
  /**
   * The optional features the server's last answer listed (`"units"`, ...);
   * null until it answered.
   */
  features: readonly string[] | null = null

  private readonly url: string
  private readonly o: ResolvedOptions
  private pending: Promise<Endpoint> | null = null
  private last: Endpoint | null = null

  constructor(o: ResolvedOptions) {
    if (!o.discovery) throw new TypeError('azora: discovery is not configured')
    this.o = o
    this.url = o.discovery.base + DISCOVERY_PATH
  }

  /** The endpoint: the one already known, or the server's answer. */
  get(signal: AbortSignal): Promise<Endpoint> {
    if (!this.pending) {
      const p = this.load(signal)
      this.pending = p
      p.then(
        (ep) => {
          if (this.pending === p) this.last = ep
        },
        () => {
          if (this.pending === p) this.pending = null // the next attempt asks again
        },
      )
    }
    return this.pending
  }

  /**
   * Forgets ep after a handshake with it failed (the server's key may have
   * been rotated): the next `get` asks the server again.
   */
  invalidate(ep: Endpoint): void {
    if (this.last !== ep) return // another connection already did
    this.last = null
    this.pending = null
  }

  private fail(why: string): never {
    throw new ConnectionError(`azora: discovery: ${this.url}: ${why}`)
  }

  private async load(signal: AbortSignal): Promise<Endpoint> {
    const f = this.o.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (typeof f !== 'function') this.fail('this runtime has no fetch: pass one with the fetch option, or add ?key=<server key> to the URL')
    this.fetches++
    let doc: unknown
    try {
      const res = await f(this.url, { signal })
      if (res.redirected && res.url) {
        const to = new URL(res.url)
        if (to.protocol !== 'https:' && !isLoopbackHost(to.hostname)) this.fail(`redirected to ${to.origin}, which is not https`)
      }
      if (!res.ok) {
        this.fail(
          res.status === 404
            ? 'HTTP 404: this server does not publish its key; add ?key=<server key> to the URL'
            : `HTTP ${res.status}`,
        )
      }
      try {
        doc = await res.json()
      } catch (e) {
        if (signal.aborted) throw e
        this.fail('the answer is not JSON')
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason
      if (e instanceof ConnectionError) throw e
      const cause = (e as { cause?: { message?: string } }).cause?.message
      this.fail(`${(e as Error).message}${cause ? ` (${cause})` : ''}`)
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) this.fail('the answer is not a discovery document')
    const d = doc as { azora?: unknown; server_key?: unknown; websocket?: unknown; features?: unknown }
    if (d.azora !== 1) this.fail(`unsupported document version ${JSON.stringify(d.azora) ?? 'none'} (want "azora": 1)`)
    let key: Uint8Array
    try {
      if (typeof d.server_key !== 'string') throw new TypeError('missing')
      key = decodeServerKey(d.server_key)
    } catch {
      this.fail('"server_key" is not a base64 32-byte key')
    }
    const path = d.websocket
    if (typeof path !== 'string' || !/^\/(?!\/)/.test(path)) this.fail(`"websocket" is not a path: ${JSON.stringify(path) ?? 'missing'}`)
    const { base, fixedEndpoint } = this.o.discovery as { base: string; fixedEndpoint: boolean }
    // Servers older than the field list nothing.
    this.features = Array.isArray(d.features) ? d.features.filter((f): f is string => typeof f === 'string') : []
    return {
      webSocketUrl: fixedEndpoint ? this.o.webSocketUrl : base.replace(/^http/, 'ws') + path,
      security: { ...this.o.security, serverKey: key },
    }
  }
}
