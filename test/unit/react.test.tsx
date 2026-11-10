// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { connect, type Database } from '../../src/index.ts'
import { MsgType, Op, type Msg } from '../../src/messages.ts'
import { AzoraProvider, useConnected, useLiveQuery, useQuery } from '../../src/react.ts'
import { FakeServer } from '../helpers/fake-server.ts'
import { until } from '../helpers/wait.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Task {
  id: number
  title: string
}

let server: FakeServer
let db: Database
let root: Root
let host: HTMLElement
let queries = 0
let subs: Array<Extract<Msg, { type: typeof MsgType.Subscribe }>>

beforeEach(async () => {
  server = new FakeServer()
  subs = []
  queries = 0
  server.onMessage = (m, c) => {
    if (m.type === MsgType.Subscribe) {
      subs.push(m)
      c.send({ type: MsgType.Shape, table: 'tasks', tv: 1, columns: ['id', 'title'], pk: ['id'] })
      c.send({ type: MsgType.Subscribed, reqId: m.reqId, subId: m.subId })
      if (m.kind === 2) {
        c.send({
          type: MsgType.Batch, subId: m.subId, snapshot: true, reset: true, checkpoint: 5, epoch: 1n, tables: [],
          changes: [{ seq: 0, table: 'tasks', tv: 1, op: Op.Insert, key: [1], new: [1, 'write tests'], old: null }],
        })
      }
    } else if (m.type === MsgType.Query) {
      queries++
      c.send({ type: MsgType.Result, reqId: m.reqId, columns: ['n'], rows: [[queries]], truncated: false, rowsAffected: 0, lastInsertId: 0, replayed: false })
    }
  }
  db = await connect({ database: 'app', allowPlaintext: true, apiKey: 'k', transport: server.transport, reconnectMinMs: 1, reconnectMaxMs: 5, onError: () => {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  await db.close()
})

function Tasks(props: { filter?: string }) {
  const { rows, ready, error } = useLiveQuery<Task>('tasks', props.filter ? { where: props.filter } : {})
  const count = useQuery<{ n: number }>('SELECT count(*) AS n FROM tasks', [], { watch: ['tasks'] })
  const connected = useConnected(20)
  if (error) return <p>error: {error.message}</p>
  return (
    <div>
      <p data-testid="state">{ready ? 'ready' : 'loading'} {connected ? 'online' : 'offline'} runs={count.rows?.[0]?.n ?? '-'}</p>
      <ul>{rows.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
    </div>
  )
}

const render = (ui: React.ReactNode): Promise<void> => act(async () => root.render(<StrictMode><AzoraProvider db={db}>{ui}</AzoraProvider></StrictMode>))
const items = (): string[] => [...host.querySelectorAll('li')].map((li) => li.textContent ?? '')
const state = (): string => host.querySelector('[data-testid=state]')?.textContent ?? ''

test('hooks render live rows and follow changes, watches and reconnects', async () => {
  await render(<Tasks />)
  await act(() => until(() => items().length === 1 && /runs=\d/.test(state()), 'the first render with data'))
  expect(items()).toEqual(['write tests'])
  expect(state()).toMatch(/^ready online/)

  // A committed change arrives: the list re-renders.
  const live = subs.filter((s) => s.kind === 2).at(-1)!
  await act(async () => {
    server.last.send({
      type: MsgType.Batch, subId: live.subId, snapshot: false, reset: false, checkpoint: 7, epoch: 1n, tables: [],
      changes: [
        { seq: 6, table: 'tasks', tv: 1, op: Op.Insert, key: [2], new: [2, 'ship it'], old: null },
        { seq: 7, table: 'tasks', tv: 1, op: Op.Update, key: [1], new: [1, 'write more tests'], old: null },
      ],
    })
    await until(() => items().length === 2, 'the second row')
  })
  expect(items()).toEqual(['write more tests', 'ship it'])

  // A watched table was written: useQuery runs again.
  const before = queries
  const watch = subs.filter((s) => s.kind === 5).at(-1)!
  await act(async () => {
    server.last.send({ type: MsgType.Batch, subId: watch.subId, snapshot: false, reset: false, checkpoint: 8, epoch: 0n, tables: ['tasks'], changes: [] })
    await until(() => queries > before, 'the query to run again')
  })
  expect(state()).toContain(`runs=${queries}`) // state updates are flushed when act returns

  // Changing the filter replaces the subscription.
  const opened = subs.filter((s) => s.kind === 2).length
  await render(<Tasks filter="id = 1" />)
  await act(() => until(() => subs.filter((s) => s.kind === 2).length > opened && items().length === 1, 'the new subscription'))
  expect(subs.at(-1)?.where).toMatchObject({ op: '=', col: 'id', val: 1 })
  await until(() => server.last.received.some((m) => m.type === MsgType.Unsubscribe), 'the old subscription to end')
})

test('hooks need a provider, and report a failing query', async () => {
  server.onMessage = (m, c) => m.type === MsgType.Subscribe && c.send({ type: MsgType.Error, reqId: m.reqId, code: 'permission_denied', message: 'not for you', fatal: false, retryAfterMs: 0 })
  function Denied() {
    const { error, ready } = useLiveQuery('secret')
    return <p>{error ? `error: ${error.message}` : ready ? 'ready' : 'loading'}</p>
  }
  await render(<Denied />)
  await act(() => until(() => host.textContent?.startsWith('error') ?? false, 'the error'))
  expect(host.textContent).toBe('error: permission_denied: not for you')

  const quiet = console.error
  console.error = () => {}
  const bare = createRoot(document.createElement('div'))
  await expect(act(async () => bare.render(<Denied />))).rejects.toThrow(/AzoraProvider/)
  console.error = quiet
})
