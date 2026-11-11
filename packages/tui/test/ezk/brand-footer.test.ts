// P2: the session footer printed "OpenCode <version>". The word was split over two <b> tags, so the text-level brand
// replacement (brandText) never saw it. Guard the sources: no split upstream name anywhere in the TUI, and the footers say Ezkielyna.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "../../src")

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []))
}

describe("brand in the TUI footers", () => {
  test("no source splits the upstream product name over several tags", () => {
    const offenders = walk(SRC).filter((file) => /<b>\s*Open\s*<\/b>|>Open<\/[a-z]+>\s*<[a-z]+[^>]*>\s*(<b>)?\s*Code\b/.test(fs.readFileSync(file, "utf8")))
    expect(offenders).toEqual([])
  })

  test("both session footers show Ezkielyna and the version", () => {
    for (const file of ["feature-plugins/sidebar/footer.tsx", "routes/session/sidebar.tsx"]) {
      const text = fs.readFileSync(path.join(SRC, file), "utf8")
      expect(text).toContain("<b>Ezkielyna</b>")
      expect(text).not.toMatch(/<b>Open<\/b>|<b>Code<\/b>/)
    }
  })
})
