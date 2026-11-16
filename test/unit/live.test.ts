import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ClosedError, RetryVerifyError } from '../../src/errors.ts'
import { LiveQuery, type LiveOptions } from '../../src/live.ts'
import type { Subscription } from '../../src/subscription.ts'
import type { Change, Row, Update, VerifyResult } from '../../src/types.ts'

type Local = () => { rows: number; sum: bigint }

/** A subscription whose updates and verify answers the test hands out. */
class FakeSub {
  closed = false
  resyncs = 0
  /** The checks waiting for an answer, oldest first. */
  checks: Array<{ local: Local; resolve: (r: VerifyResult) => void; reject: (e: Error) => void }> = []
  verifyCalls = 0
  private queue: Update[] = []
  private waiter: { resolve: (u: Update) => void; reject: (e: Error) => void } | null = null

  push(u: Update): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve(u)
    } else this.queue.push(u)
  }

  next(): Promise<Update> {
    if (this.closed) return Promise.reject(new ClosedError())
    const u = this.queue.shift()
    if (u) return Promise.resolve(u)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  verify(local: Local): Promise<VerifyResult> {
    this.verifyCalls++
    return new Promise((resolve, reject) => this.checks.push({ local, resolve, reject }))
  }

  /** Answers the oldest waiting check the way the server would for sum. */
  answer(serverRows: number, serverSum?: bigint): VerifyResult {
    const c = this.checks.shift()
    if (!c) throw new Error('no check is waiting')
    const l = c.local()
    const sum = BigInt.asUintN(64, l.sum)
    const res: VerifyResult = {
      match: false,
      checkpoint: 1,
      epoch: 1n,
      serverRows,
      serverSum: serverSum ?? sum,
      localRows: l.rows,
      localSum: sum,
    }
    res.match = res.localRows === res.serverRows && res.localSum === res.serverSum
    c.resolve(res)
    return res
  }

  fail(e: Error): void {
    const c = this.checks.shift()
    if (!c) throw new Error('no check is waiting')
    c.reject(e)
  }

  resync(): void {
    this.resyncs++
  }

  async close(): Promise<void> {
    this.closed = true
    this.waiter?.reject(new ClosedError())
    this.waiter = null
  }
}

function change(id: number, v: string): Change {
  return {
    op: 'insert',
    table: 't',
    key: [id],
    columns: ['id', 'v'],
    pk: ['id'],
    new: [id, v],
    seq: 0,
  } as unknown as Change
}

function update(reset: boolean, ...changes: Change[]): Update {
  return { reset, snapshot: reset, changes, checkpoint: 1, epoch: 1n } as unknown as Update
}

async function open(o: LiveOptions<Row>): Promise<{ sub: FakeSub; live: LiveQuery }> {
  const sub = new FakeSub()
  const live = new LiveQuery(sub as unknown as Subscription, 't', o)
  sub.push(update(true, change(1, 'a'), change(2, 'b')))
  await live.ready
  return { sub, live }
}

