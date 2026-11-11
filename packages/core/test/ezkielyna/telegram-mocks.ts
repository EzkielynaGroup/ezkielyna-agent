// Mock servers for the Telegram bridge e2e: Telegram Bot API, an opencode-like agent server, and an OpenAI-compatible gateway.
import http from "node:http"
import type { AddressInfo } from "node:net"

export type Srv = { url: string; close: () => Promise<void> }

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })
}
const close = (s: http.Server) => () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })
const body = (req: http.IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))) })

export async function mockGateway() {
  const calls: any[] = []
  const { server, url } = await listen(async (req, res) => {
    const b = JSON.parse((await body(req)).toString() || "{}")
    calls.push(b)
    const last = String(b.messages?.at(-1)?.content ?? "")
    const content = last.includes("LONG") ? "x".repeat(10_000) : `echo: ${last}`
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }))
  })
  return { url, calls, close: close(server) } as Srv & { calls: any[] }
}

export async function mockTelegram(token: string, holdMs = 300) {
  const queue: any[] = []
  const sent: { method: string; body: any }[] = []
  const docs: { name: string; size: number }[] = []
  let uid = 1
  const bad: string[] = []
  const { server, url } = await listen(async (req, res) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "")
    if (!m || m[1] !== token) { bad.push(req.url ?? ""); res.statusCode = 401; return void res.end(JSON.stringify({ ok: false, description: "Unauthorized" })) }
    const method = m[2]!
    const raw = await body(req)
    const reply = (result: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result })) }
    if (method === "getUpdates") {
      const t0 = Date.now()
      const tick = () => {
        if (queue.length) return reply(queue.splice(0))
        if (Date.now() - t0 > holdMs) return reply([])
        setTimeout(tick, 15)
      }
      return tick()
    }
    if (method === "sendDocument") {
      const text = raw.toString("latin1")
      docs.push({ name: /filename="([^"]+)"/.exec(text)?.[1] ?? "", size: raw.length })
      sent.push({ method, body: { chat_id: Number(/name="chat_id"\r\n\r\n(\d+)/.exec(text)?.[1]) } })
      return reply({ message_id: 900 })
    }
    const b = JSON.parse(raw.toString() || "{}")
    sent.push({ method, body: b })
    reply({ message_id: 100 + sent.length })
  })
  const api = {
    url, sent, docs, bad,
    say(userId: number, text: string, chat = { id: userId, type: "private" }) {
      queue.push({ update_id: uid++, message: { message_id: uid, from: { id: userId }, chat, text } })
    },
    press(userId: number, data: string, chatId = userId) {
      queue.push({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: userId }, data, message: { message_id: 1, chat: { id: chatId, type: "private" } } } })
    },
    texts: (chat: number) => sent.filter((s) => s.method === "sendMessage" && s.body.chat_id === chat).map((s) => String(s.body.text)),
    buttons: () => sent.filter((s) => s.body.reply_markup).flatMap((s) => s.body.reply_markup.inline_keyboard.flat() as { callback_data: string }[]),
    close: close(server),
  }
  return api
}

/** opencode-like server. Prompts are answered by calling the OpenAI-compatible gateway. */
export async function mockAgent(gatewayUrl: string, password: string) {
  const sessions = new Map<string, { role: string; text: string }[]>()
  const streams = new Set<http.ServerResponse>()
  const replies: { id: string; response: string }[] = []
  const created: { dir: string }[] = []
  const waiting = new Map<string, () => void>()
  let n = 0
  const emit = (type: string, properties: unknown) => { for (const s of streams) s.write(`data: ${JSON.stringify({ id: String(++n), type, properties })}\n\n`) }
  const { server, url } = await listen(async (req, res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from(`ezkielyna:${password}`).toString("base64")) { res.statusCode = 401; return void res.end() }
    const dir = decodeURIComponent(String(req.headers["x-opencode-directory"] ?? ""))
    const u = req.url ?? ""
    if (req.method === "GET" && u === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }
    const send = (v: unknown, code = 200) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)) }
    if (req.method === "POST" && u === "/session") { const id = `ses_${sessions.size + 1}`; sessions.set(id, []); created.push({ dir }); return send({ id }) }
    let m = /^\/session\/([^/]+)\/prompt_async$/.exec(u)
    if (req.method === "POST" && m) {
      const sid = m[1]!
      const text = JSON.parse((await body(req)).toString()).parts[0].text as string
      const hist = sessions.get(sid)!
      hist.push({ role: "user", text })
      res.statusCode = 204; res.end()
      void (async () => {
        if (text.includes("NEEDPERM") || text.includes("ESCAPE")) {
          const pid = `per_${++n}`
          const patterns = text.includes("ESCAPE") ? ["cat /etc/passwd"] : ["touch ./inside.txt"]
          const metadata = text.includes("NEEDPERM_LONG") ? { command: `echo safe; ${"echo ok; ".repeat(500)}final-dangerous-step` } : {}
          emit("permission.asked", { id: pid, sessionID: sid, permission: "bash", patterns, metadata, always: [] })
          await new Promise<void>((r) => waiting.set(pid, r))
          if (replies.at(-1)?.response === "reject") { hist.push({ role: "assistant", text: "permission denied" }); return emit("session.idle", { sessionID: sid }) }
        }
        const g = await fetch(`${gatewayUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test" }, body: JSON.stringify({ model: "default-model", messages: [{ role: "user", content: text }] }) })
        hist.push({ role: "assistant", text: (await g.json() as any).choices[0].message.content })
        emit("session.idle", { sessionID: sid })
      })()
      return
    }
    m = /^\/session\/([^/]+)\/message$/.exec(u)
    if (req.method === "GET" && m) return send((sessions.get(m[1]!) ?? []).map((x) => ({ info: { role: x.role }, parts: [{ type: "text", text: x.text }] })))
    m = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(u)
    if (req.method === "POST" && m) {
      replies.push({ id: m[2]!, response: JSON.parse((await body(req)).toString()).response })
      waiting.get(m[2]!)?.()
      return send(true)
    }
    m = /^\/session\/([^/]+)\/abort$/.exec(u)
    if (req.method === "POST" && m) return send(true)
    send({ error: "not found" }, 404)
  })
  return { url, replies, created, sessions, close: close(server) }
}
