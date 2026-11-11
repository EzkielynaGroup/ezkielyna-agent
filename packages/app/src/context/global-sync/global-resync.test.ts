import { describe, expect, test } from "bun:test"
import { configPatchChanges } from "./config-patch"
import { createGlobalResync } from "./global-resync"

function fakeTimers() {
  let next = 0
  const callbacks = new Map<number, () => void>()
  return {
    schedule(callback: () => void) {
      const id = next++
      callbacks.set(id, callback)
      return id
    },
    cancel(id: unknown) {
      callbacks.delete(id as number)
    },
    get size() {
      return callbacks.size
    },
    fire() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback())
    },
  }
}

describe("global disposal resync", () => {
  test("debounces disposal echoes and never writes config from the event path", async () => {
    const timers = fakeTimers()
    const config = { shell: "bash" }
    let writes = 0
    let refreshes = 0
    const resync = createGlobalResync({
      delay: 300,
      schedule: timers.schedule,
      cancel: timers.cancel,
      refresh: () => {
        refreshes++
      },
    })
    const mockServer = {
      async update(patch: Partial<typeof config>) {
        if (!configPatchChanges(config, patch)) return false
        Object.assign(config, patch)
        writes++
        onEvent("global.disposed")
        return true
      },
    }
    const onEvent = (type: "global.disposed") => {
      if (type === "global.disposed") resync.trigger({ disposed: true })
    }

    for (let index = 0; index < 20; index++) {
      expect(await mockServer.update({ shell: `shell-${index}` })).toBe(true)
    }
    expect(writes).toBe(20)
    timers.fire()
    await Promise.resolve()
    await Promise.resolve()

    expect(refreshes).toBe(1)
    expect(await mockServer.update({ shell: "shell-19" })).toBe(false)
    expect(writes).toBe(20)
    expect(refreshes).toBe(1)
    expect(timers.size).toBe(0)
    resync.dispose()
  })

  test("runs one refetch at a time and preserves one trailing dispose refresh", async () => {
    const timers = fakeTimers()
    const releases: Array<() => void> = []
    const states: boolean[] = []
    let active = 0
    let maximumActive = 0
    const resync = createGlobalResync({
      schedule: timers.schedule,
      cancel: timers.cancel,
      refresh: ({ disposed }) => {
        states.push(disposed)
        active++
        maximumActive = Math.max(maximumActive, active)
        return new Promise<void>((resolve) => {
          releases.push(() => {
            active--
            resolve()
          })
        })
      },
    })

    resync.trigger()
    resync.trigger({ disposed: true })
    timers.fire()
    expect(states).toEqual([true])

    resync.trigger()
    timers.fire()
    expect(states).toEqual([true])
    releases[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(states).toEqual([true, false])
    expect(maximumActive).toBe(1)

    releases[1]()
    await Promise.resolve()
    await Promise.resolve()
    expect(active).toBe(0)
    resync.dispose()
  })
})

describe("config patch equality", () => {
  test("ignores object key order and empty patches", () => {
    expect(
      configPatchChanges(
        { provider: { custom: { models: { a: {}, b: {} } } } },
        { provider: { custom: { models: { b: {}, a: {} } } } },
      ),
    ).toBe(false)
    expect(configPatchChanges({ shell: "zsh" }, {})).toBe(false)
    expect(configPatchChanges({ shell: "zsh" }, { shell: "bash" })).toBe(true)
  })
})
