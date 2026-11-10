/**
 * File storage: upload, bind a file to a row, signed URLs, a resumable
 * upload with progress, and cleanup.
 *
 *   node --env-file=examples/.env examples/files.ts
 */
import { connectEnv } from '@azora-db/client'

// AZORA_URL and AZORA_TOKEN. File storage uses the same address: nothing else to configure.
const db = await connectEnv()

// Upload a file and reference it from a row: the FILE column holds the object's id.
const invoice = await db.storage.upload('Invoice 2026-0042\nStanding desk frame  129.90\n', {
  path: `invoices/2026-0042-${Date.now()}.txt`,
  contentType: 'text/plain',
})
const { lastInsertId } = await db.exec('INSERT INTO documents(title, file) VALUES (?, ?)', ['Invoice 2026-0042', invoice.id])
console.log(`stored ${invoice.name} (${invoice.size} bytes, sha256 ${invoice.sha256.slice(0, 12)}…) for document ${lastInsertId}`)

// A signed URL opens that one file, without credentials, until it expires.
const link = await db.storage.signUrl(invoice.id, { ttlSeconds: 300, download: true, filename: 'invoice.txt' })
const fetched = await fetch(link.url)
console.log(`signed link valid until ${link.expiresAt.toISOString()}: "${(await fetched.text()).split('\n')[0]}"`)

// SQL can sign too: one query returns rows with ready-to-use links.
const docs = await db.query<{ title: string; url: string }>('SELECT title, azora_url(file, 60) AS url FROM documents WHERE id = ?', [lastInsertId])
console.log(`from SQL: ${docs[0]?.title} -> ${docs[0]?.url.split('?')[0]}?…`)

// Large files go up in chunks; a failed chunk is retried from the server's offset.
const big = new Uint8Array(5 << 20).map((_, i) => i % 251)
const video = await db.storage.uploadResumable(big, {
  path: `media/demo-${Date.now()}.bin`,
  chunkSize: 1 << 20,
  onProgress: (sent, total) => process.stdout.write(`\r  uploading ${Math.round((sent / total) * 100)}%`),
})
console.log(`\nstored ${video.path} (${video.size} bytes)`)

// Ranged download: the last 16 bytes.
const tail = new Uint8Array(await (await db.storage.download(video.id, { range: [video.size - 16] })).arrayBuffer())
console.log(`last bytes match: ${tail.every((b, i) => b === big[big.length - 16 + i])}`)

let n = 0
for await (const o of db.storage.listAll({ prefix: 'media/' })) n++, void o
console.log(`${n} object(s) under media/`)

await db.storage.delete(video.id)
// The invoice is referenced by a row: deleting it needs force (which clears the reference).
await db.storage.delete(invoice.id).catch((e: Error) => console.log(`delete refused: ${e.message}`))
await db.storage.delete(invoice.id, { force: true })
console.log(`document file is now ${await db.queryValue('SELECT file FROM documents WHERE id = ?', [lastInsertId])}`)
await db.close()
