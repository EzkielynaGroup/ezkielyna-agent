import { expect, test } from "bun:test"
import { average, capitalize, clamp, sum, truncate } from "./utils"
import { report } from "./report"
import { profileCard } from "./profile"

test("helpers", () => {
  expect(capitalize("halo")).toBe("Halo")
  expect(truncate("abcdef", 4)).toBe("abc…")
  expect(sum([1, 2, 3])).toBe(6)
  expect(average([])).toBe(0)
  expect(clamp(15, 1, 10)).toBe(10)
  expect(report("nilai", [80, 90])).toBe("Nilai: total 170, avg 85.0")
  expect(profileCard("A", "x".repeat(30), 0)).toEqual({ name: "A", bio: `${"x".repeat(19)}…`, level: 1 })
})
