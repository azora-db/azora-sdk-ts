/** Connection options, connection strings and server keys. */
import { fingerprint, type ChannelSecurity } from './channel.ts'
import type { Session } from './session.ts'
import type { Transport, WebSocketCtor } from './transport.ts'

export const DEFAULT_PORT = 7480
export const DEFAULT_WEBSOCKET_PATH = '/rt/v1'
export const DEFAULT_RECONNECT_MIN_MS = 100
export const DEFAULT_RECONNECT_MAX_MS = 30_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_CLIENT_NAME = 'azora-js/0.1'

/** Returns a credential: an API key (`azk_…`) or a client token (`azt1.…`). */
export type CredentialProvider = () => string | Promise<string>

/** Options of {@link connect}. */
export interface ConnectOptions {
  /**
   * A connection string (see {@link parseUrl}). Its parts can also be given
   * one by one with the fields below, which win over the URL.
   */
  url?: string
  /** The server's raw TCP realtime address (Node, Bun, Deno). */
  host?: string
  port?: number
  /** `ws://` or `wss://` URL of the realtime endpoint (every runtime). */
  webSocketUrl?: string
  /** The database the connection is bound to. */
  database?: string

  /**
   * Pins the server's public key, as printed by `azora keys show` (base64):
   * one round trip, and the connection fails unless the server holds the
   * matching private key.
   */
  serverKey?: string | Uint8Array
  /**
   * The server key's fingerprint (`azp1-…`): the server sends its key and
   * the client checks it. With `serverKey` also set it is an extra check.
   */
  fingerprint?: string
  /**
   * Requests an unencrypted channel. Tests and loopback only: it applies
   * only without `serverKey` and `fingerprint`, and the server and the
   * database must allow it too.
   */
  allowPlaintext?: boolean

  /** An API key (`azk_…`). */
  apiKey?: string
  /**
   * A client token (`azt1.…`), or a function returning a fresh one. The
   * function runs on every (re)connect and whenever the server reports
   * that the credential expired.
   */
  token?: string | CredentialProvider
  /** Same as `apiKey`/`token`, for code that does not care which it is. */
  credential?: string | CredentialProvider

  /** Identifies the application in the server's logs (default `azora-js/<version>`). */
  clientName?: string
  /** Bounds of the reconnect backoff, exponential with full jitter (100 ms and 30 s). */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /**
   * Bounds every call that does not pass its own `timeoutMs`, including
   * the time spent waiting for a connection (30 s; 0 disables it). It also
   * bounds each connection attempt.
   */
  requestTimeoutMs?: number
  /**
   * How many connections to open (default 1). Requests are spread over
   * them: the server runs at most 8 requests of a connection at once.
   * Subscriptions use the first connection.
   */
  pool?: number

  /**
   * Base URL of the engine's HTTP server, for file storage
   * (`https://files.example.com`). Derived from `webSocketUrl` when unset.
   */
  storageUrl?: string
  /** The `fetch` used for file storage (default: the global one). */
  fetch?: typeof fetch
  /** A WebSocket constructor, for runtimes without a global one. */
  webSocket?: WebSocketCtor

  /** Runs after every successful connection. */
  onConnect?: (session: Session) => void
  /** Runs when a connection reported by `onConnect` ends. */
  onDisconnect?: (reason: Error) => void
  /** Runs when a subscription lost its resume point and takes a new snapshot. */
  onResync?: (subscriptionId: number, reason: string) => void
  /** Reports errors no caller receives: failed reconnects, session errors, failed token refreshes. */
  onError?: (err: Error) => void

  /** @internal Rekey thresholds, lowered by tests. */
  rekeyFrames?: number
  /** @internal */
  rekeyBytes?: number
  /** @internal Opens the transport instead of TCP or WebSocket (tests). */
  transport?: (signal: AbortSignal) => Promise<Transport>
}

/** Options resolved and validated by {@link resolveOptions}. */
export interface ResolvedOptions {
  host: string
  port: number
  webSocketUrl: string
  database: string
  security: ChannelSecurity
  credential: string
  credentialProvider: CredentialProvider | null
  clientName: string
  reconnectMinMs: number
  reconnectMaxMs: number
  requestTimeoutMs: number
  pool: number
  storageUrl: string
  fetch: typeof fetch | undefined
  webSocket: WebSocketCtor | undefined
  transport: ((signal: AbortSignal) => Promise<Transport>) | undefined
  hooks: Pick<ConnectOptions, 'onConnect' | 'onDisconnect' | 'onResync' | 'onError'>
}

