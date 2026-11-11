import { expect, test } from "bun:test"
import { capitalize, truncate } from "./strings"
import { average, clamp, sum } from "./math"
import { report } from "./report"
import { profileCard } from "./profile"

test("helpers from the new modules", () => {
  expect(capitalize("halo")).toBe("Halo")
  expect(truncate("abcdef", 4)).toBe("abc…")
  expect(sum([1, 2, 3])).toBe(6)
  expect(average([2, 4])).toBe(3)
  expect(clamp(15, 1, 10)).toBe(10)
  expect(report("nilai", [80, 90])).toBe("Nilai: total 170, avg 85.0")
  expect(profileCard("A", "x".repeat(30), 0)).toEqual({ name: "A", bio: `${"x".repeat(19)}…`, level: 1 })
})
