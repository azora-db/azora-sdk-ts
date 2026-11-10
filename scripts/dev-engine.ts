/**
 * Boots a local Azora engine with a seeded `shop` database for the
 * examples, publishes the example units (examples/units), writes
 * examples/.env and keeps serving until Ctrl+C.
 *
 *   pnpm build && pnpm dev:engine
 *
 * It needs the engine binary: AZORA_BIN, or ../azora-engine/bin/azora
 * (`make build` in the engine repository).
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect } from '@azora-db/client'
import { publishUnits } from '../packages/units/src/publish.ts'
import { startEngine } from '../test/helpers/engine.ts'

const engine = await startEngine({
  schema: [
    'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer INTEGER NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
    'CREATE INDEX orders_status ON orders(status)',
    'CREATE TABLE accounts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, balance INTEGER NOT NULL CHECK (balance >= 0))',
    'CREATE TABLE transfers(id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
    'CREATE TABLE documents(id INTEGER PRIMARY KEY, title TEXT NOT NULL, file FILE)',
    // The units example (examples/units): carts become orders; units write audit lines.
    'CREATE TABLE carts(id TEXT PRIMARY KEY, customer INTEGER NOT NULL, total REAL NOT NULL, note TEXT)',
    'CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, what TEXT NOT NULL, detail TEXT)',
    "INSERT INTO carts(id, customer, total, note) VALUES ('cart-42', 42, 129.90, 'Standing desk frame'), ('cart-7', 7, 59.99, 'Desk mat')",
    "INSERT INTO accounts(id, owner, balance) VALUES ('alice', 'Alice Mbeki', 50000), ('bob', 'Bob Okafor', 12000), ('carol', 'Carol Nyirenda', 8000)",
    "INSERT INTO orders(customer, status, total, note) VALUES (42, 'open', 129.90, 'Standing desk frame'), (42, 'paid', 18.50, 'Cable tray'), (7, 'open', 349.00, 'Monitor arm, dual'), (7, 'shipped', 59.99, 'Desk mat'), (13, 'open', 24.00, 'Cable clips')",
  ],
  publish: ['orders', 'accounts', 'transfers', 'files'],
  tokens: {
    // What a backend would mint for a signed-in customer: their own orders only.
    customer42: ['--sub', 'user:42', '--scope', 'read', '--ttl', '12h', '--table', 'orders', '--filter', 'orders: customer = 42'],
    // The browser demo's token: read and write, 12 hours.
    web: ['--sub', 'demo:web', '--scope', 'read,write', '--ttl', '12h'],
  },
})

// What clients connect with: the URL is public, the tokens are private.
const url = `${engine.connectUrl}?key=${engine.serverKey}`
const env = [
  `AZORA_URL=${url}`,
  `AZORA_TOKEN=${engine.apiKey}`,
  `AZORA_TOKEN_CUSTOMER42=${engine.tokens['customer42']}`,
  `VITE_AZORA_URL=${url}`,
  `VITE_AZORA_TOKEN=${engine.tokens['web']}`,
  `AZORA_TCP_URL=${engine.tcpUrl}?key=${engine.serverKey}`,
].join('\n')
const file = fileURLToPath(new URL('../examples/.env', import.meta.url))
writeFileSync(file, env + '\n')

// Publish the example units, when this engine has units.
let units = ''
const doc = (await (await fetch(`${engine.httpUrl}/.well-known/azora.json`)).json()) as { features?: unknown }
if (!Array.isArray(doc.features) || !doc.features.includes('units')) {
  units = 'This engine does not support units yet: examples/units was not published.'
} else {
  const db = await connect(url, { token: engine.apiKey })
  try {
    const r = await publishUnits(db, fileURLToPath(new URL('../examples/units/units', import.meta.url)), { note: 'pnpm dev:engine' })
    units = `Published examples/units as version ${r.version}: ${r.units.map((u) => u.name).join(', ')}.`
  } catch (e) {
    units = `Publishing examples/units failed: ${(e as Error).message}`
  } finally {
    await db.close()
  }
}

console.log(`Azora engine is serving the "shop" database.

  AZORA_URL  ${url}
  Raw TCP    ${engine.tcpUrl}?key=${engine.serverKey}
  Data root  ${engine.dir}

Wrote AZORA_URL, AZORA_TOKEN and the examples' tokens to
${file}

${units}

Run an example in another terminal:

  node --env-file=examples/.env examples/quickstart.ts
  node --env-file=examples/.env examples/units/shop.ts

Ctrl+C stops the engine.`)

const stop = async (): Promise<void> => {
  await engine.stop()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