describe('LiveQuery verifyEvery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('off by default and with 0', async () => {
    for (const o of [{}, { verifyEvery: 0 }]) {
      const { sub, live } = await open(o)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sub.verifyCalls).toBe(0)
      expect(live.lastVerify).toBeNull()
      await live.close()
    }
  })

  test('verifies on the interval and reports each result', async () => {
    const seen: VerifyResult[] = []
    const { sub, live } = await open({ verifyEvery: 1000, onVerify: (r) => seen.push(r) })
    await vi.advanceTimersByTimeAsync(999)
    expect(sub.verifyCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sub.verifyCalls).toBe(1)
    const first = sub.answer(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([first])
    expect(first.match).toBe(true)
    expect(first.localSum).not.toBe(0n)
    expect(live.lastVerify).toBe(first)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sub.verifyCalls).toBe(2)
    sub.answer(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(2)
    expect(live.mismatches).toBe(0)
    expect(sub.resyncs).toBe(0)
    await live.close()
  })

  test('waits for the first snapshot', async () => {
    const sub = new FakeSub()
    const live = new LiveQuery(sub as unknown as Subscription, 't', { verifyEvery: 100 })
    await vi.advanceTimersByTimeAsync(350)
    expect(sub.verifyCalls).toBe(0)
    sub.push(update(true, change(1, 'a')))
    await live.ready
    await vi.advanceTimersByTimeAsync(100)
    expect(sub.verifyCalls).toBe(1)
    await live.close()
  })

  test('checks do not overlap', async () => {
    const { sub, live } = await open({ verifyEvery: 100 })
    await vi.advanceTimersByTimeAsync(550) // the first check never answers (connection down)
    expect(sub.verifyCalls).toBe(1)
    sub.answer(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(sub.verifyCalls).toBe(2)
    await live.close()
  })

  test('stops on close', async () => {
    const seen: VerifyResult[] = []
    const { sub, live } = await open({ verifyEvery: 100, onVerify: (r) => seen.push(r) })
    await vi.advanceTimersByTimeAsync(100)
    expect(sub.verifyCalls).toBe(1)
    await live.close()
    expect(vi.getTimerCount()).toBe(0)
    sub.answer(0) // a late answer is not reported and does not resync
    await vi.advanceTimersByTimeAsync(1000)
    expect(sub.verifyCalls).toBe(1)
    expect(seen).toEqual([])
    expect(sub.resyncs).toBe(0)
  })

  test('stops when the subscription fails', async () => {
    const { sub, live } = await open({ verifyEvery: 100 })
    const failed = new Error('table dropped')
    sub.next = () => Promise.reject(failed)
    sub.push(update(false))
    await vi.advanceTimersByTimeAsync(0)
    expect(live.error).toBe(failed)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('RetryVerifyError: again at the next tick, without reporting', async () => {
    const seen: VerifyResult[] = []
    const { sub, live } = await open({ verifyEvery: 100, onVerify: (r) => seen.push(r) })
    await vi.advanceTimersByTimeAsync(100)
    sub.fail(new RetryVerifyError())
    await vi.advanceTimersByTimeAsync(99)
    expect(sub.verifyCalls).toBe(1)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sub.verifyCalls).toBe(2)
    sub.answer(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(1)
    expect(sub.resyncs).toBe(0)
    await live.close()
  })

  test('RetryVerifyError: again right after the next update', async () => {
    const { sub, live } = await open({ verifyEvery: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    sub.fail(new RetryVerifyError())
    await vi.advanceTimersByTimeAsync(10)
    sub.push(update(false, change(3, 'c')))
    await vi.advanceTimersByTimeAsync(0)
    expect(sub.verifyCalls).toBe(2)
    expect(sub.answer(3).match).toBe(true)
    await live.close()
  })

  test('other verify errors are dropped and the next tick checks again', async () => {
    const { sub, live } = await open({ verifyEvery: 100 })
    await vi.advanceTimersByTimeAsync(100)
    sub.fail(new Error('timeout'))
    sub.push(update(false, change(3, 'c'))) // no retry on an update
    await vi.advanceTimersByTimeAsync(50)
    expect(sub.verifyCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(sub.verifyCalls).toBe(2)
    await live.close()
  })

  test('a mismatch is reported, then the query resyncs and converges', async () => {
    const seen: VerifyResult[] = []
    const order: string[] = []
    const { sub, live } = await open({
      verifyEvery: 100,
      onVerify: (r) => {
        seen.push(r)
        order.push(`verify ${r.match} resyncs=${sub.resyncs}`)
      },
    })
    const events: boolean[] = []
    live.subscribe((ev) => events.push(ev.reset))
    await vi.advanceTimersByTimeAsync(100)
    sub.answer(3, 12345n) // the server has a row the query missed
    await vi.advanceTimersByTimeAsync(0)
    expect(seen[0]?.match).toBe(false)
    expect(order).toEqual(['verify false resyncs=0']) // reported before the resync
    expect(sub.resyncs).toBe(1)
    expect(live.mismatches).toBe(1)
    // The new snapshot replaces the rows.
    sub.push(update(true, change(1, 'a'), change(2, 'b'), change(3, 'c')))
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([true])
    expect(live.rows).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(100)
    sub.answer(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen[1]?.match).toBe(true)
    expect(live.lastVerify?.match).toBe(true)
    expect(sub.resyncs).toBe(1)
    expect(live.mismatches).toBe(1)
    await live.close()
  })
})
