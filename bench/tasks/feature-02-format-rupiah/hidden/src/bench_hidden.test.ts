import { expect, test } from "bun:test"
import { formatRupiah } from "./format"
import { cetakStruk } from "./struk"

test("formatRupiah", () => {
  expect(formatRupiah(1250000)).toBe("Rp 1.250.000")
  expect(formatRupiah(0)).toBe("Rp 0")
  expect(formatRupiah(999)).toBe("Rp 999")
  expect(formatRupiah(-5000)).toBe("-Rp 5.000")
  expect(formatRupiah(1000.6)).toBe("Rp 1.001")
})

test("struk memakai formatRupiah", () => {
  expect(cetakStruk(new Date(Date.UTC(2026, 0, 2)), [{ nama: "Kopi", harga: 25000 }, { nama: "Roti", harga: 1500000 }])).toBe(
    "2 Jan 2026\nKopi: Rp 25.000\nRoti: Rp 1.500.000\nTOTAL: Rp 1.525.000",
  )
})
