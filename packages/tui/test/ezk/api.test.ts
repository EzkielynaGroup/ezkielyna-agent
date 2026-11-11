import { describe, expect, test } from "bun:test"
import { ezk, routeLabel } from "../../src/ezk/api"
import { refreshRoutes, routeFor } from "../../src/ezk/route-store"

const fakeServer = (handler: (url: URL, init: RequestInit) => unknown, status = 200) =>
  (async (input: any, init: RequestInit = {}) => new Response(JSON.stringify(handler(new URL(String(input)), init)), { status })) as unknown as typeof fetch

describe("routeLabel", () => {
  const base = { reason: "r", at: 1 }
  test("labels", () => {
    expect(routeLabel({ ...base, mode: "pinned", model: "m" })).toBe("pinned")
    expect(routeLabel({ ...base, mode: "alias", model: "m" })).toBe("gateway auto")
    expect(routeLabel({ ...base, mode: "auto", model: "m", tier: "light" })).toBe("auto light")
    expect(routeLabel({ ...base, mode: "auto", model: "b", tier: "heavy", fallbackFrom: "a", fallbackReason: "a failed (HTTP 403)" })).toBe("auto heavy, switched from a (HTTP 403)")
    expect(routeLabel({ ...base, mode: "auto", model: "b", tier: "heavy", escalatedFrom: "a", downgraded: true })).toBe("auto heavy, escalated from a, cost cap")
  })
})

describe("api", () => {
  test("sends auth headers, JSON bodies and parses results", async () => {
    const seen: { url: string; headers: Headers; body?: string }[] = []
    const f = fakeServer((url, init) => {
      seen.push({ url: url.pathname + url.search, headers: new Headers(init.headers), body: init.body as string | undefined })
      return { ok: true, hits: [] }
    })
    const api = ezk({ fetch: f, url: "http://x:1/", headers: { authorization: "Basic abc" } })
    await api.setPrivate("s 1", true)
    await api.search("hello world", "s1")
    expect(seen[0]!.url).toBe("/ezk/memory/private")
    expect(JSON.parse(seen[0]!.body!)).toEqual({ sessionID: "s 1", on: true })
    expect(seen[0]!.headers.get("authorization")).toBe("Basic abc")
    expect(seen[1]!.url).toBe("/ezk/search?q=hello%20world&limit=12&exclude=s1")
  })
  test("errors surface the server message", async () => {
    const api = ezk({ fetch: fakeServer(() => ({ error: "q required" }), 400), url: "http://x" })
    await expect(api.search("")).rejects.toThrow("q required")
  })
  test("route store loads per session and reconciles", async () => {
    let n = 0
    const f = fakeServer(() => [{ sessionID: "s", messageID: `m${++n}`, route: { mode: "auto", model: "x", reason: "", at: 1, tier: "light" } }])
    await refreshRoutes({ fetch: f, url: "http://x" }, "s")
    expect(routeFor("s", "m1")?.tier).toBe("light")
    await refreshRoutes({ fetch: f, url: "http://x" }, "s")
    expect(routeFor("s", "m1")).toBeUndefined()
    expect(routeFor("s", "m2")).toBeDefined()
    expect(routeFor("other", "m1")).toBeUndefined()
  })
})
