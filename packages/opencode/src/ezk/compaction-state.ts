import fs from "node:fs"
import path from "node:path"

export type CompactionState = { failures: number; beforeTokens: number; afterTokens: number; updatedAt: number }

/** Persistent per-session guard against repeated automatic compaction that does not shrink the request. */
export class CompactionStateStore {
  constructor(readonly file: string) {}

  private read(): Record<string, CompactionState> {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, CompactionState>
      if (!value || typeof value !== "object" || Array.isArray(value)) return {}
      return value
    } catch {
      return {}
    }
  }

  get(sessionID: string): CompactionState | undefined {
    if (!/^[\w-]{1,128}$/.test(sessionID)) return
    const value = this.read()[sessionID]
    if (!value || !Number.isInteger(value.failures) || value.failures < 0) return
    return value
  }

  blocked(sessionID: string) {
    return (this.get(sessionID)?.failures ?? 0) >= 3
  }

  record(sessionID: string, input: { beforeTokens: number; afterTokens: number; ineffective: boolean }) {
    if (!/^[\w-]{1,128}$/.test(sessionID)) return undefined
    const values = this.read()
    const failures = input.ineffective ? (values[sessionID]?.failures ?? 0) + 1 : 0
    const next: CompactionState = {
      failures,
      beforeTokens: input.beforeTokens,
      afterTokens: input.afterTokens,
      updatedAt: Date.now(),
    }
    values[sessionID] = next
    const keep = Object.entries(values)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 300)
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    return next
  }

  clear(sessionID: string) {
    if (!/^[\w-]{1,128}$/.test(sessionID)) return
    const values = this.read()
    if (!values[sessionID]) return
    delete values[sessionID]
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(values), { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }
}
