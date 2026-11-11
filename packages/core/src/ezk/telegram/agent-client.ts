// Client for `ezkielyna serve` (HTTP + SSE). Only the few endpoints the bridge needs. Auth: HTTP Basic (server password).
export type AgentEvent =
  | { type: "permission.asked"; properties: { id: string; sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, unknown> } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: unknown } }
  | { type: string; properties?: Record<string, unknown> }

export type Reply = "once" | "always" | "reject"

export interface AgentClient {
  createSession(folder: string, title: string): Promise<string>
  prompt(folder: string, sessionID: string, text: string, model?: string): Promise<void>
  lastAssistantText(folder: string, sessionID: string): Promise<string>
  abort(folder: string, sessionID: string): Promise<void>
  replyPermission(folder: string, sessionID: string, requestID: string, reply: Reply): Promise<void>
  /** Streams events for one folder until `signal` aborts. Reconnects internally. */
  events(folder: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal): void
}

export function httpAgentClient(baseUrl: string, username: string, password: string, fetchImpl: typeof fetch = fetch): AgentClient {
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
  const headers = (folder: string, json = false) => ({
    authorization: auth,
    "x-opencode-directory": encodeURIComponent(folder),
    ...(json ? { "content-type": "application/json" } : {}),
  })
  const call = async (method: string, folder: string, path: string, body?: unknown) => {
    const res = await fetchImpl(baseUrl + path, { method, headers: headers(folder, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) })
    if (!res.ok) throw new Error(`agent ${method} ${path.replace(/\/[^/]*$/, "/…")} -> ${res.status}`)
    return res.status === 204 ? undefined : await res.json().catch(() => undefined)
  }
  const modelRef = (m?: string) => {
    if (!m) return undefined
    const i = m.indexOf("/")
    return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : undefined
  }
  return {
    async createSession(folder, title) {
      const s = (await call("POST", folder, "/session", { title })) as { id: string }
      return s.id
    },
    async prompt(folder, sessionID, text, model) {
      await call("POST", folder, `/session/${encodeURIComponent(sessionID)}/prompt_async`, { parts: [{ type: "text", text }], model: modelRef(model) })
    },
    async lastAssistantText(folder, sessionID) {
      const msgs = (await call("GET", folder, `/session/${encodeURIComponent(sessionID)}/message`)) as {
        info: { role: string; error?: { data?: { message?: string }; name?: string } }
        parts: { type: string; text?: string }[]
      }[]
      const last = [...(msgs ?? [])].reverse().find((m) => m.info.role === "assistant")
      if (!last) return ""
      const text = last.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim()
      if (text) return text
      return last.info.error ? `Error: ${last.info.error.data?.message ?? last.info.error.name ?? "unknown"}` : ""
    },
    async abort(folder, sessionID) {
      await call("POST", folder, `/session/${encodeURIComponent(sessionID)}/abort`)
    },
    async replyPermission(folder, sessionID, requestID, reply) {
      await call("POST", folder, `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(requestID)}`, { response: reply })
    },
    events(folder, onEvent, signal) {
      void (async () => {
        let delay = 500
        while (!signal.aborted) {
          try {
            const res = await fetchImpl(baseUrl + "/event", { headers: { ...headers(folder), accept: "text/event-stream" }, signal })
            if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`)
            delay = 500
            const dec = new TextDecoder()
            let buf = ""
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              buf += dec.decode(chunk, { stream: true })
              let i: number
              while ((i = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, i)
                buf = buf.slice(i + 2)
                const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")
                if (!data) continue
                try {
                  onEvent(JSON.parse(data))
                } catch {}
              }
            }
          } catch {
            if (signal.aborted) return
          }
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 15_000)
        }
      })()
    },
  }
}
