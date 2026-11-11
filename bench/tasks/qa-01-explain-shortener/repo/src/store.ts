import { existsSync, readFileSync, writeFileSync } from "node:fs"

const FLUSH_EVERY = 20

export class LinkStore {
  private links = new Map<string, string>()
  private counter = 1000
  private dirty = 0

  constructor(private file: string) {
    if (!existsSync(file)) return
    const saved = JSON.parse(readFileSync(file, "utf8"))
    this.links = new Map(Object.entries(saved.links))
    this.counter = saved.counter
  }

  nextId() {
    return ++this.counter
  }

  put(code: string, target: string) {
    this.links.set(code, target)
    if (++this.dirty >= FLUSH_EVERY) this.flush()
  }

  get(code: string) {
    return this.links.get(code)
  }

  flush() {
    writeFileSync(this.file, JSON.stringify({ counter: this.counter, links: Object.fromEntries(this.links) }))
    this.dirty = 0
  }
}
