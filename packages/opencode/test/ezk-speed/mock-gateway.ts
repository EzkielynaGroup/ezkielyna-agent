// Mock OpenAI-compatible gateway for the speed e2e tests. Local only (127.0.0.1, ephemeral port), no real API calls.
// Scripts: "tool" streams one tool call with the given raw arguments, "hang" never answers, "stall" sends a chunk then goes silent.
export type Script =
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "text"; text: string }
  | { kind: "hang" }
  | { kind: "stall" }

export function startMockGateway(scripts: Script[]) {
  let i = 0
  const open = new Set<ReadableStreamDefaultController>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const s = scripts[i++] ?? { kind: "text", text: "done" }
      const enc = new TextEncoder()
      const chunk = (delta: unknown, finish: string | null = null) =>
        enc.encode(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      const body = new ReadableStream({
        start(c) {
          open.add(c)
          if (s.kind === "hang") return
          if (s.kind === "stall") return void c.enqueue(chunk({ role: "assistant", content: "thinking" }))
          if (s.kind === "text") {
            c.enqueue(chunk({ role: "assistant", content: s.text }))
            c.enqueue(chunk({}, "stop"))
          } else {
            const raw = typeof s.args === "string" ? s.args : JSON.stringify(s.args)
            c.enqueue(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: s.name, arguments: "" } }] }))
            for (let k = 0; k < raw.length; k += 17) c.enqueue(chunk({ tool_calls: [{ index: 0, function: { arguments: raw.slice(k, k + 17) } }] }))
            c.enqueue(chunk({}, "tool_calls"))
          }
          c.enqueue(enc.encode("data: [DONE]\n\n"))
          c.close()
        },
        cancel() {},
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests: () => i,
    stop: () => server.stop(true),
  }
}

/** Minimal OpenAI-compatible client: POST, then iterate parsed SSE `data:` payloads. */
export async function* chatStream(baseURL: string, signal?: AbortSignal): AsyncGenerator<any> {
  const res = await fetch(`${baseURL}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "mock", stream: true, messages: [] }) })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += dec.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 2)
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") return
      yield JSON.parse(data)
    }
  }
}

/** Collect the streamed tool call: returns { name, args(raw string) }. */
export async function nextToolCall(baseURL: string) {
  let name = ""
  let args = ""
  let text = ""
  for await (const ev of chatStream(baseURL)) {
    const d = ev.choices?.[0]?.delta
    for (const tc of d?.tool_calls ?? []) {
      if (tc.function?.name) name = tc.function.name
      if (tc.function?.arguments) args += tc.function.arguments
    }
    if (d?.content) text += d.content
  }
  return { name, args, text }
}
