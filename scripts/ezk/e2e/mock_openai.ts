// A tiny OpenAI-compatible mock gateway for the end-to-end smoke tests: /v1/models and /v1/chat/completions (SSE with
// tool calls). It scripts one coding task: write a file, edit it, run it, then answer. Records every request.
export type Recorded = { path: string; auth?: string; model?: string; tools: number; names?: string[]; messages: number }

const CHAT_MODELS = ["default-model", "fast-model", "minimax-m3.1-flash"]

export function startMock(opts: { validKey: string; port?: number; dir: string }) {
  const requests: Recorded[] = []
  const toolResults: string[] = [] // content of tool messages the model was given (what a tool call returned)
  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
    id: "mock", object: "chat.completion.chunk", created: 0, model: "default-model",
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  })
  const call = (n: number, name: string, args: object) =>
    sse([
      chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }),
      chunk({}, "tool_calls", { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
    ])
  const say = (text: string) =>
    sse([chunk({ role: "assistant", content: text }), chunk({}, "stop", { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })])

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get("authorization") ?? undefined
      if (auth !== `Bearer ${opts.validKey}`) return Response.json({ error: { code: "", message: "Invalid token (request id: mock)", type: "new_api_error" } }, { status: 401 })
      if (url.pathname === "/v1/models") {
        requests.push({ path: url.pathname, auth, tools: 0, messages: 0 })
        return Response.json({ object: "list", data: [...CHAT_MODELS, "bge-m3", "edge-tts"].map((id) => ({ id, object: "model" })) })
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as { model?: string; messages: { role: string; content?: unknown }[]; tools?: unknown[] }
        requests.push({ path: url.pathname, auth, model: body.model, tools: body.tools?.length ?? 0, names: (body.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name ?? "?"), messages: body.messages.length })
        if (!body.tools?.length) return say("Hello script") // title / summary request
        const results = body.messages.filter((m) => m.role === "tool").length
        for (const m of body.messages) if (m.role === "tool") { const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content); if (!toolResults.includes(c)) toolResults.push(c) }
        // scenario 2: the model searches past sessions with the session_search tool (v1.1 FTS5 search)
        const lastUser = [...body.messages].reverse().find((m) => m.role === "user")
        if (/session_search_scenario/.test(typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""))) {
          return results === 0 ? call(11, "session_search", { query: "hello" }) : say("Search finished: found the earlier hello script.")
        }
        const file = `${opts.dir}/hello.py`
        if (results === 0) return call(1, "write", { filePath: file, content: "print('hi')\n" })
        if (results === 1) return call(2, "edit", { filePath: file, oldString: "print('hi')", newString: "print('hello from mock')" })
        if (results === 2) return call(3, "bash", { command: `python3 ${file}`, description: "Run the script" })
        return say("Done: hello.py prints the greeting.")
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, toolResults, stop: () => server.stop(true) }
}
