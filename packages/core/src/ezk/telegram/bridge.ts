// The Telegram bridge: Telegram updates in, agent sessions driven, replies and permission buttons out.
// Order of checks for every update: private chat only -> allowlist (or pairing) -> rate limit -> command/prompt.
import type { AgentClient, AgentEvent } from "./agent-client"
import { Allowlist, Pairing } from "./allowlist"
import type { ChatState, State, TelegramConfig } from "./config"
import { decide, describeAsk, splitPermissionText } from "./permission"
import { RateLimiter } from "./ratelimit"
import type { Logger } from "./redact"
import type { TelegramApi, TgCallback, TgMessage, TgUpdate } from "./telegram-api"

export type BridgeDeps = {
  api: Pick<TelegramApi, "getUpdates" | "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction" | "sendDocument">
  agent: AgentClient
  config: TelegramConfig
  allowlist: Allowlist
  pairing?: Pairing
  limiter: RateLimiter
  state: State
  persist: (state: State, allowed: number[]) => void
  refreshAllowlist?: () => void
  redactOutput?: (text: string) => string
  log: Logger
  now?: () => number
  typingEveryMs?: number
  runTimeoutMs?: number
}

type Pending = { chatId: number; folder: string; sessionID: string; requestID: string; timer: ReturnType<typeof setTimeout>; messageId?: number }
type Run = { chatId: number; folder: string; sessionID: string; typing: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }

export class Bridge {
  readonly stats = { refused: 0, handled: 0, rateLimited: 0 }
  private pending = new Map<string, Pending>()
  private runs = new Map<number, Run>() // chatId -> active run
  private sessions = new Map<string, number>() // sessionID -> chatId
  private streams = new Map<string, AbortController>() // folder -> event stream
  private lastNotice = new Map<string, number>()
  private seq = 0
  private now: () => number
  constructor(private d: BridgeDeps) {
    this.now = d.now ?? Date.now
    for (const [chat, s] of Object.entries(d.state)) if (s.sessionID) this.sessions.set(s.sessionID, Number(chat))
  }

  // ---- entry points ----
  async handleUpdate(u: TgUpdate): Promise<void> {
    try {
      this.d.refreshAllowlist?.()
      if (u.callback_query) return await this.handleCallback(u.callback_query)
      if (u.message) return await this.handleMessage(u.message)
    } catch (e) {
      this.d.log(`update ${u.update_id} failed: ${(e as Error)?.message ?? e}`)
    }
  }

