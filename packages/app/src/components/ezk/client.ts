// Ezkielyna Agent v1.1: client for the server's /ezk/* JSON routes (the Desktop renders what the server returns).
import type { MemoryStatus, RouteInfo, RouteTurn, SearchHit } from "@opencode-ai/core/ezk/contracts"
import { authTokenFromCredentials } from "@/utils/server"

export type EzkConnection = { url: string; username?: string; password?: string }

export function ezkClient(conn: EzkConnection, f: typeof fetch = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch) {
  const headers = (): Record<string, string> => ({
    ...(conn.password ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.username, password: conn.password })}` } : {}),
  })
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await f(`${conn.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { ...headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; ok?: boolean }
    if (!res.ok && !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
    return json
  }
  return {
    turns: (sessionID: string) => call<RouteTurn[]>("GET", `/ezk/router/turns?sessionID=${encodeURIComponent(sessionID)}`),
    memory: (sessionID?: string) => call<MemoryStatus>("GET", `/ezk/memory${sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : ""}`),
    acceptNotice: () => call<{ ok: boolean }>("POST", "/ezk/memory/notice", {}),
    setPrivate: (sessionID: string, on: boolean) => call<MemoryStatus>("POST", "/ezk/memory/private", { sessionID, on }),
    op: (b: { action: "add" | "replace" | "remove"; store: "memory" | "user"; text?: string; match?: string }) =>
      call<{ ok: boolean; error?: string }>("POST", "/ezk/memory/op", b),
    wipe: () => call<{ memoryFiles: number; searchIndex: boolean }>("POST", "/ezk/memory/wipe", { confirm: true }),
    search: (q: string, exclude?: string) =>
      call<{ hits: (SearchHit & { title?: string })[]; builtMs?: number }>("GET", `/ezk/search?q=${encodeURIComponent(q)}&limit=12${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ""}`),
  }
}

/** Short badge text for a turn ("auto light", "auto heavy, switched from X (HTTP 403)", "pinned"). */
export function routeLabel(r: RouteInfo, lang = "en"): string {
  const id = lang.toLowerCase().startsWith("id")
  if (r.mode === "pinned") return id ? "dipin" : "pinned"
  if (r.mode === "alias") return id ? "auto gateway" : "gateway auto"
  const parts = [`auto ${r.tier ?? ""}`.trim()]
  if (r.escalatedFrom) parts.push(`${id ? "naik dari" : "escalated from"} ${r.escalatedFrom}`)
  if (r.fallbackFrom) parts.push(`${id ? "pindah dari" : "switched from"} ${r.fallbackFrom}${r.fallbackReason ? ` (${r.fallbackReason.replace(/^.* failed \(/, "").replace(/\)$/, "")})` : ""}`)
  if (r.downgraded) parts.push(id ? "batas biaya" : "cost cap")
  return parts.join(", ")
}
