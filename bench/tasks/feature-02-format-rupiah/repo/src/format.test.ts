import { expect, test } from "bun:test"
import { formatTanggal } from "./format"

test("tanggal", () => {
  expect(formatTanggal(new Date(Date.UTC(2026, 7, 17)))).toBe("17 Agu 2026")
})
