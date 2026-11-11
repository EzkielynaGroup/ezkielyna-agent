import { describe, expect, test } from "bun:test"
import { ezkSafetyClient } from "./safety"

describe("ezk desktop safety client", () => {
  test("routes, directory query and auth", async () => {
    const seen: { url: string; method: string; body?: any; auth: string | null }[] = []
    const f = (async (url: any, init: RequestInit) => {
      seen.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init.headers).get("authorization") })
      return new Response(JSON.stringify({ ok: true }))
    }) as unknown as typeof fetch
    const api = ezkSafetyClient({ url: "http://x/", username: "u", password: "p" }, f)
    await api.permission("/a b", "ses_1")
    await api.setMode("/a b", "plan", "ses_1")
    await api.trust("/a b")
    await api.trustFolder("/a b")
    await api.removeTrusted("/a b", "/old")
    await api.reload("/a b")
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET http://x/ezk/permission?directory=%2Fa%20b&sessionID=ses_1",
      "POST http://x/ezk/permission/mode",
      "GET http://x/ezk/trust?directory=%2Fa%20b",
      "POST http://x/ezk/trust",
      "POST http://x/ezk/trust/remove",
      "POST http://x/instance/dispose?directory=%2Fa%20b",
    ])
    expect(seen[1]!.body).toEqual({ directory: "/a b", mode: "plan", sessionID: "ses_1" })
    expect(seen[4]!.body).toEqual({ directory: "/a b", path: "/old" })
    expect(seen.every((s) => s.auth?.startsWith("Basic "))).toBe(true)
  })

  test("errors surface the server message", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "folder not trusted" }), { status: 409 })) as unknown as typeof fetch
    await expect(ezkSafetyClient({ url: "http://x" }, f).trustFolder("/a")).rejects.toThrow("folder not trusted")
  })
})
