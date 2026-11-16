/** ctx.fetch of a run. */
import { STATUS_CODES } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Call } from './call.ts'
import { bytesOf, engineStringify, parseJSON } from './json.ts'
import type { Frame } from './runtime.ts'
import { q } from './units.ts'

/** ctx.fetch: only in actions, outside a transaction, within units.fetch limits. */
export function ctxFetch(c: Call, f: Frame, input: unknown, init: unknown): Promise<unknown> {
  if (f.kind !== 'action') c.throw(`ctx.fetch is only available in actions (${f.unit.name} is a ${f.kind})`)
  if (f.tx || c.writeOpen > 0) c.throw('ctx.fetch cannot run inside a transaction')
  const lim = c.t.limits
  if (++c.fetches > lim.fetchCalls) c.limit(`more than units.fetch.max_calls (${lim.fetchCalls}) requests`)
  let url = String(input)
  if (typeof input === 'object' && input !== null && (input as { url?: unknown }).url !== undefined)
    url = String((input as { url: unknown }).url)
  let method = 'GET'
  const headers: Record<string, string> = {}
  let body: string | Uint8Array | undefined
  if (typeof init === 'object' && init !== null) {
    const o = init as { method?: unknown; headers?: unknown; body?: unknown }
    if (o.method !== undefined) method = String(o.method).toUpperCase()
    if (typeof o.headers === 'object' && o.headers !== null) {
      for (const [k, v] of Object.entries(o.headers)) headers[k] = String(v)
    }
    if (o.body !== undefined && o.body !== null) {
      const b = bytesOf(o.body)
      if (typeof o.body === 'string') body = o.body
      else if (b) body = b
      else {
        body = engineStringify(o.body)
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
          headers['Content-Type'] = 'application/json'
      }
    }
  }
  if (!url.startsWith('http://') && !url.startsWith('https://'))
    c.throw(`ctx.fetch: only http and https URLs (got ${q(url)})`)
  const impl = c.t.o.fetch
  if (!impl) {
    c.throw(
      `ctx.fetch ${method} ${url}: this test environment has no fetch: pass one to createTestEnv(units, { fetch }) (a mock that returns a Response, or globalThis.fetch for real requests)`,
    )
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'azora-units'
  const start = performance.now()
  return (async () => {
    let resp: Response
    let data: Uint8Array
    try {
      resp = await impl(url, { method, headers, ...(body !== undefined && { body }), redirect: 'follow' })
      data = new Uint8Array(await resp.arrayBuffer())
    } catch (e) {
      return c.throw(`ctx.fetch ${method} ${url}: ${(e as Error).message}`)
    }
    if (data.length > lim.fetchBytes)
      c.throw(`ctx.fetch ${method} ${url}: the response is over units.fetch.max_bytes (${lim.fetchBytes})`)
    c.log('info', [`fetch ${method} ${url} -> ${resp.status} (${Math.round(performance.now() - start)}ms)`])
    const names = new Map<string, string>()
    resp.headers.forEach((v, k) => names.set(k.toLowerCase(), v))
    const sorted = [...names.keys()].sort()
    return {
      status: resp.status,
      statusText: STATUS_CODES[resp.status] ?? '',
      ok: resp.status >= 200 && resp.status < 300,
      url: resp.url || url,
      redirected: resp.redirected,
      headers: {
        get: (n: string) => names.get(String(n).toLowerCase()) ?? null,
        has: (n: string) => names.has(String(n).toLowerCase()),
        entries: () => sorted.map((k) => [k, names.get(k)!]),
      },
      text: async () => new TextDecoder().decode(data),
      json: async () => {
        try {
          return parseJSON(new TextDecoder().decode(data))
        } catch (e) {
          throw new Error(`response is not JSON: ${(e as Error).message}`)
        }
      },
      arrayBuffer: async () => data.slice().buffer,
      bytes: async () => data.slice(),
    }
  })()
}
