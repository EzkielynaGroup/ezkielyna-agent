import { describe, expect, test } from "bun:test"
import { gatewaySearch, webSearchAvailable, SEARCH_TIMEOUT_MS, searchEndpoint } from "../../src/ezk/websearch/client"
import { loadFlags } from "../../src/ezk/flags"

const KEY = "test-key-not-real"
const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch

describe("gatewaySearch (mocked)", () => {
  test("success: numbered list + hint, request shape, key only in header", async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({
        query: "bun", cached: false, took_ms: 12,
        results: [
          { title: "Bun", url: "https://bun.sh", snippet: "A fast\n runtime", published: "2026-01-01" },
          { title: "Docs", url: "https://bun.sh/docs", snippet: "" },
        ],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await gatewaySearch({ params: { query: "bun", max_results: 50, time_range: "week", language: "en" }, key: KEY, endpoint: "http://mock/v1/search", fetch: f })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output).toBe("1. Bun — https://bun.sh (2026-01-01)\n   A fast runtime\n2. Docs — https://bun.sh/docs\n\nuse webfetch on a URL to read the page")
    expect(r.count).toBe(2)
    expect(seen!.url).toBe("http://mock/v1/search")
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(seen!.init.body as string)).toEqual({ query: "bun", max_results: 10, time_range: "week", language: "en" })
    expect(r.output).not.toContain(KEY)
  })

  test("401 -> actionable EN+ID, no key leak", async () => {
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: json(401, { error: { message: "bad key", type: "auth" } }) })
    expect(r).toMatchObject({ ok: false, status: 401 })
    if (r.ok) return
    expect(r.message).toContain("API key was not accepted")
    expect(r.message).toContain("kunci API Ezkielyna tidak diterima")
    expect(r.message).not.toContain(KEY)
  })

  test("429 -> tells the model to stop searching", async () => {
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: json(429, { error: { message: "limit", type: "rate" } }) })
    expect(r).toMatchObject({ ok: false, status: 429 })
    if (r.ok) return
    expect(r.message).toContain("Stop searching and continue with the information you already have")
    expect(r.message).toContain("Berhenti mencari")
  })

  test.each([502, 503])("%d -> temporarily unavailable", async (code) => {
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: json(code, { error: { message: "down", type: "x" } }) })
    expect(r).toMatchObject({ ok: false, status: code })
    if (r.ok) return
    expect(r.message).toContain("temporarily unavailable")
    expect(r.message).toContain("sementara")
  })

  test("400 includes the server detail; empty query rejected locally without a request", async () => {
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: json(400, { error: { message: "bad time_range", type: "invalid" } }) })
    if (r.ok) throw new Error("expected failure")
    expect(r.message).toContain("bad time_range")
    let called = false
    const local = await gatewaySearch({ params: { query: "  " }, key: KEY, fetch: (async () => { called = true; return new Response("{}") }) as any })
    expect(local).toMatchObject({ ok: false, status: "invalid" })
    expect(called).toBe(false)
  })

  test("timeout: default is 15 s and a hanging server aborts", async () => {
    expect(SEARCH_TIMEOUT_MS).toBe(15_000)
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError")))
    })) as unknown as typeof fetch
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: hang, timeoutMs: 40 })
    expect(r).toMatchObject({ ok: false, status: "timeout" })
    if (r.ok) return
    expect(r.message).toContain("15 seconds")
    expect(r.message).toContain("15 detik")
  })

  test("network error is reported plainly", async () => {
    const r = await gatewaySearch({ params: { query: "x" }, key: KEY, fetch: (async () => { throw new Error("ECONNREFUSED") }) as any })
    expect(r).toMatchObject({ ok: false, status: "network" })
  })

  test("0 results -> helpful message, ok", async () => {
    const r = await gatewaySearch({ params: { query: "zzzz" }, key: KEY, fetch: json(200, { query: "zzzz", results: [], cached: true, took_ms: 3 }) })
    expect(r).toMatchObject({ ok: true, count: 0, cached: true })
    if (!r.ok) return
    expect(r.output).toContain("No results")
    expect(r.output).toContain("Tidak ada hasil")
  })

  test("missing key: no request, tool unavailable", async () => {
    let called = false
    const r = await gatewaySearch({ params: { query: "x" }, key: undefined, fetch: (async () => { called = true; return new Response("{}") }) as any })
    expect(r).toMatchObject({ ok: false, status: "nokey" })
    expect(called).toBe(false)
    expect(webSearchAvailable(true, undefined)).toBe(false)
    expect(webSearchAvailable(true, "")).toBe(false)
    expect(webSearchAvailable(true, KEY)).toBe(true)
    expect(webSearchAvailable(false, KEY)).toBe(false)
  })

  test("endpoint follows EZKIELYNA_BASE_URL", () => {
    expect(searchEndpoint({})).toBe("https://api.ezkielyna.store/v1/search")
    expect(searchEndpoint({ EZKIELYNA_BASE_URL: "http://127.0.0.1:9/v1/" })).toBe("http://127.0.0.1:9/v1/search")
  })
})

describe("flag", () => {
  test("default on; EZK_FEATURES=-websearch turns it off", () => {
    expect(loadFlags([], {}).websearch.enabled).toBe(true)
    expect(loadFlags([], { EZK_FEATURES: "-websearch" }).websearch.enabled).toBe(false)
  })
})
