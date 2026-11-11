// Session spend ledger for the Auto router. Append-only updates survive process restarts and are idempotent by message id.
import fs from "node:fs"
import path from "node:path"

const MAX_BYTES = 4 * 1024 * 1024

export class SessionCosts {
  private loaded = false
  private sessions = new Map<string, Map<string, number>>()

  constructor(private file: string) {}

  private load() {
    if (this.loaded) return
    this.loaded = true
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue
        try {
          const row = JSON.parse(line) as { sessionID?: unknown; messageID?: unknown; usd?: unknown }
          if (typeof row.sessionID !== "string" || typeof row.messageID !== "string" || typeof row.usd !== "number" || !Number.isFinite(row.usd) || row.usd < 0) continue
          let messages = this.sessions.get(row.sessionID)
          if (!messages) this.sessions.set(row.sessionID, (messages = new Map()))
          messages.set(row.messageID, row.usd)
        } catch {}
      }
    } catch {}
  }

  forSession(sessionID: string): Array<[messageID: string, usd: number]> {
    this.load()
    return [...(this.sessions.get(sessionID)?.entries() ?? [])]
  }

  setMessageCost(sessionID: string, messageID: string, usd: number) {
    if (!Number.isFinite(usd) || usd < 0) return
    this.load()
    let messages = this.sessions.get(sessionID)
    if (!messages) this.sessions.set(sessionID, (messages = new Map()))
    if (messages.get(messageID) === usd) return
    messages.set(messageID, usd)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.appendFileSync(this.file, JSON.stringify({ sessionID, messageID, usd }) + "\n", { mode: 0o600 })
      fs.chmodSync(this.file, 0o600)
      if (fs.statSync(this.file).size > MAX_BYTES) this.compact()
    } catch {}
  }

  private compact() {
    const content = [...this.sessions].flatMap(([sessionID, messages]) =>
      [...messages].map(([messageID, usd]) => JSON.stringify({ sessionID, messageID, usd })),
    ).join("\n")
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, content ? `${content}\n` : "", { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
