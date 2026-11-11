import { expect, test } from "bun:test"
import { deepMerge } from "./merge"

test("does not mutate its inputs", () => {
  const defaults = { server: { port: 80, host: "0.0.0.0" } }
  deepMerge(defaults, { server: { port: 8080 } })
  expect(defaults.server.port).toBe(80)
})

test("arrays are replaced, not merged by index", () => {
  expect(deepMerge({ plugins: ["a", "b", "c"] }, { plugins: ["z"] })).toEqual({ plugins: ["z"] })
})

test("nested objects are merged", () => {
  expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({ a: { x: 1, y: 3 } })
})

test("config defaults survive several loads", async () => {
  const { DEFAULTS, loadConfig } = await import("./config")
  loadConfig({ server: { port: 1 }, plugins: ["x"] })
  loadConfig({ server: { host: "127.0.0.1" } })
  expect(DEFAULTS).toEqual({ server: { port: 80, host: "0.0.0.0" }, plugins: ["log"] })
})
