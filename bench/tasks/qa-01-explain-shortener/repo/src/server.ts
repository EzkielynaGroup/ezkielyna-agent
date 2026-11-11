import { encode } from "./codes"
import { LinkStore } from "./store"
import { allow } from "./ratelimit"

const store = new LinkStore("links.json")

export function handler(req: Request, ip: string) {
  if (!allow(ip)) return new Response("slow down", { status: 429 })
  const url = new URL(req.url)
  if (req.method === "POST" && url.pathname === "/shorten") {
    const target = url.searchParams.get("url")
    if (!target) return new Response("missing url", { status: 400 })
    const code = encode(store.nextId())
    store.put(code, target)
    return Response.json({ code })
  }
  const target = store.get(url.pathname.slice(1))
  return target ? Response.redirect(target, 302) : new Response("not found", { status: 404 })
}