  async poll(signal: AbortSignal): Promise<void> {
    let offset = 0
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const updates = await this.d.api.getUpdates(offset, 25, signal)
        backoff = 1000
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          await this.handleUpdate(u)
        }
      } catch (e) {
        if (signal.aborted) break
        this.d.log(`poll error: ${(e as Error)?.message ?? e}`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  stop() {
    for (const c of this.streams.values()) c.abort()
    this.streams.clear()
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    for (const r of this.runs.values()) {
      clearInterval(r.typing)
      clearTimeout(r.timeout)
    }
    this.runs.clear()
  }

  // ---- messages ----
  private async handleMessage(m: TgMessage) {
    const uid = m.from?.id
    if (!m.from || m.from.is_bot || m.chat.type !== "private" || m.chat.id !== uid) {
      this.stats.refused++ // groups/channels/bots: never answered
      return
    }
    const text = (m.text ?? "").trim()
    if (!this.d.allowlist.has(uid)) {
      if (this.d.pairing && /^\/pair\s+\S+/.test(text) && this.d.pairing.redeem(text.split(/\s+/)[1]!)) {
        this.d.allowlist.add(uid!)
        this.d.persist(this.d.state, this.d.allowlist.list())
        this.d.log(`paired user ${uid}`)
        await this.send(m.chat.id, "Paired. You can now send tasks. /help for commands.")
        return
      }
      this.stats.refused++
      this.d.log(`refused user ${uid}`)
      if (this.notice(`r${uid}`, 10 * 60_000)) await this.send(m.chat.id, "Not authorized.")
      return
    }
    const wait = this.d.limiter.take(uid!)
    if (wait > 0) {
      this.stats.rateLimited++
      if (this.notice(`l${uid}`, 10_000)) await this.send(m.chat.id, `Too many messages. Try again in ${Math.ceil(wait / 1000)}s.`)
      return
    }
    this.stats.handled++
    if (!text) return
    if (text.startsWith("/")) return await this.command(m.chat.id, text)
    await this.prompt(m.chat.id, text)
  }

  private notice(key: string, everyMs: number): boolean {
    const t = this.now()
    if (t - (this.lastNotice.get(key) ?? -Infinity) < everyMs) return false
    this.lastNotice.set(key, t)
    if (this.lastNotice.size > 1000) this.lastNotice.clear()
    return true
  }

  private chat(chatId: number): ChatState {
    return (this.d.state[chatId] ??= {})
  }
  private save() {
    this.d.persist(this.d.state, this.d.allowlist.list())
  }

  private folderOf(chatId: number): string | undefined {
    const { folders, defaultFolder } = this.d.config
    const name = this.chat(chatId).folder ?? defaultFolder
    return name ? folders[name] : undefined
  }

  private async command(chatId: number, text: string) {
    const [raw, ...rest] = text.split(/\s+/)
    const cmd = raw!.split("@")[0]!.toLowerCase()
    const arg = rest.join(" ").trim()
    const st = this.chat(chatId)
    switch (cmd) {
      case "/start":
      case "/help":
        return this.send(chatId, "Send a task and I run it in your chosen folder.\n/folder [name]  choose folder\n/new  new session\n/stop  cancel the running task\n/model [provider/model]  show or set model\n/status")
      case "/new":
        await this.stopRun(chatId)
        if (st.sessionID) this.sessions.delete(st.sessionID)
        st.sessionID = undefined
        this.save()
        return this.send(chatId, "New session started.")
      case "/stop":
        return this.send(chatId, (await this.stopRun(chatId)) ? "Stopped." : "Nothing is running.")
      case "/folder": {
        const names = Object.keys(this.d.config.folders)
        if (!arg) return this.send(chatId, `Folder: ${st.folder ?? this.d.config.defaultFolder ?? "(none)"}\nAvailable: ${names.join(", ") || "(none, add them on the computer)"}`)
        if (!Object.hasOwn(this.d.config.folders, arg)) return this.send(chatId, "Unknown folder. Only folders registered on the computer can be used.")
        await this.stopRun(chatId)
        if (st.sessionID) this.sessions.delete(st.sessionID)
        st.folder = arg
        st.sessionID = undefined
        this.save()
        return this.send(chatId, `Folder set to ${arg}. New session on next message.`)
      }
      case "/model":
        if (!arg) return this.send(chatId, `Model: ${st.model ?? this.d.config.model ?? "default"}`)
        if (!/^[\w.-]+\/[\w.:@-]+$/.test(arg)) return this.send(chatId, "Use provider/model, for example myprovider/my-model.")
        st.model = arg
        this.save()
        return this.send(chatId, `Model set to ${arg}.`)
      case "/status":
        return this.send(chatId, `Folder: ${st.folder ?? this.d.config.defaultFolder ?? "(none)"}\nSession: ${st.sessionID ? "active" : "none"}\nRunning: ${this.runs.has(chatId) ? "yes" : "no"}`)
      default:
        return this.send(chatId, "Unknown command. /help")
    }
  }

  // ---- agent runs ----
  private async prompt(chatId: number, text: string) {
    if (this.runs.has(chatId)) return void (await this.send(chatId, "Still working. Wait for the result or send /stop."))
    const folder = this.folderOf(chatId)
    if (!folder) return void (await this.send(chatId, "No folder chosen. Use /folder <name>."))
    const st = this.chat(chatId)
    try {
      this.ensureStream(folder)
      if (!st.sessionID) {
        st.sessionID = await this.d.agent.createSession(folder, `Telegram ${chatId}`)
        this.save()
      }
      this.sessions.set(st.sessionID, chatId)
      const sessionID = st.sessionID
      const run: Run = {
        chatId,
        folder,
        sessionID,
        typing: setInterval(() => void this.d.api.sendChatAction(chatId).catch(() => {}), this.d.typingEveryMs ?? 4000),
        timeout: setTimeout(() => void this.timeoutRun(chatId), this.d.runTimeoutMs ?? 15 * 60_000),
      }
      this.runs.set(chatId, run)
      void this.d.api.sendChatAction(chatId).catch(() => {})
      await this.d.agent.prompt(folder, sessionID, text, st.model ?? this.d.config.model)
    } catch (e) {
      this.endRun(chatId)
      this.d.log(`prompt failed: ${(e as Error)?.message ?? e}`)
      await this.send(chatId, "Could not reach the agent. Is the ezkielyna server running?")
    }
  }

  private ensureStream(folder: string) {
    if (this.streams.has(folder)) return
    const ctl = new AbortController()
    this.streams.set(folder, ctl)
    this.d.agent.events(folder, (e) => void this.onEvent(folder, e), ctl.signal)
  }

  private endRun(chatId: number): Run | undefined {
    const r = this.runs.get(chatId)
    if (!r) return
    clearInterval(r.typing)
    clearTimeout(r.timeout)
    this.runs.delete(chatId)
    return r
  }

  private async stopRun(chatId: number): Promise<boolean> {
    const r = this.endRun(chatId)
    for (const [id, p] of this.pending) if (p.chatId === chatId) void this.resolve(id, "reject", "Cancelled.")
    if (!r) return false
    await this.d.agent.abort(r.folder, r.sessionID).catch(() => {})
    return true
  }

  private async timeoutRun(chatId: number) {
    if (await this.stopRun(chatId)) await this.send(chatId, "Task timed out and was stopped.")
  }

  async onEvent(folder: string, e: AgentEvent) {
    const p = (e.properties ?? {}) as Record<string, any>
    const chatId = typeof p.sessionID === "string" ? this.sessions.get(p.sessionID) : undefined
    if (chatId === undefined) return // not a Telegram session: ignore completely
    if (e.type === "permission.asked") return await this.onPermission(chatId, folder, p as any)
    if (e.type === "session.idle") {
      const r = this.runs.get(chatId)
      if (!r || r.sessionID !== p.sessionID) return
      this.endRun(chatId)
      const out = (await this.d.agent.lastAssistantText(folder, r.sessionID).catch(() => "")) || "(no text result)"
      await this.send(chatId, out)
    }
    if (e.type === "session.error" && this.runs.get(chatId)?.sessionID === p.sessionID) {
      this.endRun(chatId)
      await this.send(chatId, "The agent reported an error. Try again or /new.")
    }
  }

  // ---- permissions ----
  private async onPermission(chatId: number, folder: string, ask: Parameters<typeof decide>[1]) {
    const verdict = decide(folder, ask)
    if (verdict.action === "reject") {
      await this.d.agent.replyPermission(folder, ask.sessionID, ask.id, "reject").catch(() => {})
      await this.send(chatId, `Refused: ${verdict.reason}.`)
      return
    }
    const key = `${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    try {
      const chunks = splitPermissionText(describeAsk(ask))
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `Permission details ${i + 1}/${chunks.length}:\n` : ""
        await this.d.api.sendMessage(chatId, prefix + chunks[i]!)
      }
      const sent = await this.d.api.sendMessage(chatId, "The complete request is shown above. Allow it once or deny it?", [
        [{ text: "Allow", callback_data: `p:${key}:y` }, { text: "Deny", callback_data: `p:${key}:n` }],
      ])
      const timer = setTimeout(() => void this.resolve(key, "reject", "Timed out, denied."), this.d.config.permissionTimeoutSeconds * 1000)
      this.pending.set(key, { chatId, folder, sessionID: ask.sessionID, requestID: ask.id, timer, messageId: sent?.message_id })
    } catch {
      await this.d.agent.replyPermission(folder, ask.sessionID, ask.id, "reject").catch(() => {})
      await this.send(chatId, "Permission request denied because the complete request could not be shown.")
    }
  }

  private async resolve(key: string, reply: "once" | "reject", note: string) {
    const p = this.pending.get(key)
    if (!p) return false
    this.pending.delete(key)
    clearTimeout(p.timer)
    await this.d.agent.replyPermission(p.folder, p.sessionID, p.requestID, reply).catch((e) => this.d.log(`permission reply failed: ${(e as Error)?.message}`))
    if (p.messageId) await this.d.api.editMessageText(p.chatId, p.messageId, note).catch(() => {})
    return true
  }

  private async handleCallback(cb: TgCallback) {
    const ok = this.d.allowlist.has(cb.from.id) && cb.message?.chat.type === "private" && cb.message.chat.id === cb.from.id
    if (!ok) {
      this.stats.refused++
      return void (await this.d.api.answerCallbackQuery(cb.id, "Not authorized.").catch(() => {}))
    }
    if (this.d.limiter.take(cb.from.id) > 0) {
      this.stats.rateLimited++
      return void (await this.d.api.answerCallbackQuery(cb.id, "Too fast.").catch(() => {}))
    }
    const m = /^p:([a-z0-9]+):([yn])$/.exec(cb.data ?? "")
    const p = m && this.pending.get(m[1]!)
    if (!m || !p || p.chatId !== cb.from.id) return void (await this.d.api.answerCallbackQuery(cb.id, "Expired.").catch(() => {}))
    const allow = m[2] === "y"
    await this.resolve(m[1]!, allow ? "once" : "reject", allow ? "Allowed." : "Denied.")
    await this.d.api.answerCallbackQuery(cb.id, allow ? "Allowed" : "Denied").catch(() => {})
  }

  // ---- output ----
  private async send(chatId: number, text: string) {
    const max = this.d.config.maxReplyChars
    const safe = this.d.redactOutput?.(text) ?? text
    try {
      if (safe.length <= max) return void (await this.d.api.sendMessage(chatId, safe))
      await this.d.api.sendMessage(chatId, safe.slice(0, max) + "\n\n… truncated, full result attached as a file.")
      await this.d.api.sendDocument(chatId, "result.txt", safe)
    } catch (e) {
      this.d.log(`send failed: ${(e as Error)?.message ?? e}`)
    }
  }
}
