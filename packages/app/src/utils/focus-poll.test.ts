import { expect, test } from "bun:test"
import { createFocusPoll, focusPollInterval, type FocusPollTarget } from "./focus-poll"

test("focus polling uses the active cadence only while the window is focused", () => {
  expect(focusPollInterval(true, 20_000, 120_000)).toBe(20_000)
  expect(focusPollInterval(false, 20_000, 120_000)).toBe(120_000)
})

test("focus changes replace the timer and refresh once on return", () => {
  let visible = false
  let hasFocus = false
  let nextID = 0
  let calls = 0
  const intervals = new Map<number, { callback: () => void; delay: number }>()
  const listeners = new Map<string, Set<() => void>>()
  const add = (type: string, callback: () => void) => {
    const set = listeners.get(type) ?? new Set()
    set.add(callback)
    listeners.set(type, set)
  }
  const remove = (type: string, callback: () => void) => listeners.get(type)?.delete(callback)
  const emit = (type: string) => listeners.get(type)?.forEach((callback) => callback())
  const target: FocusPollTarget = {
    window: {
      setInterval: (callback, delay) => {
        const id = ++nextID
        intervals.set(id, { callback, delay })
        return id
      },
      clearInterval: (id) => intervals.delete(id),
      addEventListener: add,
      removeEventListener: remove,
    },
    document: {
      get visibilityState() {
        return visible ? "visible" : "hidden"
      },
      hasFocus: () => hasFocus,
      addEventListener: add,
      removeEventListener: remove,
    },
  }

  const stop = createFocusPoll(() => calls++, 20_000, 120_000, target)
  expect([...intervals.values()].map((item) => item.delay)).toEqual([120_000])
  ;[...intervals.values()][0]?.callback()
  expect(calls).toBe(0)
  visible = true
  hasFocus = true
  emit("visibilitychange")
  expect([...intervals.values()].map((item) => item.delay)).toEqual([20_000])
  expect(calls).toBe(1)
  ;[...intervals.values()][0]?.callback()
  expect(calls).toBe(2)
  visible = false
  hasFocus = false
  emit("blur")
  expect([...intervals.values()].map((item) => item.delay)).toEqual([120_000])
  ;[...intervals.values()][0]?.callback()
  expect(calls).toBe(2)
  stop()
  expect(intervals.size).toBe(0)
})
