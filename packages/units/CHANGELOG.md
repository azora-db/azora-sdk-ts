# Changelog

## Unreleased

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
