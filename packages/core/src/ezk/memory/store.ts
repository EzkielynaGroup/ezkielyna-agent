// Ezkielyna Agent v1.1: curated memory files, one pair per profile.
//   <dir>/MEMORY.md  environment, projects, tool quirks    (<= 2,200 chars)
//   <dir>/USER.md    who the user is, preferences          (<= 1,375 chars)
// Entries are separated by "\n§\n" so the files stay readable and hand-editable. Local only, mode 0600 (dir 0700),
// atomic writes. Limits are hard: a write that does not fit is refused with a message the model can act on.
import fs from "node:fs"
import path from "node:path"
import { scanMemoryText } from "./scanner"

export type Kind = "memory" | "user"
export const LIMITS: Record<Kind, number> = { memory: 2200, user: 1375 }
export const FILES: Record<Kind, string> = { memory: "MEMORY.md", user: "USER.md" }
export const DELIM = "\n§\n"
export const MAX_ENTRY_CHARS = 400

export type Result = { ok: true; entries: string[]; chars: number; limit: number; note?: string } | { ok: false; error: string }

const clean = (s: string) => s.replace(/\s+/g, " ").trim()

export class MemoryStore {
  constructor(readonly dir: string) {}

  private file(kind: Kind) {
    return path.join(this.dir, FILES[kind])
  }

  load(kind: Kind): string[] {
    try {
      return fs
        .readFileSync(this.file(kind), "utf8")
        .split(DELIM)
        .map(clean)
        .filter(Boolean)
    } catch {
      return []
    }
  }

  chars(kind: Kind) {
    return this.load(kind).join(DELIM).length
  }

  private write(kind: Kind, entries: string[]) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file(kind)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, entries.join(DELIM) + (entries.length ? "\n" : ""), { mode: 0o600 })
    fs.renameSync(tmp, this.file(kind))
  }

  private ok(kind: Kind, entries: string[], note?: string): Result {
    return { ok: true, entries, chars: entries.join(DELIM).length, limit: LIMITS[kind], ...(note ? { note } : {}) }
  }

  add(kind: Kind, text: string): Result {
    const t = clean(text)
    if (!t) return { ok: false, error: "empty text" }
    if (t.length > MAX_ENTRY_CHARS) return { ok: false, error: `entry too long (${t.length} > ${MAX_ENTRY_CHARS} chars); shorten it` }
    const scan = scanMemoryText(t)
    if (!scan.ok) return { ok: false, error: scan.reason }
    const entries = this.load(kind)
    if (entries.some((e) => e.toLowerCase() === t.toLowerCase())) return this.ok(kind, entries, "already saved")
    const next = [...entries, t]
    const size = next.join(DELIM).length
    if (size > LIMITS[kind]) {
      return { ok: false, error: `${kind} memory is full (${entries.join(DELIM).length}/${LIMITS[kind]} chars); replace or remove an entry first` }
    }
    this.write(kind, next)
    return this.ok(kind, next)
  }

  private find(entries: string[], match: string): { index: number } | { error: string } {
    const m = clean(match).toLowerCase()
    if (!m) return { error: "match is empty" }
    const hits = entries.map((e, i) => (e.toLowerCase().includes(m) ? i : -1)).filter((i) => i >= 0)
    if (hits.length === 0) return { error: "no entry matches" }
    if (hits.length > 1) return { error: `${hits.length} entries match; use a longer, unique part of the entry` }
    return { index: hits[0]! }
  }

  replace(kind: Kind, match: string, text: string): Result {
    const t = clean(text)
    if (!t) return { ok: false, error: "empty text" }
    if (t.length > MAX_ENTRY_CHARS) return { ok: false, error: `entry too long (${t.length} > ${MAX_ENTRY_CHARS} chars); shorten it` }
    const scan = scanMemoryText(t)
    if (!scan.ok) return { ok: false, error: scan.reason }
    const entries = this.load(kind)
    const found = this.find(entries, match)
    if ("error" in found) return { ok: false, error: found.error }
    const next = entries.slice()
    next[found.index] = t
    if (next.join(DELIM).length > LIMITS[kind]) return { ok: false, error: `${kind} memory would exceed ${LIMITS[kind]} chars; shorten the entry or remove another` }
    this.write(kind, next)
    return this.ok(kind, next)
  }

  remove(kind: Kind, match: string): Result {
    const entries = this.load(kind)
    const found = this.find(entries, match)
    if ("error" in found) return { ok: false, error: found.error }
    const next = entries.filter((_, i) => i !== found.index)
    this.write(kind, next)
    return this.ok(kind, next)
  }

  /** Removes the whole memory directory (files, state). Returns the number of files deleted. */
  wipe(): number {
    let n = 0
    try {
      for (const f of fs.readdirSync(this.dir)) {
        fs.rmSync(path.join(this.dir, f), { force: true, recursive: true })
        n++
      }
      fs.rmdirSync(this.dir)
    } catch {}
    return n
  }
}
