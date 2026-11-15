# Changelog

## Unreleased

### Files, HTTP

- `ctx.storage` (`StorageReader` in queries, `Storage` in mutations and
  actions): `stat`, `statPath`, `read`, `text`, `url`, `upload`, `put`,
  `delete`, `uploadUrl`. Types `StoredFile`, `FileOptions`, `FileUpload`,
  `UploadGrant`; a `FileUpload` is a statement argument (`SqlArg`).
- `http: true | 'public'` on `query`, `mutation` and `action`: the unit
  answers plain HTTP requests at `/units/v1/<database>/<unit>`.
  `ctx.request` (`HttpRequest`) is the request, `httpResponse(body, {
  status, headers })` shapes the answer, and `ctx.auth.kind` can be
  `'public'`.
- `@azora-db/units/testing`: `t.request(name, init)` sends an HTTP
  request to a unit, and `t.storage` seeds and reads the files
  `ctx.storage` sees. Both follow the engine, checked against it.
- `azora-units list` marks units that answer HTTP.

### Build

- `azora-units build [dir] --out <file>` writes the bundle to a file
  (and `<file>.map`) without connecting: the same bytes `publish` sends,
  for the engine's `azora units deploy`, the admin API, or a CI artifact.

### Access

- `query`, `mutation` and `action` take `access: 'any' | 'read' | 'write'`
  (`UnitAccess`): the scope a credential needs to call the unit. The
  engine now checks it. The default is `read` for a query and `write` for
  a mutation or an action, so **a read-only token can no longer call a
  mutation or an action unless the unit declares `access: 'any'`**; such
  a unit decides from `ctx.auth` what its caller may do.
- The local test environment (`@azora-db/units/testing`) checks access
  the same way; `azora-units list` marks units any credential may call.

### Jobs

- `ctx.scheduler` on `MutationCtx` and `ActionCtx` (not queries):
  `after(ms, unit, args?)` and `at(dateOrUnixMs, unit, args?)` return the
  job id, `cancel(id)` whether a waiting job was removed. `Scheduler<M>`
  checks unit names and arguments against a units module type
  (`ctx.scheduler as Scheduler<typeof import('./index.ts')>`).
- `ctx.unit.job` (`JobInfo`: `id`, `attempt`, `scheduledAt`,
  `scheduledBy`, `source`) in a job run, else `null`.
  `UnitInfo.trigger` (`UnitTrigger`) adds `job`, `cli` and `mcp`.
- `ctx.crypto.timingSafeEqual` and `ctx.log.debug` are typed, and
  `FetchResponse` matches what the engine returns: `headers` has
  `get`, `has` and `entries`, plus `statusText`, `url`, `redirected` and
  `bytes()`.
- `azora-units jobs [--state pending|failed] [--unit name] [--limit n]`
  lists waiting and failed jobs (a failed job shows when it failed and
  why); `azora-units jobs cancel <id>` and `jobs retry <id>`.

### Run log

- `azora-units logs` shows `rejected` runs (refused before the unit ran:
  arguments that do not match, an internal unit called by a client) apart
  from errors, and takes `--status ok|error|replayed|rejected`. Triggers
  now include `job`, `cli` and `mcp`.

### Local tests

- `@azora-db/units/testing`: `createTestEnv(units, options)` runs a units
  module in Node against an in-memory SQLite database (`node:sqlite`,
  Node.js 22.13+ or 23.4+, checked at runtime) with the engine's
  semantics: transactions per kind, `ctx.run` rules, internal units,
  argument schemas, the SQL check, value conversions, jobs on a fake
  clock (`t.advance`, `t.runJobs`, retries with backoff), schedules and
  onChange units run on demand, and the run log. Calls answer like
  `db.call`, with `@azora-db/client`'s `UnitError` and `AzoraError`. The
  README lists what differs from the engine.

### Fixes

- Publishing from a script that runs the package from source (as
  `pnpm dev:engine` does) and from the CLI (built `dist`) made different
  bundles, so the second publish made a new version. `@azora-db/units`
  imports now always resolve to the library's TypeScript source when it
  is there, and to the built `index.js` in an installed package.

## 0.1.0

First version: `query`, `mutation`, `action`, `schedule`, `onChange`, the
`v` validators, `UnitError`, the `ctx` types, the `azora-units` CLI
(`publish`, `dev`, `list`, `history`, `rollback`, `call`, `logs`,
`secrets`, `types --go`) and `@azora-db/units/tools`.
