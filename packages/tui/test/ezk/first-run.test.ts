// C1: the TUI opens the key dialog by itself on a first start with no credential.
import { describe, expect, test } from "bun:test"
import { needsFirstKey } from "../../src/ezk/first-run"

describe("first start: no credential", () => {
  test("only the keyless Ezkielyna provider (fallback models): ask for the key", () => {
    expect(needsFirstKey([{ id: "ezkielyna", source: "custom" }])).toBe(true)
    expect(needsFirstKey([])).toBe(true)
    expect(needsFirstKey([{ id: "ezkielyna", source: "custom" }, { id: "opencode", source: "custom" }])).toBe(true)
  })

  test("a key from auth.json, the environment or the config means no dialog", () => {
    expect(needsFirstKey([{ id: "ezkielyna", source: "api" }])).toBe(false)
    expect(needsFirstKey([{ id: "ezkielyna", source: "env" }])).toBe(false)
    expect(needsFirstKey([{ id: "ezkielyna", source: "config", options: { apiKey: "sk-test_abc" } }])).toBe(false)
    expect(needsFirstKey([{ id: "ezkielyna", source: "config", options: { apiKey: "" } }])).toBe(true)
  })

  test("another configured provider is enough", () => {
    expect(needsFirstKey([{ id: "ezkielyna", source: "custom" }, { id: "openai", source: "api" }])).toBe(false)
  })
})
