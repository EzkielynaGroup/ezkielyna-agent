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
