# @azora-db/units

Write [Azora DB](../../../azora-engine) **units** in TypeScript: functions
that you keep in your own repository, publish into a database, and that
every client of that database calls by name, like an API. They run inside
the engine, next to the data: a `mutation` is one transaction that commits
when it returns, rolls back when it throws, and runs exactly once per call
even when the call is retried.

```ts
// units/index.ts
import { query, mutation, v, UnitError } from '@azora-db/units'

export const myOrders = query({
  handler: (ctx) => ctx.db.all('SELECT * FROM orders WHERE customer = ?', ctx.auth.subject),
})

export const checkout = mutation({
  args: { cartId: v.string() },
  handler(ctx, { cartId }) {
    const cart = ctx.db.one<{ owner: string; total: number }>('SELECT * FROM carts WHERE id = ?', cartId)
    if (!cart) throw new UnitError('not_found', 'no such cart')
    const { lastInsertId } = ctx.db.exec('INSERT INTO orders(customer, total) VALUES (?, ?)', cart.owner, cart.total)
    ctx.db.exec('DELETE FROM carts WHERE id = ?', cartId)
    return { orderId: lastInsertId }
  },
})
```

```sh
npm i -D @azora-db/units
npx azora-units publish
```

```ts
// any client, typed from the source above (@azora-db/client)
const db = await connectEnv<typeof import('./units')>()
const { orderId } = await db.units.checkout({ cartId: 'c1' })
```

The engine's [`docs/units.md`](../../../azora-engine/docs/units.md) is the
full reference (kinds, guarantees, limits, configuration, protocol).

