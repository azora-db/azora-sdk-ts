# Azora DB for TypeScript

`@azora-db/client` connects JavaScript and TypeScript programs to an
[Azora DB](../azora-engine) database: SQL, writes that apply exactly once,
live queries, change notifications, file storage and
[units](#units) (your own TypeScript functions, published into the
database and called like an API), over one connection that is encrypted
end to end and kept alive for you.

It runs in Node 22+, Bun, Deno and browsers. It has three small
dependencies (the audited `@noble` cryptography libraries) and optional
React bindings.

```ts
import { connect, sql } from '@azora-db/client'

const db = await connect('https://db.example.com/shop?key=<server key>', { token: process.env.AZORA_TOKEN })

const open = await db.query<Order>('SELECT * FROM orders WHERE status = ?', ['open'])
await db.exec(sql`UPDATE orders SET status = 'paid' WHERE id = ${open[0].id}`)

const live = await db.live<Order>('orders', { where: "status = 'open'", orderBy: ['total', 'desc'] })
live.subscribe(() => render(live.rows)) // every change, as it commits
```

- [Install](#install)
- [Connecting](#connecting)
- [Reading](#reading) · [Writing](#writing)
- [Live queries](#live-queries) · [Subscriptions](#subscriptions) · [Watching tables](#watching-tables)
- [Units](#units)
- [React](#react)
- [File storage](#file-storage)
- [Errors, timeouts and cancellation](#errors-timeouts-and-cancellation)
- [Guarantees and limits](#guarantees-and-limits)
- [Performance](#performance)
- [Examples](#examples) · [Developing](#developing)

## Install

```sh
pnpm add @azora-db/client        # or npm install, yarn add, bun add
```

The package is ESM with type declarations. Node 22 or later (it uses the
global `WebSocket` and `fetch`); older runtimes can pass a WebSocket
constructor with the `webSocket` option.

## Connecting

A client needs two values:

| Value | | What it is |
|---|---|---|
| `AZORA_URL` | public | Where the database is: `https://db.example.com/shop?key=<server key>` |
| `AZORA_TOKEN` | private | Who the client is: an API key (`azk_…`) or a client token (`azt1.…`) |

```ts
import { connect, connectEnv } from '@azora-db/client'

const db = await connect('https://db.example.com/shop?key=<server key>', { token: process.env.AZORA_TOKEN })
const db = await connectEnv()   // reads AZORA_URL and AZORA_TOKEN
```

On the server, `azora connect <database> --key <name>` creates an API key
and prints both lines, ready for a `.env` file (run it while the server
is stopped; `--url` sets the address when `storage.public_url` is not
configured).

`connect` resolves once the first connection is up, and rejects with the
reason otherwise (wrong server key, refused token, unreachable server).
After that the client reconnects by itself, with exponential backoff and
jitter. Keep one `Database` per process or page and share it.

**The URL** is the engine's HTTP address with the database as the last
path segment, and the server's public key:

```
http(s)://host[:port][/prefix]/<database>?key=<server key>
```

Nothing in it is secret: it can live in source code and ship in a browser
bundle. The SDK finds the rest from it: the connection is a WebSocket to
`/rt/v1` under that address (so the same URL works in servers and in
browsers), and [file storage](#file-storage) uses the same address.

**The server is authenticated by its key, not by a certificate.** Frames
are encrypted inside the WebSocket, so a TLS-terminating proxy or CDN only
sees ciphertext. The URL says how the key is checked:

| In the URL | Handshake | Use |
|---|---|---|
| `?key=<server key>` | Noise IK, one round trip | Pin the server's public key. The connection fails unless the server holds the private key. |
| `?fp=azp1-…` | Noise XX | The server sends its key and the client checks the fingerprint. |
| no key | Noise IK | The client first reads the key from `<address>/.well-known/azora.json`. **Only over `https` or to a loopback address.** |
| `?plaintext=1` | none | Tests and loopback only; the server and the database must allow it too. |

A URL without a key (`https://db.example.com/shop`) trusts the TLS
certificate to vouch for the key the server reports, so it is accepted
only over `https`, or for `localhost`, `127.x.x.x` and `::1`. Over plain
`http` to any other host nothing proves that the answer comes from the
right server: `connect` fails before sending anything and asks for
`?key=`. When a reconnect fails the handshake, the key is read again (the
server's key may have been rotated). A key pinned with `?key=` does not
depend on the certificate and is never replaced.

**The token** is an API key (scopes `read`, `write`, `ddl`, `admin`) for
servers, or a client token your backend mints for one user, optionally
limited to tables and pinned to filters (`azora realtime token create shop
--sub user:42 --table orders --filter "orders: customer = 42"`). Both go
in the `token` option (`apiKey` is another name for it), with the same
URL:

```ts
// A browser or an app: the public URL, and a short-lived token from your backend.
const db = await connect(import.meta.env.VITE_AZORA_URL, {
  token: () => fetch('/api/azora-token').then((r) => r.text()),
})
```

Pass a function and it is called on every reconnect and when the server
reports that the token expired: the new token is sent on the open
connection, and subscriptions continue. A token is never read from a URL.

`connectEnv(options?)` reads `process.env`: `AZORA_URL`, and `AZORA_TOKEN`
(or `AZORA_API_KEY` when that is not set). It rejects with an error that
names the missing variable. Browsers have no `process.env`: pass the
values to `connect`.

**Raw TCP and other forms.** Server runtimes can also connect to the
engine's TCP port, which is somewhat faster than the WebSocket (see
[Performance](#performance)). These URLs name the realtime endpoint
itself and always carry `key`, `fp` or `plaintext`; with `azora://`, file
storage needs the `storageUrl` option:

| Connection string | Transport |
|---|---|
| `azora://host[:7480]/<database>?key=…` | TCP (Node, Bun, Deno) |
| `wss://host[/rt/v1]?db=<database>&key=…` | WebSocket over TLS, the endpoint given directly |
| `ws://host[/rt/v1]?db=<database>&key=…` | plain WebSocket |
| `azoras+ws://…`, `azora+ws://…` | the same two, in the engine's own spelling |

Every part of a URL can also be an option (`host`, `port`, `webSocketUrl`,
`database`, `serverKey`, `fingerprint`, `storageUrl`, …); options win over
the URL. `azora serve` prints the server key and its fingerprint, and
`azora keys show` prints them again.

Other options: `pool`, `requestTimeoutMs` (30 s), `reconnectMinMs` /
`reconnectMaxMs` (100 ms / 30 s), `clientName`, `fetch`, `webSocket`, and
the hooks `onConnect`, `onDisconnect`, `onResync`, `onError`.

`db.session` describes the current session (principal, scopes, security
mode, server key); `db.connected`, `db.stats` and `db.ping()` report on
the connection. `await db.close()` ends it.

## Reading

```ts
const orders = await db.query<Order>('SELECT * FROM orders WHERE customer = ?', [42])   // objects
const order  = await db.queryOne<Order>('SELECT * FROM orders WHERE id = ?', [7])        // or undefined
const count  = await db.queryValue<number>('SELECT count(*) FROM orders')                // first cell
const raw    = await db.queryRaw('SELECT id, total FROM orders', [], { maxRows: 500 })   // { columns, rows, truncated }
```

The `sql` tag turns interpolated values into arguments, so they are never
part of the statement text:

```ts
await db.query(sql`SELECT * FROM orders WHERE status = ${status} AND id IN (${sql.join(ids)})`)
sql`SELECT * FROM ${sql.id(table)} WHERE ${where}`   // identifiers and nested statements
```

Values map to SQLite's types:

| JavaScript | SQLite |
|---|---|
| `null`, `undefined` | NULL |
| `number` that is a safe integer, `bigint` | INTEGER (64-bit) |
| any other `number` | REAL |
| `string` | TEXT |
| `Uint8Array`, `ArrayBuffer`, typed arrays | BLOB |
| `boolean` | 1 or 0 |
| `Date` | TEXT, ISO 8601 (`2026-01-02T03:04:05.000Z`) |

Coming back, integers are `number` while that is exact and `bigint` beyond
2^53; blobs are `Uint8Array`.

A read returns at most 10,000 rows (`truncated` tells when rows were cut;
page with `LIMIT`/`OFFSET` or a key). Reads are sent again on a new
connection if the connection drops.

## Writing

```ts
const { rowsAffected, lastInsertId } = await db.exec('INSERT INTO orders(customer, status, total) VALUES (?, ?, ?)', [42, 'open', 129.9])

await db.batch([                                   // one transaction: all or nothing
  ['UPDATE accounts SET balance = balance - ? WHERE id = ?', [2500, 'alice']],
  ['UPDATE accounts SET balance = balance + ? WHERE id = ?', [2500, 'bob']],
  sql`INSERT INTO transfers(src, dst, amount) VALUES (${'alice'}, ${'bob'}, ${2500})`,
])
```

**Every write applies exactly once.** `exec` and `batch` carry a random
mutation id and send the same id again after a reconnect; the server
stores the id with the write in the same transaction and answers a retry
with the first result (`replayed: true`). To keep that across restarts of
your own process, persist an id with the queued write and pass it as
`{ mutationId }` (see [`examples/exactly-once.ts`](examples/exactly-once.ts)).
The server keeps ids for 24 hours (`realtime.mutation_window`).

`batch` sends its statements together: there is no interactive
transaction, so a statement cannot use a value an earlier one returned
(except through SQL itself, such as `last_insert_rowid()` or a subquery).
`rowsAffected` is the total over the statements.

Schema changes (`CREATE`, `ALTER`, `DROP`) need the `ddl` scope, run alone
in an `exec`, and cannot carry a mutation id: if the connection drops
after one was sent, the call rejects with `UnknownOutcomeError` and you
decide whether to check and run it again.

## Live queries

A live query is a table (or the part of it a filter selects, or one row)
kept up to date locally. Publish the table once (`azora realtime publish
shop orders`); then:

```ts
const live = await db.live<Order>('orders', {
  where: "status = 'open' AND total > 100",   // or and(eq('status', 'open'), gt('total', 100))
  orderBy: ['total', 'desc'],                 // default: primary key order
})

live.rows                       // readonly Order[], loaded when live() resolves
live.get(42)                    // by primary key
live.subscribe(({ changes, rows, reset }) => { … })
for await (const { rows } of live) { … }
await live.close()
```

- **Always consistent.** Rows change only at checkpoints, which end on
  transaction boundaries: a listener never sees half of a transaction, and
  one transaction is one event.
- **Stable identities.** `rows` is the same array until something changes,
  and unchanged rows keep their objects, so UI frameworks can compare by
  reference.
- **Survives disconnects.** After a reconnect the query resumes from its
  last checkpoint: nothing is lost or delivered twice. When the server
  can no longer resume (the change log was pruned, the table's columns
  changed, the database was restored), it takes a new snapshot and the
  event has `reset: true`.
- **Verifiable.** `await live.verify()` compares a checksum of the local
  rows with the server's.

Options: `where`, `key` (one row), `orderBy` (column, `[column, 'desc']`,
several, or a comparator) and `map` (convert each row object, for example
to a class).

Filters are evaluated by the server on every change with SQLite's
comparison rules and no type conversion. Write them as text (`=`, `!=`,
`<`, `<=`, `>`, `>=`, `^=` for "starts with", `IN (…)`, `IS [NOT] NULL`,
`AND`, `OR`, `NOT`, parentheses) or build them: `eq`, `ne`, `lt`, `lte`,
`gt`, `gte`, `inList`, `notInList`, `isNull`, `notNull`, `startsWith`,
`and`, `or`, `not`.

## Subscriptions

`db.live()` is built on subscriptions; use them directly for change
streams, replicas you store yourself, or resuming across process
restarts.

```ts
const sub = await db.subscribe({ table: 'orders', where: eq('customer', 42) })
for await (const update of sub) {
  if (update.reset) store.clear()
  for (const c of update.changes) store.apply(c)       // c.op, c.key, c.new, c.old, c.columns
  await store.saveResumePoint(update.checkpoint, update.epoch)
}
```

| Spec | Delivers |
|---|---|
| `{}` | every published table |
| `{ table, where? }` | one table, optionally filtered |
| `{ table, key: [...] }` | one row by primary key |
| `{ bucket?, pathPrefix? }` | stored files |
| `{ tables: [...] }` | "these tables changed" notifications (see `watch`) |

- The first update is a snapshot (`reset` and `snapshot` set) unless you
  resume with `since` and `epoch` from a stored update, or pass
  `noSnapshot`.
- Asking for the next update acknowledges the previous one. An application
  that stops reading pauses its stream (the server sends at most about
  4 MiB ahead) instead of growing memory.
- `Replica` is a ready-made in-memory copy with `apply`, `get`, `rows` and
  `checksum`; `sub.verify(replica.checksum)` compares it with the server.
- `manualResync: true` makes a lost resume point reject with `ResyncError`
  instead of taking a new snapshot.

## Watching tables

For aggregates and joins, which a live query cannot express, ask to be
told when tables are written and run the query again. It works for any
table, published or not, and costs the server almost nothing:

```ts
const stop = await db.watch(['orders', 'refunds'], async () => {
  totals = await db.query('SELECT status, sum(total) FROM orders GROUP BY status')
})
```

The listener receives the tables that changed; `['*']` means "anything may
have changed" (after a reconnect, for example).

## Units

Units are functions you write in TypeScript in your own repository and
publish into a database, with the
[`@azora-db/units`](packages/units/README.md) package and its
`azora-units` CLI. They run inside the engine, next to the data, and any
client of the database calls them by name. A `mutation` is one
transaction (all or nothing) that runs exactly once per call, even when
the call is retried. The engine's
[`docs/units.md`](../azora-engine/docs/units.md) describes them in full.

```ts
// units/index.ts
import { mutation, query, v, UnitError } from '@azora-db/units'

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
npx azora-units publish        # bundles units/ and publishes it (an API key with the ddl scope)
```

**Calling.** Give `connect` or `connectEnv` the type of your units module
and `db.units` is typed from your source: arguments from the validators,
results from what the handlers return. `db.call` takes any name, untyped.

```ts
const db = await connectEnv<typeof import('./units')>()
const { orderId } = await db.units.checkout({ cartId: 'c1' })   // { cartId: string } => { orderId: number }
const orders = await db.units.myOrders()
await db.call<{ orderId: number }>('checkout', { cartId: 'c1' }, { mutationId: 'cart-c1' })
```

`typeof import('./units')` is only a type: nothing of the units' code
ends up in your client bundle. Only queries, mutations and actions that
are not `internal` appear on `db.units`. Without the type argument
`Database` is unchanged and `db.units.x` is untyped.

- **Any credential can call**, including a client token limited to some
  tables or rows, which cannot run SQL: the unit decides what the caller
  may do from `ctx.auth` (its kind, principal, subject, scopes, claims).
  This is how a browser does controlled writes.
- **Every call carries a fresh mutation id** and is sent again with the
  same id after a lost connection, so retries are always safe; pass your
  own `mutationId` to keep that across restarts of your process.
- Arguments and results are JSON. A `Uint8Array` travels as
  `{"$bytes": base64}` and comes back as a `Uint8Array`; bigints are sent
  as numbers (integers lose precision beyond 2^53).
- A unit that throws rejects with a **`UnitError`**: `code` (`invalid`,
  `not_found`, `permission_denied`, `conflict`, `failed`), `message`,
  `data` (the JSON value the unit attached) and `unit`. Failures around
  the unit are an `AzoraError` as usual: `not_found` (no such unit, or
  nothing published), `permission_denied` (an internal unit), `invalid`
  (arguments that do not match the unit's schema, or a value too large),
  `resource_exhausted` (a timeout or a limit), `unavailable`.
- A connection whose URL had no `?key=` read the server's discovery
  document; when it does not list `"units"`, `db.call` rejects at once
  with `unavailable: this server does not support units`.

**Operating** (an API key with the `ddl` scope): `db.unitsAdmin` has
`deploy`, `list`, `deploys`, `activate` (rollback), `call` (runs any unit
as the caller, internal ones too), `runs` (the run log), `triggers`,
`skipTrigger` and `secrets.list/set/unset`. Operations that change
something are not sent again after a lost connection (the call rejects
with `UnknownOutcomeError`); reads are. Most of the time the
`azora-units` CLI does this for you: `publish`, `dev`, `list`, `history`,
`rollback`, `call`, `logs --follow`, `secrets`, `types --go`.

[`examples/units`](examples/units) is a complete shop: a customer token
that cannot run SQL checks out its own cart through a unit, an internal
unit called with `ctx.run`, an `onChange` unit and a `schedule`.

## React

```tsx
import { AzoraProvider, useLiveQuery, useQuery, useAzora, useConnected } from '@azora-db/client/react'

<AzoraProvider db={db}><Orders /></AzoraProvider>

function Orders() {
  const { rows, ready, error } = useLiveQuery<Order>('orders', { where: "status = 'open'" })
  const totals = useQuery('SELECT status, count(*) AS n FROM orders GROUP BY status', [], { watch: ['orders'] })
  const db = useAzora()
  …
}
```

`useLiveQuery` re-renders after every consistent step; `useQuery` runs a
read and runs it again when a watched table is written. A complete app is
in [`examples/web`](examples/web).

For [units](#units), `useUnit(name)` calls one on demand and
`useUnitQuery(name, args, deps, { watch })` calls one and calls it again
when its arguments (compared by value) or `deps` change, or a watched
table is written. `useAzora<typeof import('./units')>()` returns a
database with a typed `db.units`.

```tsx
const checkout = useUnit<{ orderId: number }, { cartId: string }>('checkout')   // { call, pending, error, data }
<button disabled={checkout.pending} onClick={() => checkout.call({ cartId })}>Pay</button>

const { data: orders, loading } = useUnitQuery<Order[]>('myOrders', {}, [], { watch: ['orders'] })
```

## File storage

Files live in the database's storage and can be referenced from rows
(`FILE` columns). `db.storage` talks to the engine's HTTP server at the
address of the connection URL, so there is nothing else to configure (an
`azora://` connection needs the `storageUrl` option). It needs an API
key.

```ts
const obj = await db.storage.upload(file, { path: 'avatars/42.png' })       // Blob, bytes, string or stream
await db.exec('UPDATE users SET avatar = ? WHERE id = ?', [obj.id, 42])

const { url } = await db.storage.signUrl(obj.id, { ttlSeconds: 600 })       // opens this one file, no credentials
const res = await db.storage.download(obj.id, { range: [0, 1023] })         // a fetch Response
await db.storage.uploadResumable(bigFile, { path: 'video/talk.mp4', onProgress })
for await (const o of db.storage.listAll({ prefix: 'avatars/' })) { … }
await db.storage.delete(obj.id)
```

Browsers hold tokens, not API keys, so they upload through a **signed
upload URL** your backend creates, which can also write the new file's id
into a row in the same transaction:

```ts
// backend
const { url } = await db.storage.signUploadUrl({ maxSize: 2 << 20, allowedTypes: 'image/png,image/jpeg',
  table: 'users', column: 'avatar', keyValue: '42', ttlSeconds: 300 })
// browser
import { uploadToSignedUrl } from '@azora-db/client'
await uploadToSignedUrl(url, file)
```

`db.signUrl(objectId)` signs a download URL over the realtime connection
and works with tokens too. In SQL, `azora_url(column)` returns signed
links with the rows.

## Errors, timeouts and cancellation

| Error | Meaning |
|---|---|
| `AzoraError` | The server refused the request. `code` is stable: `invalid` (bad SQL, constraint), `unauthenticated`, `permission_denied`, `not_found`, `resource_exhausted`, `unavailable`, `gone`, `conflict`, `internal`. `isCode(err, 'invalid')` narrows. |
| `HandshakeError` | The server could not prove it holds the expected key. |
| `ConnectionError` | The server could not be reached, or did not report its key for a URL without one (only from `connect`). |
| `TimeoutError` | The call ran past its timeout. When the client was disconnected, the message says why. |
| `UnitError` | A [unit](#units) threw: `code`, `message`, `data`, `unit`. |
| `UnknownOutcomeError` | A schema change (or a `unitsAdmin` change) was sent and the connection dropped before its answer. |
| `ClosedError` | The database or subscription was closed. |

Every call takes `{ signal, timeoutMs }`. Rate limits (`resource_exhausted`
with a retry hint) and a database that is briefly unavailable are retried
for you within the call's timeout. A refused credential fails calls at
once instead of waiting for the timeout.

## Guarantees and limits

- **Reads** are retried across reconnects. **Writes** apply exactly once
  within the mutation window. A call cancelled or timed out after its
  write was sent has an unknown outcome unless you sent your own
  `mutationId` and retry with it.
- **Live queries and subscriptions** deliver every committed change of
  published tables once, in commit order, in consistent steps.
- **No interactive transactions**: use `batch`.
- **One statement per call**; `ATTACH`, `VACUUM`, transaction control and
  pragma assignments are refused by the server.
- **Tokens limited to tables or filters cannot run SQL**; they subscribe.
- The server allows 1,000 requests per second per connection by default
  (`realtime.message_rate`); beyond it requests are delayed, not failed.
  Raise the setting, or use `pool`, for more.
- A `number` cannot tell `2.0` from `2`: a whole number is sent as an
  integer. SQLite converts it for `REAL` columns, so this only matters
  for typeless columns.
- The SDK does not mint tokens or manage databases; that is the engine's
  CLI, Go library and admin API.

## Performance

Measured with `pnpm bench` on one machine shared by engine and client
(Node 24, a 10,000-row table, the engine's per-connection rate limit
lifted). Take the ratios, not the absolutes:

| Operation | Rate | p50 | p99 |
|---|---|---|---|
| Point read, TCP, one at a time | 5,200 /s | 0.15 ms | 1.0 ms |
| Point read, TCP, 64 concurrent | 18,600 /s | 2.9 ms | 10.5 ms |
| Point read, WebSocket, 64 concurrent | 15,300 /s | 3.4 ms | 16 ms |
| Point read, plaintext TCP, 64 concurrent | 27,200 /s | 2.0 ms | 6.9 ms |
| 1,000-row read | 1,000 /s (a million rows/s) | 3.1 ms | 16 ms |
| Single-row write, 16 concurrent | 5,200 /s | 2.5 ms | 13 ms |
| 10-statement batch | 4,500 /s | 0.7 ms | 3.4 ms |
| Commit to live-query delivery, including the write | | 0.5 ms | 1.8 ms |

- Encryption costs about a third of the throughput of small requests.
  Small frames are encrypted in JavaScript and large ones with the
  runtime's native cipher, whichever is faster for the size
  (`pnpm bench:aead` shows the crossover).
- `pool: n` opens n connections. It helps when statements are slow on the
  server (which runs 8 per connection at a time) or when the
  per-connection rate limit binds. For fast point reads a single
  connection already saturates one JavaScript thread, and the pool
  changes nothing.

## Examples

```sh
pnpm install && pnpm build
pnpm dev:engine                                          # a seeded local engine; writes examples/.env
node --env-file=examples/.env examples/quickstart.ts     # in another terminal
```

`examples/.env` holds `AZORA_URL` and `AZORA_TOKEN`, and every example
connects with those two values (`connectEnv()`).

| Example | Shows |
|---|---|
| [`quickstart.ts`](examples/quickstart.ts) | `connectEnv`, query, `sql`, exec, batch |
| [`live-orders.ts`](examples/live-orders.ts) | a live query in the terminal, checksum verification |
| [`exactly-once.ts`](examples/exactly-once.ts) | an outbox with persisted mutation ids replayed after a crash |
| [`files.ts`](examples/files.ts) | uploads, signed URLs, resumable upload, ranges, through the same URL |
| [`tokens.ts`](examples/tokens.ts) | the same URL with a client token pinned to one customer's rows |
| [`watch.ts`](examples/watch.ts) | an aggregate kept fresh with `watch` |
| [`units/`](examples/units) | units: publish a shop's units, call them with the API key and with a customer token that cannot run SQL (`node --env-file=examples/.env examples/units/shop.ts`) |
| [`web/`](examples/web) | a React orders board in the browser: `cd examples/web && pnpm install && pnpm dev` |

The dev engine needs the engine binary: set `AZORA_BIN`, or build
`../azora-engine` (`make build`).

## Developing

```sh
pnpm typecheck
pnpm test          # unit tests, and integration tests against a real engine
pnpm test:fast     # without the million-frame rekey test (about 90 s)
pnpm test:units    # the @azora-db/units package alone
pnpm build         # dist/, with type declarations (both packages)
pnpm bench
```

The repository is a pnpm workspace: the root is `@azora-db/client`,
[`packages/units`](packages/units) is `@azora-db/units`, and
`examples/units` uses both.

Unit tests need nothing: they check the codec byte for byte against
vectors written by the Go implementation (`test/fixtures/messages.txt`),
run both Noise handshakes against an in-process peer, and drive the client
with a scripted server that drops connections, rate-limits and expires
credentials, and one that holds a real key for discovery and key
rotation. Integration tests start `azora serve` on a temporary data root
(they are skipped when there is no engine binary) and cover every URL
form and handshake over both transports, discovery of the server key on
loopback, restarts and crashes of the server mid-stream, key rotation,
token refresh, file storage and units (publishing, calls with an API key
and a restricted token, exactly-once mutations, the admin operations and
the CLI; those are skipped when the engine does not list `"units"` in its
discovery document).

The wire protocol is specified in the engine's
[`docs/protocol.md`](../azora-engine/docs/protocol.md). Source layout:

```
src/codec.ts, messages.ts     binary encoding and the 27 message types
src/noise.ts, channel.ts      Noise IK/XX, framing, chunking, rekeying
src/transport.ts, platform/   WebSocket; TCP and native cipher for Node
src/config.ts, discovery.ts   options, connection URLs, the server key of a URL without one
src/session.ts, client.ts     one connection: heartbeat, reconnect, retries, credentials
src/subscription.ts           staging at checkpoints, resume, acknowledgement, verify
src/live.ts, replica.ts       live queries and in-memory copies
src/database.ts               the public API; src/react.ts the hooks
src/units.ts                  unit calls: JSON with blobs, db.units types, the admin facade
src/storage.ts                the HTTP file API
packages/units/               @azora-db/units: unit helpers, validators, ctx types, the CLI
```
