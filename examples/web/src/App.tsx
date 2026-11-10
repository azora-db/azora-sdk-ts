import { sql } from '@azora-db/client'
import { useAzora, useConnected, useLiveQuery, useQuery } from '@azora-db/client/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

interface Order {
  id: number
  customer: number
  status: string
  total: number
  note: string | null
  created_at: string
}

const STAGES = [
  { status: 'open', title: 'Open', next: 'paid', action: 'Mark paid' },
  { status: 'paid', title: 'Paid', next: 'shipped', action: 'Ship' },
  { status: 'shipped', title: 'Shipped', next: null, action: null },
] as const

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function App() {
  const db = useAzora()
  const connected = useConnected()
  // Every row of `orders`, kept current by the engine: no polling, no refetching.
  const { rows, ready, error } = useLiveQuery<Order>('orders', { orderBy: ['id', 'desc'] })
  // An aggregate the server computes, run again whenever `orders` is written.
  const totals = useQuery<{ status: string; n: number; sum: number }>(
    'SELECT status, count(*) AS n, coalesce(sum(total), 0) AS sum FROM orders GROUP BY status',
    [],
    { watch: ['orders'] },
  )
  const [failure, setFailure] = useState<string | null>(null)
  const fresh = useFresh(rows)

  const run = (p: Promise<unknown>): void => {
    setFailure(null)
    p.catch((e: Error) => setFailure(e.message))
  }
  const advance = (o: Order, to: string): void => run(db.exec(sql`UPDATE orders SET status = ${to} WHERE id = ${o.id}`))
  const remove = (o: Order): void => run(db.exec(sql`DELETE FROM orders WHERE id = ${o.id}`))

  return (
    <main className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">Azora live query example</p>
          <h1>Orders board</h1>
        </div>
        <p className={`status ${connected ? 'is-up' : 'is-down'}`} role="status">
          <span className="dot" aria-hidden="true" />
          {connected ? `Live as ${db.session?.principal ?? '…'}` : 'Reconnecting…'}
        </p>
      </header>

      <NewOrder onSubmit={(o) => run(db.exec(sql`INSERT INTO orders(customer, status, total, note) VALUES (${o.customer}, 'open', ${o.total}, ${o.note})`))} />

      {(failure ?? error?.message) && (
        <p className="notice is-bad" role="alert">
          {failure ?? error?.message}
        </p>
      )}

      <div className="board">
        {STAGES.map((stage) => {
          const orders = rows.filter((o) => o.status === stage.status)
          const total = totals.rows?.find((t) => t.status === stage.status)
          return (
            <section key={stage.status} className="column" aria-labelledby={`col-${stage.status}`}>
              <header className="column-head">
                <h2 id={`col-${stage.status}`}>{stage.title}</h2>
                <p className="column-total">
                  <span className="count">{total?.n ?? 0}</span>
                  <span className="sum">{money.format(total?.sum ?? 0)}</span>
                </p>
              </header>
              {!ready ? (
                <ul className="cards" aria-hidden="true">
                  <li className="card is-skeleton" />
                  <li className="card is-skeleton" />
                </ul>
              ) : orders.length === 0 ? (
                <p className="empty">No {stage.title.toLowerCase()} orders. {stage.status === 'open' ? 'Add one above.' : 'They arrive here as they move along.'}</p>
              ) : (
                <ul className="cards">
                  {orders.map((o) => (
                    <li key={o.id} className={`card${fresh.has(o.id) ? ' is-fresh' : ''}`}>
                      <div className="card-main">
                        <p className="card-note">{o.note || 'Untitled order'}</p>
                        <p className="card-meta">
                          <span className="mono">#{o.id}</span> · customer {o.customer}
                        </p>
                      </div>
                      <p className="card-total">{money.format(o.total)}</p>
                      <div className="card-actions">
                        {stage.next && (
                          <button type="button" className="button" onClick={() => advance(o, stage.next)} disabled={!connected}>
                            {stage.action}
                          </button>
                        )}
                        <button type="button" className="button is-quiet" onClick={() => remove(o)} disabled={!connected} aria-label={`Delete order ${o.id}`}>
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <p className="foot">
        Open this page in a second window, or run <code>node --env-file=examples/.env examples/live-orders.ts</code>: every change shows up
        here as it commits.
      </p>
    </main>
  )
}

/** The ids that appeared since the previous render pass (for the enter animation). */
function useFresh(rows: readonly Order[]): Set<number> {
  const seen = useRef<Set<number> | null>(null)
  const [fresh, setFresh] = useState<Set<number>>(new Set())
  useEffect(() => {
    const ids = new Set(rows.map((o) => o.id))
    if (seen.current) {
      const added = [...ids].filter((id) => !seen.current!.has(id))
      if (added.length > 0) {
        setFresh(new Set(added))
        const t = setTimeout(() => setFresh(new Set()), 900)
        seen.current = ids
        return () => clearTimeout(t)
      }
    }
    if (rows.length > 0 || seen.current) seen.current = ids
    return undefined
  }, [rows])
  return fresh
}

function NewOrder(props: { onSubmit: (o: { customer: number; total: number; note: string }) => void }) {
  const [note, setNote] = useState('')
  const [total, setTotal] = useState('')
  const [customer, setCustomer] = useState('42')
  const amount = Number(total)
  const valid = note.trim() !== '' && total !== '' && Number.isFinite(amount) && amount >= 0 && /^\d+$/.test(customer)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!valid) return
    props.onSubmit({ customer: Number(customer), total: amount, note: note.trim() })
    setNote('')
    setTotal('')
  }

  return (
    <form className="new" onSubmit={submit}>
      <label className="field is-wide">
        <span>Item</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Standing desk frame" maxLength={120} />
      </label>
      <label className="field">
        <span>Total</span>
        <input value={total} onChange={(e) => setTotal(e.target.value)} placeholder="129.90" inputMode="decimal" />
      </label>
      <label className="field">
        <span>Customer</span>
        <input value={customer} onChange={(e) => setCustomer(e.target.value)} inputMode="numeric" />
      </label>
      <button type="submit" className="button is-primary" disabled={!valid}>
        Add order
      </button>
    </form>
  )
}
