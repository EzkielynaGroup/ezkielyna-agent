import { expect, test } from "bun:test"
import { price } from "./booking"

test("price uses nights", () => {
  expect(price("2026-03-02", "2026-03-04", 500000)).toBe(1000000)
})
