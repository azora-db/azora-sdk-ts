# Changelog

## Unreleased

First version of the TypeScript SDK.

- Connections over TCP and WebSocket with the Noise IK and XX handshakes
  (pinned server key or fingerprint), heartbeats, and reconnects with
  backoff and jitter.
- `query`, `queryOne`, `queryValue`, `queryRaw`, the `sql` tag; `exec` and
  `batch` with exactly-once delivery through mutation ids.
- `subscribe` (database, table, row, files and notify subscriptions) with
  resume, flow control and checksum verification; `live` queries; `watch`.
- Filters as builders and as text.
- File storage: uploads, resumable uploads, ranged downloads, listing,
  signed download and upload URLs.
- API keys and client tokens, with refresh on the open connection.
- Optional connection pool.
- React bindings: `AzoraProvider`, `useLiveQuery`, `useQuery`,
  `useConnected`.
