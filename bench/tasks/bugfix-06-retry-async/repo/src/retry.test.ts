import { expect, test } from "bun:test"
import { denganUlang } from "./retry"

test("berhasil setelah dua kali gagal", async () => {
  let panggil = 0
  const hasil = await denganUlang(async () => {
    panggil++
    if (panggil < 3) throw new Error("gagal sementara")
    return "ok"
  }, 3, 1)
  expect(hasil).toBe("ok")
  expect(panggil).toBe(3)
})
