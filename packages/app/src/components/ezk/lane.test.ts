import { describe, expect, test } from "bun:test"
import { laneClient, laneT } from "./lane-client"

describe("exec lane desktop helpers", () => {
  test("strings fall back to English and have Indonesian", () => {
    expect(laneT("en")("tasks.title")).toBe("Background tasks")
    expect(laneT("id-ID")("tasks.title")).toBe("Tugas latar belakang")
    expect(laneT(undefined)("tasks.stop")).toBe("Stop")
  })
  test("client calls the exec routes with basic auth", async () => {
    const seen: { url: string; method?: string; auth: string | null; body?: string }[] = []
    const f = (async (url: any, init: RequestInit) => {
      seen.push({ url: String(url), method: init.method, auth: new Headers(init.headers).get("authorization"), body: init.body as string | undefined })
      return new Response(JSON.stringify({ enabled: true, tasks: [], ok: true }))
    }) as unknown as typeof fetch
    const api = laneClient({ url: "http://x/", username: "u", password: "p" }, f)
    await api.tasks("ses 1")
    await api.stop("bg_1", "ses 1")
    expect(seen[0]!.url).toBe("http://x/ezk/exec?sessionID=ses%201")
    expect(seen[0]!.auth?.startsWith("Basic ")).toBe(true)
    expect(seen[1]).toMatchObject({ url: "http://x/ezk/exec/stop", method: "POST", body: JSON.stringify({ id: "bg_1", sessionID: "ses 1" }) })
  })
})
