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
`exec`, and only actions have `ctx.fetch`.

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
ctx.now(), ctx.uuid(), ctx.crypto.sha256/hmac/randomBytes
ctx.unit                     // { name, kind, trigger, mutationId, deploy }
```

Database calls are synchronous (`await` works on them too). The types are
`QueryCtx`, `MutationCtx` and `ActionCtx` (also `Ctx`); `ctx.db.all<Row>()`
and friends take the row type.

Units run in the engine's JavaScript interpreter, not in Node: there is no
`process`, `require`, file system or timers, and imports are bundled at
publish time. Pure dependencies from npm work if they need nothing of
Node or the browser.

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
| `logs [--follow] [--unit name] [--limit n]` | the run log, oldest first; `--follow` keeps printing new runs |
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
resolve to the CLI's own copy of the library.

A definition is a plain object, as `docs/units.md` (Bundle format)
describes: `{"~azora": 1, kind, handler, args, internal, description}`,
plus `mode`, `cron` and `every` for schedules and `mode`, `table`, `ops`
and `batch` for onChange units. `UnitError` sets its `name` on every
instance, which is how the engine recognizes it after bundling.
