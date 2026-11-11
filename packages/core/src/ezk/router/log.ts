// Ezkielyna Agent v1.1: local-only router decision log (D9). Off unless `ezk.router.log` is true. Never uploaded.
// One JSON line per decision with features only (tier, score, model, lengths). Prompt text is stored only with
// `ezk.router.logPrompts`. Rotation: router.log.jsonl -> .1 -> .2 -> .3 at 1 MB, mode 0600.
import fs from "node:fs"
import path from "node:path"

export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_KEEP = 3

export interface LogRecord {
  ts: number
  session: string
  tier?: string
  score?: number
  model: string
  reason: string
  promptChars?: number
  prompt?: string
  /** later: user overrode the router (picked a concrete model right after an auto turn) */
  override?: string
  event?: "decision" | "fallback" | "escalation"
}

export class RouterLog {
  private file: string
  constructor(
    dir: string,
    private opts: { enabled: boolean; prompts?: boolean; maxBytes?: number } = { enabled: false },
  ) {
    this.file = path.join(dir, "ezk", "router.log.jsonl")
  }

  get path() {
    return this.file
  }

  write(rec: LogRecord) {
    if (!this.opts.enabled) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      this.rotate()
      const out = { ...rec }
      if (!this.opts.prompts) delete out.prompt
      fs.appendFileSync(this.file, JSON.stringify(out) + "\n", { mode: 0o600 })
    } catch {}
  }

  private rotate() {
    const max = this.opts.maxBytes ?? LOG_MAX_BYTES
    let size = 0
    try {
      size = fs.statSync(this.file).size
    } catch {
      return
    }
    if (size < max) return
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
      } catch {}
    }
    try {
      fs.renameSync(this.file, `${this.file}.1`)
    } catch {}
    try {
      fs.rmSync(`${this.file}.${LOG_KEEP + 1}`, { force: true })
    } catch {}
  }

  wipe() {
    for (const f of [this.file, ...Array.from({ length: LOG_KEEP + 1 }, (_, i) => `${this.file}.${i + 1}`)]) {
      try {
        fs.rmSync(f, { force: true })
      } catch {}
    }
  }
}
