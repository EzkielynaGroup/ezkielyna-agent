import { describe, expect, test } from "bun:test"
import { routerGuards, StreamStalledError, watchStream } from "../../src/ezk/speed/watchdog"

async function* ticks(n: number, gapMs: number) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, gapMs))
    yield i
  }
}
const hang = (): AsyncIterable<number> => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}), return: () => new Promise<never>(() => {}) }) })
const collect = async (it: AsyncIterable<number>) => {
  const out: number[] = []
  for await (const x of it) out.push(x)
  return out
}

describe("watchStream", () => {
  test("healthy stream passes through", async () => {
    expect(await collect(watchStream(ticks(3, 5), { firstMs: 200, idleMs: 200 }))).toEqual([0, 1, 2])
  })
  test("no first event -> first-timeout, aborts, retryable message", async () => {
    let stalled: StreamStalledError | undefined
    const t0 = Date.now()
    const err = await collect(watchStream(hang(), { firstMs: 60, idleMs: 500, onStall: (e) => (stalled = e) })).catch((e) => e)
    expect(err).toBeInstanceOf(StreamStalledError)
    expect(err.kind).toBe("first")
    expect(stalled).toBe(err)
    expect(Date.now() - t0).toBeLessThan(400)
    expect(err.message).toMatch(/timed out/i)
  })
  test("idle after first event -> idle-timeout", async () => {
    async function* gen() {
      yield 1
      await new Promise(() => {})
    }
    const seen: number[] = []
    const err = await (async () => {
      try {
        for await (const x of watchStream(gen(), { firstMs: 500, idleMs: 60 })) seen.push(x)
      } catch (e) {
        return e as StreamStalledError
      }
    })()
    expect(seen).toEqual([1])
    expect(err?.kind).toBe("idle")
  })
  test("slow first event inside the limit is fine; preamble does not end the first window", async () => {
    async function* gen() {
      yield "start"
      await new Promise((r) => setTimeout(r, 100))
      yield "real"
    }
    const out: string[] = []
    for await (const x of watchStream(gen() as AsyncIterable<string>, { firstMs: 300, idleMs: 30, preamble: (e) => e === "start" })) out.push(x)
    expect(out).toEqual(["start", "real"])
  })
  test("disabled = pure pass-through", async () => {
    expect(await collect(watchStream(ticks(2, 80), { firstMs: 1, idleMs: 1, disabled: true }))).toEqual([0, 1])
  })
  test("router guard header detection", () => {
    expect(routerGuards({ "X-Ezk-Session": "ses_1" })).toBe(true)
    expect(routerGuards({ "x-ezk-session": "" })).toBe(false)
    expect(routerGuards({ authorization: "x" })).toBe(false)
    expect(routerGuards(undefined)).toBe(false)
  })
})
