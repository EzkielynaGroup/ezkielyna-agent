import { describe, expect, test } from "bun:test"
import { ezkClient, routeLabel } from "./client"
import { escapeSnippet } from "./search-dialog"
import { ezkT } from "./strings"

describe("ezk desktop helpers", () => {
  test("routeLabel in English and Indonesian", () => {
    const base = { reason: "", at: 1 }
    expect(routeLabel({ ...base, mode: "pinned", model: "m" })).toBe("pinned")
    expect(routeLabel({ ...base, mode: "pinned", model: "m" }, "id")).toBe("dipin")
    expect(routeLabel({ ...base, mode: "auto", model: "m", tier: "light" })).toBe("auto light")
    expect(routeLabel({ ...base, mode: "auto", model: "b", tier: "heavy", fallbackFrom: "a", fallbackReason: "a failed (HTTP 403)" })).toBe("auto heavy, switched from a (HTTP 403)")
    expect(routeLabel({ ...base, mode: "auto", model: "b", tier: "light", fallbackFrom: "a" }, "id")).toBe("auto light, pindah dari a")
  })
  test("snippets are escaped before match markers become <mark>", () => {
    expect(escapeSnippet("a [b] <script>x</script> & c")).toBe("a <mark>b</mark> &lt;script&gt;x&lt;/script&gt; &amp; c")
  })
  test("strings fall back to English and every Indonesian key exists", () => {
    expect(ezkT("en-US")("memory.title")).toBe("Memory")
    expect(ezkT("id")("memory.title")).toBe("Memori")
    expect(ezkT(undefined)("search.none")).toBe("No matches.")
  })
  test("client sends basic auth only when a password is set", async () => {
    const seen: Headers[] = []
    const f = (async (_u: any, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response(JSON.stringify({ hits: [] }))
    }) as unknown as typeof fetch
    await ezkClient({ url: "http://x/" }, f).search("hi")
    await ezkClient({ url: "http://x", username: "u", password: "p" }, f).search("hi")
    expect(seen[0]!.get("authorization")).toBeNull()
    expect(seen[1]!.get("authorization")).toBe(`Basic ${btoa("u:p")}`)
  })
})
