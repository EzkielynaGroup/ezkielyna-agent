import { describe, expect, test } from "bun:test"
import { EZK } from "@opencode-ai/core/ezkielyna-brand"
import { maskedApiKey, validateAndSaveEzkielynaKey } from "./key-validation"

describe("Ezkielyna API key change", () => {
  test("validates with one models request, saves, refreshes, and only returns a masked key", async () => {
    const fakeKey = "sk-test_fake-1234"
    const requests: { url: string; authorization: string | null }[] = []
    const saved: string[] = []
    let refreshes = 0
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ data: [{ id: "fast-model", groups: ["flash"], groupRatio: { flash: 1 } }] }))
    }) as typeof fetch

    const models = await validateAndSaveEzkielynaKey({
      key: fakeKey,
      fetcher,
      save: async (value) => void saved.push(value),
      refresh: async () => void refreshes++,
    })

    expect(requests).toEqual([{ url: `${EZK.baseURL}/models`, authorization: `Bearer ${fakeKey}` }])
    expect(saved).toEqual([fakeKey])
    expect(refreshes).toBe(1)
    expect(models).toEqual([{ id: "fast-model", groups: ["flash"], groupRatio: { flash: 1 } }])
    expect(maskedApiKey(fakeKey)).toBe("sk-…1234")
    expect(JSON.stringify({ masked: maskedApiKey(fakeKey), models })).not.toContain(fakeKey)
  })

  test("does not save or refresh when validation fails", async () => {
    let saved = false
    let refreshed = false
    const fetcher = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch
    const result = await validateAndSaveEzkielynaKey({
      key: "sk-test_invalid",
      fetcher,
      save: async () => void (saved = true),
      refresh: async () => void (refreshed = true),
    })
    expect(result).toBeUndefined()
    expect(saved).toBe(false)
    expect(refreshed).toBe(false)
  })
})
