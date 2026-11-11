import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { DisposeTimeoutError, makeDisposeCoordinator } from "../../src/server/dispose-coordinator"
import { configChangeNeedsDisposal } from "../../src/server/global-lifecycle"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("global instance disposal coordinator", () => {
  it.live("skips only known UI-only global config keys", () =>
    Effect.sync(() => {
      expect(configChangeNeedsDisposal(["$schema", "theme", "keybinds", "tui", "layout"])).toBe(false)
      expect(configChangeNeedsDisposal(["theme", "model"])).toBe(true)
    }),
  )

  it.live("coalesces a config update storm into one trailing dispose", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const firstFinished = yield* Deferred.make<void>()
      const calls: Array<{ callers: string[]; changedKeys: string[]; swallowErrors: boolean }> = []
      const dispose = makeDisposeCoordinator((request) =>
        Effect.gen(function* () {
          calls.push(request)
          if (calls.length === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            yield* Deferred.succeed(firstFinished, undefined)
          }
        }),
      )

      const first = yield* dispose({
        caller: "PATCH /global/config",
        changedKeys: ["model"],
        swallowErrors: true,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)

      const followers = yield* Effect.forEach(
        Array.from({ length: 18 }, (_, index) =>
          dispose({
            caller: "PATCH /global/config",
            changedKeys: [index % 2 === 0 ? "provider" : "model"],
            swallowErrors: true,
          }),
        ),
        (effect) => effect.pipe(Effect.forkScoped),
        { concurrency: "unbounded" },
      )

      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(firstFinished)
      yield* Effect.sleep(100)
      const lateFollower = yield* dispose({
        caller: "PATCH /global/config",
        changedKeys: ["model"],
        swallowErrors: true,
      }).pipe(Effect.forkScoped)
      yield* Fiber.join(first)
      yield* Effect.forEach(followers, Fiber.join, { discard: true })
      yield* Fiber.join(lateFollower)

      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual({
        callers: ["PATCH /global/config"],
        changedKeys: ["model", "provider"],
        swallowErrors: true,
      })
    }),
  )

  it.live("an isolated dispose runs immediately and its caller is not held for the quiet window", () =>
    Effect.gen(function* () {
      const dispose = makeDisposeCoordinator(() => Effect.void, 300)
      const started = Date.now()
      yield* dispose({ caller: "POST /global/dispose" })
      expect(Date.now() - started).toBeLessThan(100)
    }),
  )

  it.live("a change that arrives while the TRAILING dispose runs gets its own later dispose", () =>
    Effect.gen(function* () {
      const events: string[] = []
      const trailingStarted = yield* Deferred.make<void>()
      const trailingRelease = yield* Deferred.make<void>()
      const dispose = makeDisposeCoordinator(
        (request) =>
          Effect.gen(function* () {
            events.push(`run:${request.changedKeys.join(",")}`)
            if (events.length === 2) {
              yield* Deferred.succeed(trailingStarted, undefined)
              yield* Deferred.await(trailingRelease)
            }
          }),
        { debounceMs: 20 },
      )

      const a = yield* dispose({ caller: "A", changedKeys: ["provider"] }).pipe(Effect.forkScoped)
      const b = yield* dispose({ caller: "B", changedKeys: ["mcp"] }).pipe(Effect.forkScoped) // trailing batch
      yield* Deferred.await(trailingStarted)
      const c = yield* dispose({ caller: "C", changedKeys: ["permission"] }).pipe(Effect.forkScoped) // arrives DURING the trailing run
      yield* Deferred.succeed(trailingRelease, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      yield* Fiber.join(c)
      yield* Effect.sleep(200)

      expect(events).toEqual(["run:provider", "run:mcp", "run:permission"])
    }),
  )

  it.live("a request that arrives during the leading run is completed by a run that started AFTER it arrived", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const firstStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const dispose = makeDisposeCoordinator(
        (request) =>
          Effect.gen(function* () {
            order.push(`start:${request.callers.join(",")}`)
            if (order.length === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(release)
            }
            order.push(`end:${request.callers.join(",")}`)
          }),
        { debounceMs: 20 },
      )
      const first = yield* dispose({ caller: "first" }).pipe(Effect.forkScoped)
      yield* Deferred.await(firstStarted)
      const second = yield* dispose({ caller: "second" }).pipe(Effect.forkScoped)
      yield* Effect.sleep(20)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"])
    }),
  )

  it.live("a hung disposal times out, fails its waiters, and does not block later requests", () =>
    Effect.gen(function* () {
      let calls = 0
      const dispose = makeDisposeCoordinator(
        () =>
          Effect.gen(function* () {
            calls++
            if (calls === 1) yield* Effect.never
          }).pipe(Effect.uninterruptible),
        { debounceMs: 10, timeoutMs: 60 },
      )
      const hung = yield* Effect.exit(dispose({ caller: "hung" }))
      expect(Exit.isFailure(hung)).toBe(true)
      expect(String(hung)).toContain("DisposeTimeoutError")
      const started = Date.now()
      yield* Effect.sleep(50) // let the quiet window of the abandoned run close
      yield* dispose({ caller: "after" })
      expect(calls).toBe(2)
      expect(Date.now() - started).toBeLessThan(500)
      expect(new DisposeTimeoutError(60).timeoutMs).toBe(60)
    }),
  )

  it.live("a steady stream of requests cannot starve the trailing run (max wait)", () =>
    Effect.gen(function* () {
      const runs: number[] = []
      const start = Date.now()
      const dispose = makeDisposeCoordinator(() => Effect.sync(() => void runs.push(Date.now() - start)), { debounceMs: 40, maxWaitMs: 150 })
      yield* dispose({ caller: "lead" })
      const stream = yield* Effect.forEach(
        Array.from({ length: 12 }),
        () => dispose({ caller: "stream" }).pipe(Effect.forkScoped, Effect.andThen(Effect.sleep(20))),
        { discard: true },
      ).pipe(Effect.forkScoped)
      yield* Fiber.join(stream)
      yield* Effect.sleep(400)
      expect(runs.length).toBeGreaterThanOrEqual(2)
      expect(runs[1]!).toBeLessThan(500) // the trailing run happened while requests were still arriving, not after they stopped
    }),
  )
})
