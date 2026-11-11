import { expect, test } from "bun:test"
import { handle } from "./router"

test("daftar produk", async () => {
  const res = await handle(new Request("http://x/produk"))
  expect(res.status).toBe(200)
  expect((await res.json()).length).toBe(2)
})
