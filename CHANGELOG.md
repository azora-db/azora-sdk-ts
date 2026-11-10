# Changelog

## Unreleased

First version of the TypeScript SDK.

- Connecting takes two values, a public URL and a private token:
  `connect('https://db.example.com/shop?key=<server key>', { token })`.
  The URL is the engine's HTTP address with the database as the last path
  segment; the WebSocket endpoint and the file-storage address are derived
  from it. `connectEnv()` reads them from `AZORA_URL` and `AZORA_TOKEN`
  (or `AZORA_API_KEY`).
- A URL without `?key=` reads the server key from
  `/.well-known/azora.json`, over `https` or to a loopback address only;
  over plain `http` to another host it is refused before any network
  call. The key is read again when a reconnect fails the handshake.
- The `token` option takes an API key or a client token, as a string or a
  function; `apiKey` is another name for it.
- Connections over TCP and WebSocket with the Noise IK and XX handshakes
  (pinned server key or fingerprint), heartbeats, and reconnects with
  backoff and jitter. The URL forms `azora://`, `wss://…?db=`, `ws://`,
  `azora+ws://` and `azoras+ws://` name the realtime endpoint directly.
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
- Examples and `pnpm dev:engine` use `AZORA_URL` and `AZORA_TOKEN`. In
  `examples/.env`, `AZORA_URL` is now the http URL and the raw TCP URL is
  `AZORA_TCP_URL`; `VITE_AZORA_URL` replaces `VITE_AZORA_WS_URL`;
  `AZORA_WS_URL`, `AZORA_STORAGE_URL` and `AZORA_API_KEY` are no longer
  written.
