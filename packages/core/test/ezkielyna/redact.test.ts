import { describe, expect, test } from "bun:test"
import { redactDeep, redactSecrets } from "../../src/ezkielyna-redact"

describe("secret redaction", () => {
  test("API keys, bearer tokens and key=value pairs", () => {
    const key = "sk-" + "abcdefghijklmnopqrstuvwxyz012345"
    for (const line of [`using ${key} now`, `Authorization: Bearer ${key}`, `headers={"x-api-key":"${key}"}`, `apiKey=${key}`, `OPENAI_API_KEY="${key}"`]) {
      const out = redactSecrets(line)
      expect(out).not.toContain("abcdefghijkl")
    }
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwx")).toBe("Bearer [redacted]")
  })
  test("leaves ordinary text alone", () => {
    expect(redactSecrets("model=default-model status=200 task-list sk-")).toBe("model=default-model status=200 task-list sk-")
  })
  test("walks objects, arrays and errors", () => {
    const k = "sk-" + "abcdefghijklmnopqrstuvwxyz012345"
    const e = new Error(`failed with ${k}`)
    const out = redactDeep({ a: [k], b: { c: `Bearer ${k}` }, e }) as any
    expect(JSON.stringify(out.a) + JSON.stringify(out.b) + out.e.message + String(out.e.stack)).not.toContain("abcdefghijkl")
  })
})
