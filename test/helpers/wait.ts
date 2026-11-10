/** Polls cond until it is true; rejects with what() after timeoutMs. */
export async function until(cond: () => boolean | Promise<boolean>, what = 'condition', timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
