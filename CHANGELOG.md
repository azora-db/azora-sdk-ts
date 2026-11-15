# Changelog

## Unreleased

### Values come back as stored

- With an engine that has the matching fix, `query` and `tx.query` return
  what SQLite stores, whatever type the column declares, as live rows
  already did. A `BOOLEAN` column now reads 1 or 0 (it read true or
  false through `query` and 1 or 0 through `live`), and a query that
  returned an integer or text from a `DATE`, `DATETIME` or `TIMESTAMP`
  column answers; before, it never did.
- `azora-gen` types `BOOLEAN` columns `number`, like `BOOL`.
- `resumeUpload` and `ResumeUploadOptions` are exported from the package
  root as well as `Storage.resumeUpload`.

### Interactive transactions

- `db.tx(async (tx) => { … })` runs a transaction over several requests:
  read, decide and write. It commits when the callback resolves, rolls
  back when it throws, and returns the callback's value. `tx.query`,
  `tx.queryOne`, `tx.queryValue`, `tx.queryRaw` and `tx.exec` see the
  transaction's own writes. A transaction holds the database's single
  writer, under the server's lease (5 s idle, 30 s in all by default).
- `TxExpiredError` (code `tx_expired`, `ErrorCode.TxExpired`): the lease
  ran out or the transaction's connection was lost; nothing was applied.
  A transaction is never replayed after a reconnect. A commit whose
  answer is lost rejects with `UnknownOutcomeError`.
- `db.tx(fn, { mutationId })` makes the commit apply exactly once, with
  the same ids as `exec` and `batch`.
- `db.session?.txIdleMs` is the server's idle lease; 0 means the server has
  no interactive transactions, and `db.tx` then rejects with
  `unavailable` without sending anything.
- The client name sent in Hello now ends with ` +tx`.

### Live queries: periodic verification

- `verifyEvery` (milliseconds) in the options of `db.live()` and
  `useLiveQuery`: the live query compares its rows' checksum with the
  server's on that interval and takes a new snapshot on a mismatch, like
  `VerifyEvery` in the Go SDK.
- `onVerify(result)` is called after every finished periodic check,
  matching or not; `LiveQuery.lastVerify` and `LiveQuery.mismatches`
  report the last result and the number of mismatches.

### Resuming an upload in another process

- `Storage.resumeUpload(sessionUrl, body, options)` continues a
  resumable upload in a later process or page load from its session URL
  alone, without a credential.
- `storage.uploadResumable` takes `onSession(sessionUrl)`, called once
  when the session opens, to learn the URL to store.
- Resuming reports progress from the offset the server holds. An
  expired, completed or aborted session fails with `not_found`; a body
  of another length than the upload started with fails with `invalid`
  before anything is sent.

### Row types from the schema

- `azora-gen` (a `bin` of the package) writes TypeScript row types
  (`Orders`, `NewOrders`, `Tables`) from a database's schema. `--check`
  exits 1 when the file is missing or out of date, for CI. A read-only
  API key is enough.
- `@azora-db/client/typegen` exports `readSchema` and `generateTypes`
  to do the same from code.

### Units: files and HTTP

- `UnitInfo.http` says whether a unit answers plain HTTP requests
  (`'auth'` or `'public'`). Units can now use `ctx.storage` and be
  called over HTTP; see `packages/units/CHANGELOG.md`.

### Signed upload URLs over the connection

- `db.signUploadUrl(grant)` asks the server for a signed upload URL over
  the realtime connection, so a browser whose client token has the `write`
  scope gets one itself (`db.storage.signUploadUrl` needs an API key).
  `sessionUrlOf(url)` gives the URL for resumable sessions under the same
  grant. Needs an engine that lists `sign-upload` in its features.

### Access control in the engine

Nothing changes in the SDK's API; these engine changes show through it.

- **Sign-in with an identity provider.** `token` may be a JSON Web Token
  of a provider the database accepts (`azora meta issuer add`), next to
  an API key or a client token. A token provider function works the same
  way: return the provider's fresh token when the server says the
  credential expired.
- **Access policies are enforced.** A statement, a subscription, a unit
  call or a storage request can fail with `permission_denied` although
  the credential has the scope, when a policy of the database refuses its
  table, unit or bucket. An open subscription a new policy no longer
  allows ends with `permission_denied`.
- **A client token limited to tables can read them with SQL** (it could
  only subscribe). It still cannot write with SQL, and a token with
  pinned filters still cannot run SQL.

### Units: access

- The engine now checks a unit's `access` before running it: a call needs
  the `read` scope for a query and the `write` scope for a mutation or an
  action, unless the unit declares another (`access: 'any'` lets every
  credential call it). A credential without the scope gets
  `permission_denied`. `UnitInfo.access` reports what each unit needs.

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