function bad(msg: string): never {
  throw new TypeError(`azora: ${msg}`)
}

function fromBase64(s: string): Uint8Array | null {
  let t = s.trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null
  t += '='.repeat((4 - (t.length % 4)) % 4)
  try {
    const bin = atob(t)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Encodes a public key the way `azora keys show` prints it (base64url, no padding). */
export function encodeServerKey(key: Uint8Array): string {
  let bin = ''
  for (const b of key) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Parses a server public key: base64url or standard base64, with or without padding. */
export function decodeServerKey(key: string | Uint8Array): Uint8Array {
  const b = typeof key === 'string' ? fromBase64(key) : key
  if (!b || b.length !== 32) bad('server key: not a base64 32-byte key')
  return b
}

function normalizeFingerprint(fp: string): string {
  const s = fp.trim().toLowerCase()
  if (!/^azp1(-[a-z2-7]{4}){6}$/.test(s)) bad(`fingerprint "${fp}": want azp1- followed by six 4-character groups`)
  return s
}

/**
 * Parses a connection string:
 *
 * ```
 * azora://host[:port]/<database>?key=<server public key>     TCP (port 7480)
 * azora://host/<database>?fp=azp1-xxxx-…                     first contact
 * azoras+ws://host[:port][/path]?db=<database>&key=…         WebSocket over TLS
 * azora+ws://host[:port][/path]?db=<database>&key=…          plain WebSocket
 * wss://host[/path]?db=<database>&key=…                      same as azoras+ws
 * ws://host[/path]?db=<database>&key=…                       same as azora+ws
 * ```
 *
 * The WebSocket path defaults to `/rt/v1`. Query parameters: `key`, `fp`,
 * `db` (for `azora://` the path may name the database instead) and
 * `plaintext=1` (tests only). Credentials are never read from a URL.
 */
export function parseUrl(input: string): ConnectOptions {
  const text = input.trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  if (!m) bad('connection string: missing scheme (azora://, azora+ws://, azoras+ws://, ws:// or wss://)')
  const scheme = (m[1] as string).toLowerCase()
  if (!['azora', 'azora+ws', 'azoras+ws', 'ws', 'wss'].includes(scheme)) {
    bad(`connection string: unsupported scheme "${scheme}" (azora, azora+ws, azoras+ws, ws, wss)`)
  }
  const rest = text.slice(m[0].length)
  if (rest === '' || /^[/?#]/.test(rest)) bad('connection string: missing host')
  // The URL class only gives hosts and ports to schemes it knows.
  let u: URL
  try {
    u = new URL('http://' + rest)
  } catch {
    bad('connection string: malformed URL')
  }
  if (u.username || u.password) bad('connection string: user info is not supported (pass apiKey or token)')
  if (!u.hostname) bad('connection string: missing host')
  if (u.hash) bad('connection string: unexpected fragment')
  const out: ConnectOptions = {}
  const seen = new Set<string>()
  for (const [k, v] of u.searchParams) {
    if (seen.has(k)) bad(`connection string: parameter "${k}" given more than once`)
    seen.add(k)
    switch (k) {
      case 'key':
        out.serverKey = v
        break
      case 'fp':
        out.fingerprint = v
        break
      case 'db':
        out.database = v
        break
      case 'plaintext':
        if (v === '1' || v === 'true') out.allowPlaintext = true
        else if (v !== '0' && v !== 'false') bad(`connection string: plaintext="${v}" (want 1 or 0)`)
        break
      default:
        bad(`connection string: unknown parameter "${k}"`)
    }
  }
  if (scheme === 'azora') {
    const path = u.pathname.replace(/^\/+|\/+$/g, '')
    if (path) {
      const db = decodeURIComponent(path)
      if (out.database && out.database !== db) bad('connection string: database given in both the path and db=')
      if (db.includes('/')) bad(`connection string: path "${u.pathname}" is not a database name`)
      out.database = db
    }
    out.host = u.hostname.replace(/^\[|\]$/g, '')
    out.port = u.port ? Number(u.port) : DEFAULT_PORT
  } else {
    const secure = scheme === 'azoras+ws' || scheme === 'wss'
    const path = u.pathname === '' || u.pathname === '/' ? DEFAULT_WEBSOCKET_PATH : u.pathname
    out.webSocketUrl = `${secure ? 'wss' : 'ws'}://${u.host}${path}`
  }
  if (!out.database) bad('connection string: missing database')
  return out
}

/** Builds the handshake configuration from the key options. */
export function security(o: Pick<ConnectOptions, 'serverKey' | 'fingerprint' | 'allowPlaintext' | 'rekeyFrames' | 'rekeyBytes'>): ChannelSecurity {
  const sec: ChannelSecurity = {}
  if (o.rekeyFrames !== undefined) sec.rekeyFrames = o.rekeyFrames
  if (o.rekeyBytes !== undefined) sec.rekeyBytes = o.rekeyBytes
  if (o.fingerprint) {
    const want = normalizeFingerprint(o.fingerprint)
    sec.verifyServer = (pub) => {
      const got = fingerprint(pub)
      if (got !== want) throw new Error(`server key fingerprint ${got} does not match the configured ${want}`)
    }
  }
  if (o.serverKey) sec.serverKey = decodeServerKey(o.serverKey)
  if (!sec.serverKey && !sec.verifyServer) {
    if (!o.allowPlaintext) bad('set serverKey (pinned key) or fingerprint; allowPlaintext is for tests only')
    sec.allowPlaintext = true
  }
  return sec
}

/** Validates options and fills defaults; `url` is merged under the explicit fields. */
export function resolveOptions(input: ConnectOptions): ResolvedOptions {
  const o: ConnectOptions = { ...(input.url ? parseUrl(input.url) : {}) }
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && k !== 'url') (o as Record<string, unknown>)[k] = v
  }
  if (!o.database) bad('the database option is required')
  if (!o.host && !o.webSocketUrl && !o.transport) bad('a url, a host or a webSocketUrl is required')
  let webSocketUrl = ''
  if (o.webSocketUrl) {
    let u: URL
    try {
      u = new URL(o.webSocketUrl)
    } catch {
      bad(`webSocketUrl "${o.webSocketUrl}": want ws:// or wss://`)
    }
    if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.host) bad(`webSocketUrl "${o.webSocketUrl}": want ws:// or wss://`)
    webSocketUrl = o.webSocketUrl
  }
  const port = o.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad(`bad port ${port}`)

  const given = [o.apiKey, o.token, o.credential].filter((c) => c !== undefined && c !== '')
  if (given.length === 0) bad('a credential is required: apiKey, token or credential')
  if (given.length > 1) bad('give one of apiKey, token and credential')
  const cred = given[0] as string | CredentialProvider

  let storageUrl = (o.storageUrl ?? '').replace(/\/+$/, '')
  if (!storageUrl && webSocketUrl) {
    const u = new URL(webSocketUrl)
    storageUrl = `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`
  }
  const min = o.reconnectMinMs && o.reconnectMinMs > 0 ? o.reconnectMinMs : DEFAULT_RECONNECT_MIN_MS
  const max = Math.max(min, o.reconnectMaxMs && o.reconnectMaxMs > 0 ? o.reconnectMaxMs : DEFAULT_RECONNECT_MAX_MS)
  const pool = o.pool ?? 1
  if (!Number.isInteger(pool) || pool < 1 || pool > 64) bad(`pool must be between 1 and 64, got ${pool}`)
  return {
    host: webSocketUrl ? '' : (o.host ?? ''),
    port,
    webSocketUrl,
    database: o.database,
    security: security(o),
    credential: typeof cred === 'string' ? cred : '',
    credentialProvider: typeof cred === 'function' ? cred : null,
    clientName: o.clientName || DEFAULT_CLIENT_NAME,
    reconnectMinMs: min,
    reconnectMaxMs: max,
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    pool,
    storageUrl,
    fetch: o.fetch,
    webSocket: o.webSocket,
    transport: o.transport,
    hooks: {
      ...(o.onConnect ? { onConnect: o.onConnect } : {}),
      ...(o.onDisconnect ? { onDisconnect: o.onDisconnect } : {}),
      ...(o.onResync ? { onResync: o.onResync } : {}),
      ...(o.onError ? { onError: o.onError } : {}),
    },
  }
}
