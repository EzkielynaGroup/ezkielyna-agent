import { expect, test } from "bun:test"
import { hitungTotal } from "./keranjang"

test("tanpa diskon", () => {
  expect(hitungTotal([{ nama: "Beras 5kg", harga: 65000, jumlah: 2 }])).toBe(130000)
})

test("diskon 10 persen", () => {
  expect(hitungTotal([{ nama: "Minyak 1L", harga: 18500, jumlah: 3 }], 10)).toBe(49950)
})

test("diskon pecahan dibulatkan", () => {
  expect(hitungTotal([{ nama: "Paket", harga: 99999, jumlah: 1 }], 12.5)).toBe(87499)
})

test("diskon di luar 0-100 ditolak", () => {
  expect(() => hitungTotal([{ nama: "X", harga: 1000, jumlah: 1 }], 120)).toThrow()
})
