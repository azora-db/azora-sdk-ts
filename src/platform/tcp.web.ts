/** Browsers cannot open TCP connections: `azora://` URLs need a server runtime. */
import { ConnectionError } from '../errors.ts'
import type { Transport } from '../transport.ts'

/** Whether this runtime can open TCP connections. */
export const tcpSupported = false

export function connectTCP(_host: string, _port: number, _signal: AbortSignal): Promise<Transport> {
  return Promise.reject(
    new ConnectionError('azora: raw TCP (azora://) is not available in this runtime; use the https:// URL (https://host/<database>?key=...)'),
  )
}
