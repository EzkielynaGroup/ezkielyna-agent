import { describe, expect, test } from "bun:test"
import { uxClient, UX_OFF } from "./ux-client"
import { UX_STRINGS, uxLang, uxT } from "./ux-strings"
import { rewindSummary } from "./ux-dialogs"

describe("ezk ux lane, desktop helpers", () => {
  test("Indonesian labels use the owner's wording, every key exists in both languages, no supplier names", () => {
    const id = uxT("id-ID")
    expect(id("plan.auto")).toBe("Setujui & jalankan (Edit otomatis)")
    expect(id("plan.ask")).toBe("Setujui & tanya tiap langkah")
    expect(id("plan.keep")).toBe("Lanjut merencanakan")
    expect(id("plan.edit")).toBe("Edit rencana")
    expect(uxT("en")("rewind.restored", { n: 2 })).toBe("2 file(s) restored.")
    expect(Object.keys(UX_STRINGS.id).toSorted()).toEqual(Object.keys(UX_STRINGS.en).toSorted())
    expect(JSON.stringify(UX_STRINGS)).not.toMatch(/examplevendor|partner|\bmac\b/i)
    expect(uxLang("id")).toBe("id")
    expect(uxLang(undefined)).toBe("en")
  })

  test("rewind summary names restored and skipped files", () => {
    expect(rewindSummary({ mode: "both", restored: ["/p/a.ts"], skipped: ["/p/src/b.ts"] })).toBe(
      "1 file(s) restored. Your message is back in the box. 1 file(s) left alone because they were changed outside the agent: src/b.ts",
    )
    expect(rewindSummary({ mode: "summarize", restored: [], skipped: [] }, "id")).toBe("Pesan-pesan berikutnya diganti dengan ringkasan.")
  })

  test("client: auth header only with a password, errors surface the server text, status falls back to off", async () => {
    const seen: { url: string; headers: Headers; body?: string }[] = []
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: init.body as string })
      if (url.endsWith("/ezk/ux/rewind")) return new Response(JSON.stringify({ error: "session is busy" }), { status: 409 })
      if (url.endsWith("/ezk/ux/status")) return new Response("nope", { status: 500 })
      return new Response(JSON.stringify({ checkpoints: [], diskBytes: 0, diskText: "0 B" }))
    }) as unknown as typeof fetch
    await uxClient({ url: "http://x/" }, f).checkpoints("ses_1")
    expect(seen[0]!.url).toBe("http://x/ezk/ux/checkpoints?sessionID=ses_1")
    expect(seen[0]!.headers.get("authorization")).toBeNull()
    const api = uxClient({ url: "http://x", username: "u", password: "p" }, f)
    await expect(api.rewind({ sessionID: "ses_1", messageID: "msg_1", mode: "both" })).rejects.toThrow("session is busy")
    expect(seen[1]!.headers.get("authorization")).toStartWith("Basic ")
    expect(JSON.parse(seen[1]!.body!)).toEqual({ sessionID: "ses_1", messageID: "msg_1", mode: "both" })
    expect(await api.status()).toEqual(UX_OFF)
  })
})
