import { describe, expect, test } from "bun:test"
import { createUnresponsiveRecovery, type RecoveryAction } from "./unresponsive-recovery"

function fakeTimers() {
  const callbacks = new Map<number, () => void>()
  let next = 0
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

async function settle() {
  for (let index = 0; index < 40; index++) await Promise.resolve()
}

describe("unresponsive renderer recovery", () => {
  test("waits for the timeout and cancels recovery if the renderer responds", async () => {
    const timers = fakeTimers()
    let dialogs = 0
    let reloads = 0
    const recovery = createUnresponsiveRecovery({
      schedule: timers.schedule,
      cancel: timers.cancel,
      show: async () => {
        dialogs++
        return "reload"
      },
      reload: () => reloads++,
    })

    recovery.unresponsive()
    recovery.responsive()
    timers.fire()
    await Promise.resolve()
    expect(dialogs).toBe(0)
    expect(reloads).toBe(0)
    expect(timers.size).toBe(0)
    recovery.dispose()
  })

  test("shows one native decision after the timeout and reloads only by request", async () => {
    const timers = fakeTimers()
    let dialogs = 0
    let reloads = 0
    let resolveDialog!: (action: RecoveryAction) => void
    const recovery = createUnresponsiveRecovery({
      schedule: timers.schedule,
      cancel: timers.cancel,
      show: () => {
        dialogs++
        return new Promise((resolve) => {
          resolveDialog = resolve
        })
      },
      reload: () => reloads++,
    })

    recovery.unresponsive()
    recovery.unresponsive()
    expect(dialogs).toBe(0)
    timers.fire()
    await Promise.resolve()
    expect(dialogs).toBe(1)
    expect(reloads).toBe(0)
    resolveDialog("wait")
    await settle()
    expect(reloads).toBe(0)

    recovery.responsive()
    recovery.unresponsive()
    timers.fire()
    await Promise.resolve()
    expect(dialogs).toBe(2)
    resolveDialog("reload")
    await settle()
    expect(reloads).toBe(1)
    recovery.dispose()
  })

  function harness(answers: RecoveryAction[]) {
    const timers = fakeTimers()
    const log: string[] = []
    const queue = [...answers]
    const recovery = createUnresponsiveRecovery({
      schedule: timers.schedule,
      cancel: timers.cancel,
      show: async () => {
        log.push("dialog")
        return queue.shift() ?? "wait"
      },
      reload: () => log.push("reload"),
      relaunch: () => log.push("relaunch"),
      quit: () => log.push("quit"),
      exportLogs: async () => void log.push("export"),
    })
    return { timers, log, recovery }
  }

  test("offers Relaunch and Quit next to Reload, and honours them", async () => {
    for (const action of ["relaunch", "quit"] as const) {
      const { timers, log, recovery } = harness([action])
      recovery.unresponsive()
      timers.fire()
      await settle()
      expect(log).toEqual(["dialog", action])
      recovery.dispose()
    }
  })

  test("Export logs asks again afterwards, so the user can still reload, relaunch or quit", async () => {
    const { timers, log, recovery } = harness(["export-logs", "reload"])
    recovery.unresponsive()
    timers.fire()
    await settle()
    expect(log).toEqual(["dialog", "export", "dialog", "reload"])
    recovery.dispose()
  })

  test("Wait is not final: the question comes back while the renderer is still stuck, and stops when it recovers", async () => {
    const { timers, log, recovery } = harness(["wait", "wait", "relaunch"])
    recovery.unresponsive()
    timers.fire()
    await settle()
    expect(timers.size).toBe(1) // re-armed
    timers.fire()
    await settle()
    expect(timers.size).toBe(1)
    timers.fire()
    await settle()
    expect(log).toEqual(["dialog", "dialog", "dialog", "relaunch"])

    const second = harness(["wait"])
    second.recovery.unresponsive()
    second.timers.fire()
    await settle()
    second.recovery.responsive() // recovered while waiting
    expect(second.timers.size).toBe(0)
    second.recovery.dispose()
  })

  test("a Reload answered after the renderer recovered is ignored; Quit and Relaunch are still honoured", async () => {
    const timers = fakeTimers()
    const log: string[] = []
    let answer!: (action: RecoveryAction) => void
    const recovery = createUnresponsiveRecovery({
      schedule: timers.schedule,
      cancel: timers.cancel,
      show: () => new Promise((resolve) => (answer = resolve)),
      reload: () => log.push("reload"),
      quit: () => log.push("quit"),
    })
    recovery.unresponsive()
    timers.fire()
    await settle()
    recovery.responsive()
    answer("reload")
    await settle()
    expect(log).toEqual([])

    recovery.unresponsive()
    timers.fire()
    await settle()
    recovery.responsive()
    answer("quit")
    await settle()
    expect(log).toEqual(["quit"])
    recovery.dispose()
  })

  test("a dialog that throws is retried later instead of leaving the window without recovery", async () => {
    const timers = fakeTimers()
    let calls = 0
    const recovery = createUnresponsiveRecovery({
      schedule: timers.schedule,
      cancel: timers.cancel,
      show: async () => {
        calls++
        throw new Error("window destroyed")
      },
      reload: () => {},
    })
    recovery.unresponsive()
    timers.fire()
    await settle()
    expect(calls).toBe(1)
    expect(timers.size).toBe(1)
    recovery.dispose()
  })
})
