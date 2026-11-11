// Mock-gateway hang test for the stream watchdog (real HTTP connection, short limits).
import { describe, expect, test } from "bun:test"
import { StreamStalledError, watchStream } from "@opencode-ai/core/ezk/speed/index"
import { SessionRetry } from "../../src/session/retry"
import { chatStream, startMockGateway } from "./mock-gateway"

async function run(script: Parameters<typeof startMockGateway>[0], opts: { firstMs: number; idleMs: number }) {
  const gw = startMockGateway(script)
  const ctrl = new AbortController()
  const t0 = Date.now()
  const seen: string[] = []
  let error: unknown
  try {
    for await (const ev of watchStream(chatStream(gw.url, ctrl.signal), { ...opts, onStall: () => ctrl.abort() })) seen.push(ev.choices?.[0]?.delta?.content ?? "")
  } catch (e) {
    error = e
  }
  const elapsed = Date.now() - t0
  const aborted = ctrl.signal.aborted
  gw.stop()
  return { error, elapsed, seen, aborted }
}

describe("watchdog against a hanging mock gateway", () => {
  test("never answers: aborts after the first-event limit with a retryable error", async () => {
    const r = await run([{ kind: "hang" }], { firstMs: 250, idleMs: 1000 })
    expect(r.error).toBeInstanceOf(StreamStalledError)
    expect((r.error as StreamStalledError).kind).toBe("first")
    expect(r.aborted).toBe(true)
    expect(r.elapsed).toBeGreaterThanOrEqual(240)
    expect(r.elapsed).toBeLessThan(1000)
    console.log(`watchdog first-event: limit 250 ms, aborted after ${r.elapsed} ms`)
    // the existing SessionRetry classifier treats it as retryable, so the normal retry / router fallback takes over
    const retry = SessionRetry.retryable({ name: "UnknownError", data: { message: (r.error as Error).message } } as any, "ezkielyna")
    expect(retry).toBeDefined()
  })
  test("one chunk then silence: aborts at the idle limit", async () => {
    const r = await run([{ kind: "stall" }], { firstMs: 1000, idleMs: 250 })
    expect((r.error as StreamStalledError).kind).toBe("idle")
    expect(r.seen).toEqual(["thinking"])
    expect(r.aborted).toBe(true)
    expect(r.elapsed).toBeLessThan(1000)
    console.log(`watchdog idle: limit 250 ms, aborted after ${r.elapsed} ms`)
    const retry = SessionRetry.retryable({ name: "UnknownError", data: { message: (r.error as Error).message } } as any, "ezkielyna")
    expect(retry).toBeDefined()
  })
  test("healthy answer is untouched", async () => {
    const r = await run([{ kind: "text", text: "hello" }], { firstMs: 250, idleMs: 250 })
    expect(r.error).toBeUndefined()
    expect(r.seen.join("")).toBe("hello")
  })
})