- [Writing units](#writing-units)
- [Arguments](#arguments)
- [The ctx API](#the-ctx-api)
- [Jobs](#jobs)
- [Testing units locally](#testing-units-locally)
- [The CLI](#the-cli)
- [Scripts](#scripts)
- [How a bundle is built](#how-a-bundle-is-built)

## Writing units

Every named export made with one of the helpers is a unit, named after the
export (1 to 64 letters, digits and `_`, starting with a letter). Other
exports are ignored.

| Helper | Runs | `ctx.db` | `ctx.fetch` |
|---|---|---|---|
| `query({ args?, handler })` | one read transaction, a consistent snapshot | reads | no |
| `mutation({ args?, handler })` | one write transaction, exactly once per mutation id | reads and writes | no |
| `action({ args?, handler })` | no implicit transaction; `ctx.db.tx(fn)` groups writes | reads and writes | yes |
| `schedule({ cron \| every, mode?, handler })` | on a schedule, as a mutation (default) or an action | | with `mode: 'action'` |
| `onChange({ table, ops?, batch?, mode?, handler })` | with the rows that changed in a table | | with `mode: 'action'` |

`query`, `mutation` and `action` also take `internal: true` (clients cannot
call it; other units can, with `ctx.run`) and `description` (shown in the
dashboard and to AI agents). `schedule` and `onChange` units are always
internal.

```ts
export const nightly = schedule({ cron: '0 3 * * *', handler: (ctx) => { /* ... */ } })
export const sync = schedule({ every: '5m', mode: 'action', handler: async (ctx) => { /* ctx.fetch(...) */ } })
export const paid = onChange<Order>({
  table: 'orders', ops: ['update'],
  handler: (ctx, { changes, gap }) => {
    for (const c of changes) if (c.new?.status === 'paid') ctx.db.exec('INSERT INTO audit(what) VALUES (?)', `paid ${c.new.id}`)
  },
})
```

Throw `new UnitError(code, message, data?)` to answer the caller with an
error: `code` is `invalid`, `not_found`, `permission_denied`, `conflict` or
`failed`, and `data` any JSON value. Anything else a unit throws reaches
the caller as `failed` with its message; the stack, mapped to your
TypeScript by the source map, goes to the run log.

**Types.** Handler arguments are typed from the validators, and the
definition carries the unit's kind, arguments and result as a phantom
`"~azora"` type that `@azora-db/client` reads:
`connect<typeof import('./units')>()` types `db.units.checkout(args)` with
the validators' type and the handler's return type. Without `args`, a
handler can annotate its second parameter to type it
(`handler: (ctx, a: { n: number }) => ...`). A query's `ctx.db` has no
`exec`, only mutations and actions have `ctx.scheduler`, and only actions
have `ctx.fetch`.

## Arguments

`args` is an object of validators (an object argument with exactly these
keys) or a single validator. The engine checks the arguments against the
JSON Schema the validators produce before the unit runs and answers
`invalid` when they do not match. Without `args` the unit accepts
anything.

| Validator | TypeScript | JSON Schema |
|---|---|---|
| `v.string({ min?, max?, pattern? })` | `string` | `{type: "string", minLength, maxLength, pattern}` |
| `v.number({ min?, max? })` | `number` | `{type: "number", minimum, maximum}` |
| `v.int({ min?, max? })` | `number` | `{type: "integer", minimum, maximum}` |
| `v.boolean()`, `v.null()` | `boolean`, `null` | `{type: "boolean"}`, `{type: "null"}` |
| `v.literal('paid')` | `'paid'` | `{const: "paid"}` |
| `v.enum(['open', 'paid'])` | `'open' \| 'paid'` | `{enum: [...]}` |
| `v.array(item, { min?, max? })` | `T[]` | `{type: "array", items, minItems, maxItems}` |
| `v.object({ ... })` | `{ ... }` | `{type: "object", properties, required, additionalProperties: false}` |
| `v.record(value)` | `Record<string, T>` | `{type: "object", additionalProperties: value}` |
| `v.optional(x)` | an optional key | `x`, left out of `required` |
| `v.nullable(x)` | `T \| null` | `{anyOf: [x, {type: "null"}]}` |
| `v.union(a, b, ...)` | `A \| B` | `{anyOf: [...]}` |
| `v.any()` | `any` | `{}` |
| `v.bytes()` | `Uint8Array` | `{type: "object", properties: {$bytes: {type: "string"}}, required: ["$bytes"]}` |

Every validator takes `description`. A `pattern` given as a `RegExp` is
sent as its source (flags are dropped); the engine evaluates it, so keep to
syntax its regular expressions support.

## The ctx API

```ts
ctx.db.all(sql, ...args)     // rows as objects
ctx.db.one(sql, ...args)     // first row or null
ctx.db.value(sql, ...args)   // first column of the first row, or null
ctx.db.exec(sql, ...args)    // { rowsAffected, lastInsertId }
ctx.db.batch([[sql, ...args], ...])
ctx.db.tx((db) => ...)       // action: one write transaction
ctx.auth                     // { kind, principal, subject, scopes, tables, claims, has(scope) }
ctx.run(name, args)          // another unit (internal ones too)
ctx.fetch(url, init)         // actions only
ctx.env.NAME                 // a secret, or undefined
ctx.log.info(...), .warn(...), .error(...)
ctx.now(), ctx.uuid(), ctx.crypto.sha256/hmac/randomBytes/timingSafeEqual
ctx.scheduler.after(ms, unit, args?)       // mutations and actions: run a unit later; the job id
ctx.scheduler.at(dateOrUnixMs, unit, args?)
ctx.scheduler.cancel(id)                   // true if a waiting job was removed
ctx.unit                     // { name, kind, trigger, mutationId, deploy, job }
```

`ctx.unit.trigger` says what started the run: `call` (a client),
`schedule`, `change` (onChange), `job`, `admin` (the admin API and the
dashboard), `cli` (`azora-units call`, `db.unitsAdmin.call`) or `mcp` (an
AI agent). `ctx.unit.job` is `{ id, attempt, scheduledAt, scheduledBy,
source }` in a job run and `null` otherwise.

Database calls are synchronous (`await` works on them too). The types are
`QueryCtx`, `MutationCtx` and `ActionCtx` (also `Ctx`); `ctx.db.all<Row>()`
and friends take the row type.

Units run in the engine's JavaScript interpreter, not in Node: there is no
`process`, `require`, file system or timers, and imports are bundled at
publish time. Pure dependencies from npm work if they need nothing of
Node or the browser.

## Jobs

`ctx.scheduler` (mutations and actions, not queries) runs a mutation or an
action later, once, and returns the job's id (`job_` and 26 characters):

```ts
export const placeOrder = mutation({
  args: { cartId: v.string() },
  handler(ctx, { cartId }) {
    const { lastInsertId } = ctx.db.exec('INSERT INTO orders(cart) VALUES (?)', cartId)
    const reminder = ctx.scheduler.after(24 * 3600e3, 'remindUnpaid', { orderId: lastInsertId })
    ctx.db.exec('UPDATE orders SET reminder = ? WHERE id = ?', reminder, lastInsertId)
  },
})

export const pay = mutation({
  args: { orderId: v.number() },
  handler(ctx, { orderId }) {
    const o = ctx.db.one<{ reminder: string }>('SELECT reminder FROM orders WHERE id = ?', orderId)
    if (o) ctx.scheduler.cancel(o.reminder)
    ctx.db.exec('UPDATE orders SET paid = 1 WHERE id = ?', orderId)
  },
})

export const remindUnpaid = action({ internal: true, args: { orderId: v.number() }, handler: async (ctx, { orderId }) => { /* ctx.fetch(...) */ } })
```

- In a mutation the job is written in its transaction: if the mutation
  throws, it was never scheduled (and a `cancel` is undone). An action
  writes it at once, or in its `ctx.db.tx`.
- The target is a mutation or action (internal ones too); its arguments
  are checked when the job is scheduled and again when it runs. `after`
  takes milliseconds, `at` a `Date` or unix ms; at most 366 days ahead.
- Jobs run under `azora serve` (the dev engine runs it), as the system:
  `ctx.auth.kind` is `"system"`, `ctx.auth.principal` `job:<id>`, the run
  log's trigger `job`. A mutation job runs exactly once, an action job at
  least once.
- A job that throws runs again after 1s, 2s, 4s ... up to an hour, 5 times
  in all (`units.job_attempts`), then is kept as failed:
  `azora-units jobs` lists waiting and failed jobs, `jobs retry <id>` runs
  a failed one again, `jobs cancel <id>` removes one. To give up quietly,
  return instead of throwing.

**Types.** Unit names are strings and arguments `unknown`. Give the
scheduler your module's type to have both checked:

```ts
import type { Scheduler } from '@azora-db/units'
type Units = typeof import('./index.ts')

const scheduler = ctx.scheduler as Scheduler<Units>
const id: string = scheduler.after(60_000, 'remindUnpaid', { orderId })   // a typo or wrong args: a type error
```

Annotate the id (`const id: string`) when it flows into the handler's
result: the module's type then depends on itself, which TypeScript
reports as a circular type otherwise.

## Testing units locally

`@azora-db/units/testing` runs your units in Node, without an engine,
against an in-memory SQLite database. It needs `node:sqlite` without a
flag: **Node.js 22.13 or later (or 23.4 and later)**; older versions get a
clear error. It works with vitest, `node:test` or any runner.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UnitError } from '@azora-db/client'
import { createTestEnv } from '@azora-db/units/testing'
import * as units from '../units/index.ts'

test('checkout', async () => {
  const t = createTestEnv(units, {
    schema: ['CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER, total REAL)', "INSERT INTO carts VALUES ('c1', 42, 20)", /* ... */],
    auth: { kind: 'token', subject: 'user:42', claims: { plan: 'pro' } },
    env: { STRIPE_KEY: 'sk_test' },
  })
  const { orderId } = await t.call('checkout', { cartId: 'c1' })      // typed from the module
  assert.deepEqual(t.db.all('SELECT customer FROM orders WHERE id = ?', orderId), [{ customer: 42 }])
  await assert.rejects(t.call('checkout', { cartId: 'c1' }), (e) => e instanceof UnitError && e.code === 'not_found')
  await t.advance(24 * 3600e3)                                        // the fake clock: due jobs run
})
```

| | |
|---|---|
| `createTestEnv(units, options?)` | `schema` (SQL run first; a string may hold several statements), `auth` (the caller: `kind`, `principal`, `subject`, `scopes`, `tables`, `claims`; default an API key `key:test` with read and write), `env` (secrets), `fetch` (what `ctx.fetch` uses), `now` (the clock's start), `random` (bytes for ids, `ctx.uuid`, `randomBytes`), `jobAttempts`, `limits`, `onLog`. The definitions are checked as a deploy checks them. |
| `t.call(name, args?, { auth?, as?, mutationId? })` | calls as `db.call` does: arguments and result through JSON (blobs as `Uint8Array`), a thrown `UnitError` rejects with `@azora-db/client`'s `UnitError`, a failure around the unit (no such unit, internal unit, arguments that do not match) with its `AzoraError` and the engine's message. `as: 'cli'` calls like `azora-units call` (internal units allowed, trigger `cli`), `as: 'admin'` like the dashboard. A `mutationId` given twice replays the first result. |
| `t.units.<name>(args)` | the same, like `db.units` |
| `t.db.all/one/value/exec`, `t.db.raw` | the database, to set up and inspect state (no SQL check) |
| `t.jobs({ state?, unit? })`, `t.runJobs()`, `t.advance(ms)`, `t.now()` | jobs, as `azora-units jobs` shows them; run the due ones; move the clock, running each job when it falls due (retries included) |
| `t.cancelJob(id)`, `t.retryJob(id)` | as `azora-units jobs cancel` / `retry` |
| `t.runSchedule(name)`, `t.change(name, changes, { gap? })` | run a schedule, or an onChange unit with `[{ op, new?, old?, key? }]` (`key` defaults to the row's primary key) |
| `t.runs({ unit?, status? })`, `t.logs({ unit? })` | the run log (oldest first, with `rejected` runs) and the `ctx.log` lines |
| `t.close()` | closes the database |

**What is emulated**, following the engine's code: query, mutation and
action transactions (a query cannot write, a mutation rolls back when it
throws, an action commits each write on its own and groups them with
`ctx.db.tx`); `ctx.run` and its rules (what may run what, 8 deep, the same
transaction for a query or mutation run from a mutation, arguments
checked); internal units refused to clients; argument schemas with the
engine's subset and messages; the SQL check (one statement per call, no
`BEGIN`/`COMMIT`/`PRAGMA`/`ATTACH`/`VACUUM`, no `azora_units*` tables);
values (integers as numbers, `bigint` beyond 2^53, blobs as `Uint8Array`,
booleans stored as 1/0, `Date` as unix ms, results through JSON with
bigints beyond 2^53 as strings); `ctx.auth`, read-only `ctx.env`,
`ctx.log`, `ctx.now()` and `ctx.uuid()` from the env's clock and random
bytes, `ctx.crypto`, `ctx.unit`; jobs (written in the mutation's
transaction, the target and arguments checked, run as `job:<id>` with
`ctx.unit.job`, exactly once for mutations, retried after 1s, 2s, 4s ...
and failed after `jobAttempts`); the per-call statement, row, value-size,
job and fetch limits; the run log with its statuses and triggers.

**What differs from the engine:**

- Code runs in Node's V8, not the engine's goja interpreter. Timeouts
  (`units.timeout`, `units.action_timeout`) are not enforced, nor is
  memory. Node's APIs (`process`, timers, `Buffer`, the file system,
  `console` printing to your terminal instead of the run log) are there
  locally and not in the engine; a unit that uses them passes here and
  fails when published.
- The engine settles a handler's promise only through ctx calls: an
  `async` handler that awaits a timer or other I/O fails there ("returned
  a promise that never settled") but works here.
- Error messages from V8 (`Cannot read properties of null`) and from
  SQLite through node:sqlite (`UNIQUE constraint failed: t.id`) can be
  worded differently from the engine's.
- `pattern` validators run as JavaScript regular expressions (the engine
  uses Go's RE2).
- onChange units are not driven by writes: `t.change` gives them the
  changes to test. Schedules run when `t.runSchedule` says so, and jobs
  when `t.runJobs` or `t.advance` run them, never on their own; `t.call`
  does not move the clock.
- Everything runs on one connection, one call at a time: in an action, a
  query run with `ctx.run` while a `ctx.db.tx` is open sees that
  transaction's writes (on the engine it reads committed data).
- `ctx.fetch` uses the `fetch` option (a mock, or `globalThis.fetch`) and
  refuses without it; there is no private-address check. Cron
  expressions are not parsed; `ctx.unit.deploy` is 1.

`examples/units/shop.test.ts` tests the example shop this way
(`pnpm test` in `examples/units`), and the SDK's integration tests check
that the same calls give the same answers locally and on a real engine.

## The CLI

`azora-units` reads `AZORA_URL` and `AZORA_TOKEN` from the environment or
from `.env` in the current directory (`--env-file <path>` for another
file; the environment wins). Every command needs an API key with the
`ddl` (or `admin`) scope. `--json` prints JSON.

| Command | |
|---|---|
| `publish [dir] [--dry-run] [--note text]` | bundles `dir` (default `units`) and publishes it as a new version; the same bundle twice makes no new version; `--dry-run` checks it on the server |
| `dev [dir]` | publishes, then publishes again on every save (debounced) |
| `list` | the active version's units |
| `history [--limit n]` | the deploy history |
| `rollback <version>` | makes an earlier version active again |
| `call <unit> [json]` | calls a unit as you, internal ones too, and prints the result |
| `logs [--follow] [--unit name] [--status s] [--limit n]` | the run log, oldest first, with each run's trigger (`call`, `schedule`, `change`, `job`, `admin`, `cli`, `mcp`) and principal; `--status` is `ok`, `error`, `replayed` or `rejected` (refused before the unit ran: arguments that do not match, an internal unit called by a client), shown apart from errors; `--follow` keeps printing new runs |
| `jobs [--state pending\|failed] [--unit name] [--limit n]` | jobs scheduled with `ctx.scheduler`: waiting ones (when due) first, then failed ones (when they failed, and why) |
| `jobs cancel <id>` / `jobs retry <id>` | remove a job, waiting or failed; run a failed job again now, its attempts reset |
| `secrets list` / `secrets set <name> [value]` / `secrets unset <name>` | secrets units read as `ctx.env.NAME`; without a value, `set` reads it from stdin |
| `types --go <dir> [--package name] [--remote] [units dir]` | Go argument structs and typed wrappers, from the units' schemas |

`types --go` writes `<dir>/units.go`, with one wrapper per callable unit
around `azora.Call[R]` of
[`github.com/azora-db/azora-go`](../../../azora-go). The schemas describe
arguments only, so the result type is yours:

```go
res, err := units.Checkout[CheckoutResult](ctx, db, units.CheckoutArgs{CartID: "c1"})
```

It reads the local units by default, `--remote` the published version.

## Scripts

`@azora-db/units/tools` (Node) has what the CLI is made of:

```ts
import { connectEnv } from '@azora-db/client'
import { bundleUnits, publishUnits } from '@azora-db/units/tools'

const db = await connectEnv()
const { version, units, unchanged } = await publishUnits(db, 'units', { note: 'release 12' })
```

`bundleUnits(dir)` returns the bundle and its source map,
`evaluateBundle(bundle)` runs it in a fresh context and returns the
definitions, `manifestOf(definitions)` describes them as the server does,
`generateGo(units, { package })` writes Go, and `loadEnv()` reads the
environment like the CLI.

## How a bundle is built

`publish` bundles `units/index.ts` if there is one, else every `.ts` and
`.js` file in the directory (not `*.test.*`, `*.spec.*` or `*.d.ts`), with
esbuild: one script (`format: "iife"`, `target: "es2020"`, `platform:
"neutral"`) that sets `globalThis.__azora_units` to the definitions, keyed
by export name. The source map is sent with it (`source_map`), so stack
traces in the run log point at your TypeScript. `@azora-db/units` imports
resolve to the library's own copy: its TypeScript source in a checkout of
this repository, its built `index.js` in an installed package. The same
sources make the same bundle (and publishing it again makes no new
version) whether the bundler runs from the CLI or from a script.

A definition is a plain object, as `docs/units.md` (Bundle format)
describes: `{"~azora": 1, kind, handler, args, internal, description}`,
plus `mode`, `cron` and `every` for schedules and `mode`, `table`, `ops`
and `batch` for onChange units. `UnitError` sets its `name` on every
instance, which is how the engine recognizes it after bundling.
