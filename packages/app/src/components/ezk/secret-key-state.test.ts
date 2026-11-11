import { createRoot } from "solid-js"
import { describe, expect, test } from "bun:test"
import { createSecretKeyState } from "./secret-key-state"

describe("secret key entry state", () => {
  test("starts empty and clears after success or owner cleanup", () => {
    let state!: ReturnType<typeof createSecretKeyState>
    const dispose = createRoot((dispose) => {
      state = createSecretKeyState()
      return dispose
    })

    expect(state.value()).toBe("")
    state.setValue("sk-" + "test_clear-state")
    state.clear()
    expect(state.value()).toBe("")
    state.setValue("sk-" + "test_clear-state")
    dispose()
    expect(state.value()).toBe("")
  })
})
