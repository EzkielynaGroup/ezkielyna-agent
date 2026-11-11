import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GlobalBus } from "../../src/bus/global"
import { InstanceStore } from "../../src/project/instance-store"
import { configChangeNeedsDisposal, disposeAllInstancesAndEmitGlobalDisposed } from "../../src/server/global-lifecycle"
import { testEffect } from "../lib/effect"

// Beta blocker (22 Oct): PATCH /global/config produced 35 "disposing all instances" cycles. Twenty rapid config updates
// that each need a dispose must now cost at most two cycles (one immediate, one trailing), and UI-only updates none.
let disposeAllCalls = 0
const store = Layer.succeed(InstanceStore.Service, {
  disposeAll: () =>
    Effect.gen(function* () {
      disposeAllCalls++
      yield* Effect.sleep(40)
    }),
} as unknown as InstanceStore.Interface)
const it = testEffect(store)

describe("dispose storm e2e", () => {
  it.live("20 rapid global config updates cause at most 2 dispose cycles", () =>
    Effect.gen(function* () {
      disposeAllCalls = 0
      let disposedEvents = 0
      const listener = (event: { payload?: { type?: string } }) => {
        if (event.payload?.type === "global.disposed") disposedEvents++
      }
      GlobalBus.on("event", listener as never)
      try {
        const requests = Array.from({ length: 20 }, (_, i) => ({ keys: i % 3 === 0 ? ["provider"] : ["model"] }))
        yield* Effect.forEach(
          requests.filter((r) => configChangeNeedsDisposal(r.keys)),
          (r) =>
            disposeAllInstancesAndEmitGlobalDisposed({ caller: "PATCH /global/config", changedKeys: r.keys, swallowErrors: true }).pipe(
              Effect.forkChild,
              Effect.andThen(Effect.sleep(5)),
            ),
          { discard: true },
        )
        yield* Effect.sleep(1000)
        expect(disposeAllCalls).toBeGreaterThan(0)
        expect(disposeAllCalls).toBeLessThanOrEqual(2)
        expect(disposedEvents).toBe(disposeAllCalls)
      } finally {
        GlobalBus.off("event", listener as never)
      }
    }),
  )

  it.live("UI-only config updates never dispose", () =>
    Effect.sync(() => {
      expect(configChangeNeedsDisposal(["theme", "tui", "layout"])).toBe(false)
    }),
  )
})
