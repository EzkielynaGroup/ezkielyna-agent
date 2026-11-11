import { expect, test } from "bun:test"
import { transfer } from "./transfer"
import { cekPin } from "./pin"

const daftar = () => [
  { id: "a", saldo: 100, diblokir: false },
  { id: "b", saldo: 0, diblokir: false },
  { id: "c", saldo: 0, diblokir: true },
]

test("pesan error tetap sama", () => {
  expect(() => transfer(daftar(), "a", "b", 0)).toThrow("Jumlah transfer harus lebih dari nol")
  expect(() => transfer(daftar(), "a", "x", 10)).toThrow("Akun tidak ditemukan")
  expect(() => transfer(daftar(), "a", "c", 10)).toThrow("Akun sedang diblokir, hubungi layanan pelanggan")
  expect(() => transfer(daftar(), "b", "a", 10)).toThrow("Saldo tidak cukup")
  expect(() => cekPin("12ab")).toThrow("PIN harus 6 digit angka")
})

test("transfer berhasil", () => {
  const akun = daftar()
  transfer(akun, "a", "b", 40)
  expect(akun.map((item) => item.saldo)).toEqual([60, 40, 0])
})
