// Minimal Telegram Bot API client (fetch only). `baseUrl` is injectable so tests point it at a mock server.
import { makeRedactor } from "./redact"

export type TgUser = { id: number; is_bot?: boolean; username?: string }
export type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel" }
export type TgMessage = { message_id: number; from?: TgUser; chat: TgChat; text?: string }
export type TgCallback = { id: string; from: TgUser; message?: TgMessage; data?: string }
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback }
export type Button = { text: string; callback_data: string }

export class TelegramApi {
  private redact: (t: string) => string
  constructor(
    private token: string,
    private baseUrl = "https://api.telegram.org",
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.redact = makeRedactor(token)
  }

  private async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal,
      })
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e
      throw new Error(this.redact(`telegram ${method} failed: ${(e as Error)?.message ?? e}`))
    }
    const json = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: T; description?: string } | undefined
    if (!res.ok || !json?.ok) throw new Error(this.redact(`telegram ${method} -> ${res.status} ${json?.description ?? ""}`))
    return json.result as T
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal)
  }
  sendMessage(chatId: number, text: string, buttons?: Button[][]) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    })
  }
  editMessageText(chatId: number, messageId: number, text: string) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4096) })
  }
  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text })
  }
  sendChatAction(chatId: number, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action })
  }
  async sendDocument(chatId: number, filename: string, content: string, caption?: string) {
    const form = new FormData()
    form.set("chat_id", String(chatId))
    if (caption) form.set("caption", caption.slice(0, 1024))
    form.set("document", new Blob([content], { type: "text/plain" }), filename)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/sendDocument`, { method: "POST", body: form })
    } catch (e) {
      throw new Error(this.redact(`telegram sendDocument failed: ${(e as Error)?.message ?? e}`))
    }
    if (!res.ok) throw new Error(`telegram sendDocument -> ${res.status}`)
  }
}
