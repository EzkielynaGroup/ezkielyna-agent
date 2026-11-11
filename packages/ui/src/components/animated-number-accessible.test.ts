import { describe, expect, test } from "bun:test"
import { animatedNumberAccessibility } from "./animated-number-accessible"

describe("animated number accessible presentation", () => {
  test("formats one real value and marks the animated display decorative", () => {
    expect(animatedNumberAccessibility(9)).toEqual({ value: 9, text: "9", hideVisual: true })
    expect(animatedNumberAccessibility(1234.6)).toEqual({ value: 1235, text: "1235", hideVisual: true })
  })

  test("uses a safe zero for non-finite or negative inputs", () => {
    expect(animatedNumberAccessibility(Number.NaN)).toEqual({ value: 0, text: "0", hideVisual: true })
    expect(animatedNumberAccessibility(-3)).toEqual({ value: 0, text: "0", hideVisual: true })
  })
})
