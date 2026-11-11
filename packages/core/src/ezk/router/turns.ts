// Ezkielyna Agent v1.1: per-turn route records (what the UI shows as the "chosen model" badge).
// Local files only: <dataDir>/ezk/route-turns.jsonl (append-only, last record per messageID wins), mode 0600, rotated.
import fs from "node:fs"
import path from "node:path"
import type { RouteInfo, RouteTurn } from "../contracts"

export const TURNS_MAX_BYTES = 2 * 1024 * 1024

export class RouteTurns {
  private byMessage = new Map<string, RouteTurn>()
  private loaded = false
  private file: string

  constructor(dir: string) {
    this.file = path.join(dir, "ezk", "route-turns.jsonl")
  }

  private load() {
    if (this.loaded) return
    this.loaded = true
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line) continue
        try {
          const t = JSON.parse(line) as RouteTurn
          if (t.messageID && t.sessionID && t.route) this.byMessage.set(t.messageID, t)
        } catch {}
      }
    } catch {}
  }

  set(sessionID: string, messageID: string, route: RouteInfo) {
    this.load()
    const turn: RouteTurn = { sessionID, messageID, route }
    this.byMessage.set(messageID, turn)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      try {
        if (fs.statSync(this.file).size > TURNS_MAX_BYTES) this.compact()
      } catch {}
      fs.appendFileSync(this.file, JSON.stringify(turn) + "\n", { mode: 0o600 })
    } catch {}
  }

  /** Merge fields into an existing record (fallback / escalation updates). */
  update(messageID: string, patch: Partial<RouteInfo>) {
    this.load()
    const cur = this.byMessage.get(messageID)
    if (!cur) return
    this.set(cur.sessionID, messageID, { ...cur.route, ...patch })
  }

  get(messageID: string) {
    this.load()
    return this.byMessage.get(messageID)
  }

  forSession(sessionID: string): RouteTurn[] {
    this.load()
    return [...this.byMessage.values()].filter((t) => t.sessionID === sessionID)
  }

  /** Keep only the newest half of the records. */
  private compact() {
    const all = [...this.byMessage.values()]
    const keep = all.slice(Math.floor(all.length / 2))
    this.byMessage = new Map(keep.map((t) => [t.messageID, t]))
    fs.writeFileSync(this.file, keep.map((t) => JSON.stringify(t)).join("\n") + "\n", { mode: 0o600 })
  }

  wipe() {
    this.byMessage.clear()
    this.loaded = true
    try {
      fs.rmSync(this.file, { force: true })
    } catch {}
  }
}
