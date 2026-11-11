// Monitor (T2): new lines of a background command started with monitor: true reach the model as a <system-reminder>
// text part on the latest user message, at the next provider turn. Cache rule (DESIGN-V3 §1.2): the system prompt is
// never touched, and every reminder already delivered is re-attached to the same message with the same bytes on
// later turns, so the history the gateway caches does not change behind it.
import type { ExecInfo } from "@opencode-ai/core/ezk/exec/manager"

/** lines kept per process between two deliveries (oldest dropped first) */
const MAX_PENDING_LINES = 200
/** lines shown per process in one reminder */
const MAX_SHOWN_LINES = 40
const MAX_LINE_CHARS = 500
/** user messages whose delivered reminders are remembered (re-attached on later turns) */
const MAX_MESSAGES = 500

type Pending = { id: string; command: string; lines: string[]; dropped: number; exit?: { status: string; code?: number } }

export type Part = { id: string; messageID: string; sessionID: string; type: string; text?: string; synthetic?: boolean }
export type Message = { info: { id: string; sessionID: string; role: string }; parts: Part[] }

export class MonitorInbox {
  private pending = new Map<string, Map<string, Pending>>()
  private delivered = new Map<string, Part[]>()

  constructor(private readonly newPartID: () => string) {}

  lines(info: ExecInfo, lines: string[]) {
    const item = this.slot(info)
    item.lines.push(...lines)
    const over = item.lines.length - MAX_PENDING_LINES
    if (over > 0) {
      item.lines.splice(0, over)
      item.dropped += over
    }
  }

  exited(info: ExecInfo) {
    if (!info.monitor) return
    this.slot(info).exit = { status: info.status, code: info.exitCode }
  }

  has(sessionID: string) {
    return (this.pending.get(sessionID)?.size ?? 0) > 0
  }

  forget(sessionID: string) {
    this.pending.delete(sessionID)
  }

  /** Re-attach earlier reminders, then deliver what is pending to the last user message. Returns delivered process ids. */
  inject(messages: Message[]) {
    for (const msg of messages) {
      const parts = this.delivered.get(msg.info.id)
      if (!parts) continue
      const have = new Set(msg.parts.map((part) => part.id))
      msg.parts.push(...parts.filter((part) => !have.has(part.id)))
    }
    const last = messages.findLast((msg) => msg.info.role === "user")
    if (!last) return []
    const pending = this.pending.get(last.info.sessionID)
    if (!pending?.size) return []
    this.pending.delete(last.info.sessionID)
    const part: Part = {
      id: this.newPartID(),
      messageID: last.info.id,
      sessionID: last.info.sessionID,
      type: "text",
      text: render([...pending.values()]),
      synthetic: true,
    }
    last.parts.push(part)
    this.delivered.set(last.info.id, [...(this.delivered.get(last.info.id) ?? []), part])
    while (this.delivered.size > MAX_MESSAGES) this.delivered.delete(this.delivered.keys().next().value!)
    return [...pending.keys()]
  }

  private slot(info: ExecInfo) {
    const bySession = this.pending.get(info.owner) ?? new Map<string, Pending>()
    this.pending.set(info.owner, bySession)
    const item = bySession.get(info.id) ?? { id: info.id, command: info.command, lines: [], dropped: 0 }
    bySession.set(info.id, item)
    return item
  }
}

export function render(items: Pending[]) {
  const blocks = items.map((item) => {
    const hidden = item.dropped + Math.max(0, item.lines.length - MAX_SHOWN_LINES)
    const shown = item.lines.slice(-MAX_SHOWN_LINES).map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line))
    return [
      `Background command ${item.id} (\`${item.command}\`)${shown.length ? " printed:" : ""}`,
      ...shown,
      ...(hidden ? [`(${hidden} earlier lines not shown; write_stdin with session_id "${item.id}" reads the output)`] : []),
      ...(item.exit ? [`It has ${item.exit.status === "killed" ? "been stopped" : "exited"} with code ${item.exit.code ?? "?"}.`] : []),
    ].join("\n")
  })
  return `<system-reminder>\n${blocks.join("\n\n")}\n</system-reminder>`
}
