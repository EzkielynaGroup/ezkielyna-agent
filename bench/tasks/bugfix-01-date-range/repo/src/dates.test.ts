import { expect, test } from "bun:test"
import { daysInRange, nightsBetween } from "./dates"

test("counts both ends of the range", () => {
  expect(daysInRange("2026-03-02", "2026-03-04")).toBe(3)
  expect(daysInRange("2026-03-02", "2026-03-02")).toBe(1)
})

test("hotel nights", () => {
  expect(nightsBetween("2026-03-02", "2026-03-05")).toBe(3)
})

test("rejects a reversed range", () => {
  expect(() => daysInRange("2026-03-05", "2026-03-02")).toThrow()
})
