import { expect, test } from "bun:test"
import { handle } from "./router"
import { VERSI } from "./versi"

test("GET /health", async () => {
  const res = await handle(new Request("http://x/health"))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: "ok", versi: VERSI })
})

test("POST /health is 405", async () => {
  expect((await handle(new Request("http://x/health", { method: "POST" }))).status).toBe(405)
})

test("unknown routes return JSON 404", async () => {
  const res = await handle(new Request("http://x/nggak-ada"))
  expect(res.status).toBe(404)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(await res.json()).toEqual({ error: "tidak ditemukan" })
})

test("produk still works", async () => {
  expect((await handle(new Request("http://x/produk"))).status).toBe(200)
})
