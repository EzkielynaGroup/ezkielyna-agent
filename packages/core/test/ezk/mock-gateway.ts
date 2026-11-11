// Local mock of the Ezkielyna gateway for tests: /v1/models, /v1/chat/completions (SSE), /api/pricing.
// Per-model scripted behaviours simulate 403/404/503/timeouts. Never talks to the network.
export type Step =
  | { status: number; body?: string }
  | { hang: true }
  | { partialFailure: string }
  | { ok: true; text?: string; tool?: { name: string; args: Record<string, unknown> }; usage?: { prompt: number; completion: number; cached?: number } }

export interface Recorded {
  model: string
  stream: boolean
  auth: string | null
  messages: number
  tools: number
  system: string
  headers: Record<string, string>
  body: any
}

/** `requireKey`: like the real gateway, answer 401 "Invalid token" to chat requests whose bearer key is not one of `models`' keys. */
export function startMockGateway(opts: { models?: Record<string, string[]>; script?: Record<string, Step[]>; port?: number; requireKey?: boolean } = {}) {
  const requests: Recorded[] = []
  const aux: string[] = []
  const script = opts.script ?? {}
  const modelsByKey = opts.models ?? {}
  const pending = new Set<() => void>()
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models") {
        const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
        const ids = modelsByKey[key] ?? modelsByKey["*"]
        if (!ids) return new Response("unauthorized", { status: 401 })
        return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) })
      }
      if (url.pathname === "/api/pricing") return Response.json({ success: true, group_ratio: { default: 1 }, data: [] })
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        if (opts.requireKey && !((req.headers.get("authorization") ?? "").replace(/^Bearer /, "") in modelsByKey)) {
          return new Response('{"error":{"message":"Invalid token (request id: mock)","type":"new_api_error"}}', { status: 401, headers: { "content-type": "application/json" } })
        }
        const body = (await req.json()) as any
        const system = (body.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => (headers[k] = v))
        if (/You are a title generator|Summarize what was done in this conversation/i.test(system)) {
          aux.push(body.model)
          return sse(body.model, !!body.stream, { ok: true, text: "Mock title" })
        }
        requests.push({ model: body.model, stream: !!body.stream, auth: req.headers.get("authorization"), messages: body.messages?.length ?? 0, tools: body.tools?.length ?? 0, system, headers, body })
        const step: Step = script[body.model]?.shift() ?? { ok: true, text: `ok from ${body.model}` }
        if ("hang" in step) {
          await new Promise<void>((resolve) => {
            pending.add(resolve)
            req.signal.addEventListener("abort", () => resolve())
          })
          return new Response("aborted", { status: 499 })
        }
        if ("partialFailure" in step) return partialFailure(body.model, step.partialFailure)
        if ("status" in step) return new Response(step.body ?? `mock error ${step.status}`, { status: step.status })
        return sse(body.model, !!body.stream, step)
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    requests,
    aux,
    script,
    stop() {
      for (const r of pending) r()
      server.stop(true)
    },
  }
}

function partialFailure(model: string, text: string) {
  const base = { id: "chatcmpl-partial", object: "chat.completion.chunk", created: 1, model }
  const encoder = new TextEncoder()
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { ...base, choices: [{ index: 0, delta: { content: text } }] },
  ].map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!)
        return
      }
      await Bun.sleep(25)
      controller.error(new Error("connection reset after partial text"))
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function sse(model: string, stream: boolean, step: Extract<Step, { ok: true }>) {
  // usage.cached is reported as prompt_tokens_details.cached_tokens (a cache hit), e.g. for bench/ dry runs.
  const usage = { prompt_tokens: step.usage?.prompt ?? 100, completion_tokens: step.usage?.completion ?? 10, total_tokens: (step.usage?.prompt ?? 100) + (step.usage?.completion ?? 10), ...(step.usage?.cached ? { prompt_tokens_details: { cached_tokens: step.usage.cached } } : {}) }
  const id = "chatcmpl-mock"
  const created = 1
  if (!stream) {
    return Response.json({
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, finish_reason: step.tool ? "tool_calls" : "stop", message: { role: "assistant", content: step.text ?? "ok", ...(step.tool ? { tool_calls: [toolCall(step.tool)] } : {}) } }],
      usage,
    })
  }
  const chunks: any[] = []
  const base = { id, object: "chat.completion.chunk", created, model }
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })
  if (step.tool) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall(step.tool) }] } }] })
  else chunks.push({ ...base, choices: [{ index: 0, delta: { content: step.text ?? "ok" } }] })
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }] })
  chunks.push({ ...base, choices: [], usage })
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(text, { headers: { "content-type": "text/event-stream" } })
}

function toolCall(t: { name: string; args: Record<string, unknown> }) {
  return { id: `call_${t.name}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }
}
