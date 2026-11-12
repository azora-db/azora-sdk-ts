# Changelog

## Unreleased

### Units: jobs, run statuses, local tests

- `db.unitsAdmin.jobs.list({ state, unit, limit })`, `jobs.cancel(id)`
  and `jobs.retry(id)`: the jobs units schedule with `ctx.scheduler`
  (`UnitJob`, `UnitJobList`). A failed job's `runAt` is when it failed.
  Listing is a read (sent again after a lost connection); cancel and
  retry are not.
- `UnitRun.status` adds `rejected` (refused before the unit ran) and
  `runs({ status: 'rejected' })` filters on it; `UnitRun.trigger` adds
  `job`, `cli` and `mcp` (`UnitRunStatus`, `UnitRunTrigger`).
- `@azora-db/units`: `ctx.scheduler` and `ctx.unit.job`, the
  `azora-units jobs` command, `rejected` runs in `logs`, and
  `@azora-db/units/testing` to run units locally without an engine (see
  `packages/units/CHANGELOG.md`).
- `examples/units` has a reminder job (`remindCart`, `cartReminder`),
  shown by `shop.ts`, and `shop.test.ts`, which tests the shop's units
  locally (`pnpm test` there).
- `pnpm dev:engine` no longer publishes the example units a second time
  when `azora-units publish` runs afterwards: the bundle is the same
  whether the bundler runs from source or from `dist`.

### Units

- Units: TypeScript functions published into a database and called by
  name. `db.call(name, args, { mutationId })` returns a unit's result;
  `connect<typeof import('./units')>()` and `connectEnv<M>()` type
  `db.units.<name>(args)` from the units' source (non-internal queries,
  mutations and actions). `Database` without a type argument is
  unchanged.
- Every call carries a fresh mutation id, sent again unchanged after a
  lost connection. Blobs travel as `{"$bytes": base64}` and come back as
  `Uint8Array`.
- `UnitError` (`code`, `message`, `data`, `unit`) when a unit throws;
  failures around the unit stay `AzoraError`.
- `db.unitsAdmin`: `deploy`, `list`, `deploys`, `activate`, `call`,
  `runs`, `triggers`, `skipTrigger`, `secrets.list/set/unset`. Changes
  are not resent after a lost connection; reads are.
- A connection that read `/.well-known/azora.json` refuses unit calls
  with `unavailable: this server does not support units` when the
  document does not list `"units"` in `features`.
- React: `useUnit(name)` and `useUnitQuery(name, args, deps, { watch })`;
  `useAzora<M>()` returns a typed database.
- Protocol: the Call (24), Returned (25), UnitAdmin (26) and
  UnitAdminResult (27) messages.
- New package `@azora-db/units` (`packages/units`; the repository is now
  a pnpm workspace): `query`, `mutation`, `action`, `schedule`,
  `onChange`, the `v` validators (JSON Schema for the engine, TypeScript
  types for handlers and clients), `UnitError` and the `ctx` types; the
  `azora-units` CLI (`publish`, `dev`, `list`, `history`, `rollback`,
  `call`, `logs`, `secrets`, `types --go`), which bundles units with
  esbuild; and `@azora-db/units/tools` for scripts.
- `examples/units`: a shop whose customer token cannot run SQL but checks
  out its own cart through a unit. `pnpm dev:engine` creates its tables
  and publishes it when the engine supports units.
- `pnpm build`, `pnpm typecheck` and `pnpm test` cover both packages;
  `pnpm test:units` runs the units package's tests alone.

### First version

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
