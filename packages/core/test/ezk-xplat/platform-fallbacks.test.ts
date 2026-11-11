import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../../")
const theme = fs.readFileSync(path.join(root, "packages/ui/src/styles/theme.css"), "utf8")
const appStyles = fs.readFileSync(path.join(root, "packages/app/src/index.css"), "utf8")

describe("platform fallbacks", () => {
  test("Linux has generic sans and monospace fallback families if bundled fonts fail", () => {
    expect(theme).toContain('"Helvetica Neue", Arial, sans-serif')
    expect(theme).toContain("ui-monospace, SFMono-Regular, Menlo, Consolas, monospace")
    expect(theme).toContain('"Source Serif 4", Georgia, serif')
  })

  test("bundled fonts use swap so system fonts remain visible while fonts load", () => {
    expect(appStyles.match(/font-display: swap;/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
