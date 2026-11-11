// Ezkielyna Agent v1.1: tiny client for the /ezk/* JSON routes. The TUI only renders what the server returns.
import type { MemoryStatus, RouteInfo, RouteTurn, RouterStatus, SearchHit } from "@opencode-ai/core/ezk/contracts"

export interface EzkTransport {
  fetch: typeof fetch
  url: string
  headers?: RequestInit["headers"]
}

async function call<T>(t: EzkTransport, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = new Headers(t.headers)
  if (body !== undefined) headers.set("content-type", "application/json")
  const res = await t.fetch(`${t.url.replace(/\/+$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok && !(json as any).ok) throw new Error((json as any).error ?? `HTTP ${res.status}`)
  return json
}

export const ezk = (t: EzkTransport) => ({
  turns: (sessionID: string) => call<RouteTurn[]>(t, "GET", `/ezk/router/turns?sessionID=${encodeURIComponent(sessionID)}`),
  routerStatus: (sessionID?: string) => call<RouterStatus>(t, "GET", `/ezk/router/status${sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""}`),
  memory: (sessionID?: string) => call<MemoryStatus>(t, "GET", `/ezk/memory${sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""}`),
  acceptNotice: () => call<{ ok: boolean }>(t, "POST", "/ezk/memory/notice", {}),
  setPrivate: (sessionID: string, on: boolean) => call<MemoryStatus>(t, "POST", "/ezk/memory/private", { sessionID, on }),
  op: (b: { action: "add" | "replace" | "remove"; store: "memory" | "user"; text?: string; match?: string }) =>
    call<{ ok: boolean; error?: string }>(t, "POST", "/ezk/memory/op", b),
  wipe: () => call<{ memoryFiles: number; searchIndex: boolean }>(t, "POST", "/ezk/memory/wipe", { confirm: true }),
  search: (q: string, exclude?: string) =>
    call<{ hits: (SearchHit & { title?: string })[]; builtMs?: number }>(t, "GET", `/ezk/search?q=${encodeURIComponent(q)}&limit=12${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ""}`),
})

/** Short label for the per-turn badge ("auto light", "auto heavy, switched from X (HTTP 403)", "pinned", ...). */
export function routeLabel(r: RouteInfo): string {
  if (r.mode === "pinned") return "pinned"
  if (r.mode === "alias") return "gateway auto"
  const parts = [`auto ${r.tier ?? ""}`.trim()]
  if (r.escalatedFrom) parts.push(`escalated from ${r.escalatedFrom}`)
  if (r.fallbackFrom) parts.push(`switched from ${r.fallbackFrom}${r.fallbackReason ? ` (${r.fallbackReason.replace(/^.* failed \(/, "").replace(/\)$/, "")})` : ""}`)
  if (r.downgraded) parts.push("cost cap")
  if (r.sticky) parts.push("sticky")
  return parts.join(", ")
}
