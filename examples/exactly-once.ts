/**
 * Exactly-once writes across crashes: a money transfer queued in a local
 * outbox with its mutation id, replayed after a simulated crash. The
 * balances move once, however many times the transfer is sent.
 *
 *   node --env-file=examples/.env examples/exactly-once.ts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, newMutationId, type BatchStatement, type Database } from '@azora-db/client'

const OUTBOX = join(tmpdir(), 'azora-example-outbox.json')

interface Queued {
  mutationId: string
  src: string
  dst: string
  amount: number
}

const transfer = (t: Queued): BatchStatement[] => [
  // The CHECK (balance >= 0) on accounts makes an overdraft fail the whole batch.
  ['UPDATE accounts SET balance = balance - ? WHERE id = ?', [t.amount, t.src]],
  ['UPDATE accounts SET balance = balance + ? WHERE id = ?', [t.amount, t.dst]],
  ['INSERT INTO transfers(src, dst, amount) VALUES (?, ?, ?)', [t.src, t.dst, t.amount]],
]

async function flush(db: Database): Promise<void> {
  if (!existsSync(OUTBOX)) return
  for (const t of JSON.parse(readFileSync(OUTBOX, 'utf8')) as Queued[]) {
    const r = await db.batch(transfer(t), { mutationId: t.mutationId })
    console.log(`  ${t.src} -> ${t.dst} ${t.amount}: ${r.replayed ? 'already applied, answered from the first run' : 'applied'}`)
  }
  rmSync(OUTBOX)
}

const balances = async (db: Database): Promise<string> =>
  (await db.query<{ id: string; balance: number }>('SELECT id, balance FROM accounts ORDER BY id')).map((a) => `${a.id}=${a.balance}`).join('  ')

const url = process.env['AZORA_URL']!
const apiKey = process.env['AZORA_API_KEY']!

let db = await connect(url, { apiKey })
console.log('before:        ', await balances(db))

// 1. Persist the intent with its id BEFORE sending it.
const queued: Queued[] = [{ mutationId: newMutationId(), src: 'alice', dst: 'bob', amount: 2500 }]
writeFileSync(OUTBOX, JSON.stringify(queued))

// 2. Send it, then "crash" before the outbox is cleared: the process no
//    longer knows whether the transfer went through.
await db.batch(transfer(queued[0]!), { mutationId: queued[0]!.mutationId })
await db.close()
console.log('crashed after sending; the outbox still holds the transfer')

// 3. On restart, replay the outbox with the stored ids.
db = await connect(url, { apiKey })
console.log('replaying the outbox:')
await flush(db)
console.log('after:         ', await balances(db))

// An overdraft changes nothing: the batch is all or nothing.
try {
  await db.batch(transfer({ mutationId: newMutationId(), src: 'carol', dst: 'alice', amount: 1_000_000 }))
} catch (e) {
  console.log(`overdraft refused: ${(e as Error).message}`)
}
console.log('still:         ', await balances(db))
await db.close()
