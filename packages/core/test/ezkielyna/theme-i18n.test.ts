import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

// --- contrast ---------------------------------------------------------------------------------------------------
function lum(hex: string) {
  const h = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Tokens from the store's globals.css (the single source of truth for the brand)
const STORE = {
  light: { bg: "#faf8f4", soft: "#f5f0e8", card: "#f2ece3", border: "#e4dbcf", text: "#1f1a17", brand: "#c96f52", btn: "#b25e43", ink: "#9a4c33", ok: "#286a4e", warn: "#87530b", err: "#b23a3a", info: "#3d6a9a" },
  dark: { bg: "#141110", soft: "#1d1917", card: "#26211e", border: "#3a322d", text: "#f3eee9", brand: "#e08a6c", ink: "#f0a487" },
}

describe("TUI theme `ezkielyna`", () => {
  const theme = JSON.parse(read("tui/src/theme/assets/ezkielyna.json"))
  const color = (token: string, mode: "dark" | "light") => {
    const v = theme.theme[token][mode]
    return v.startsWith("#") ? v : theme.defs[v]
  }

  test("uses the store palette", () => {
    expect(color("background", "light")).toBe(STORE.light.bg)
    expect(color("backgroundPanel", "light")).toBe(STORE.light.soft)
    expect(color("backgroundElement", "light")).toBe(STORE.light.card)
    expect(color("text", "light")).toBe(STORE.light.text)
    expect(color("border", "light")).toBe(STORE.light.border)
    expect(color("accent", "light") === STORE.light.info || color("secondary", "light") === STORE.light.ink).toBe(true)
    expect(color("success", "light")).toBe(STORE.light.ok)
    expect(color("warning", "light")).toBe(STORE.light.warn)
    expect(color("error", "light")).toBe(STORE.light.err)
    expect(color("background", "dark")).toBe(STORE.dark.bg)
    expect(color("backgroundPanel", "dark")).toBe(STORE.dark.soft)
    expect(color("backgroundElement", "dark")).toBe(STORE.dark.card)
    expect(color("text", "dark")).toBe(STORE.dark.text)
    expect(color("primary", "dark")).toBe(STORE.dark.brand)
  })

  test("is complete: every token of the upstream default theme exists", () => {
    const upstream = JSON.parse(read("tui/src/theme/assets/opencode.json"))
    for (const token of Object.keys(upstream.theme)) expect(theme.theme[token]).toBeDefined()
  })

  for (const mode of ["dark", "light"] as const) {
    test(`text and accents are readable in ${mode} (WCAG AA 4.5:1 for text, 3:1 for UI)`, () => {
      for (const bg of ["background", "backgroundPanel", "backgroundElement"]) {
        for (const fg of ["text", "textMuted", "success", "warning", "error", "info", "primary", "markdownLink"]) {
          const r = ratio(color(fg, mode), color(bg, mode))
          // primary/markdownLink are accents (used for UI and short labels): 3:1; everything else is text: 4.5:1
          const min = fg === "primary" || fg === "markdownLink" ? 3 : 4.5
          expect(r, `${fg} on ${bg} (${mode}) = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(min)
        }
      }
    })
  }
})

describe("desktop theme (oc-2 re-skinned as Ezkielyna)", () => {
  const theme = JSON.parse(read("ui/src/theme/themes/oc-2.json"))
  test("named Ezkielyna with the store palette", () => {
    expect(theme.name).toBe("Ezkielyna")
    expect(theme.light.palette.neutral).toBe(STORE.light.bg)
    expect(theme.light.palette.ink).toBe(STORE.light.text)
    expect(theme.light.palette.primary).toBe(STORE.light.brand)
    expect(theme.light.palette.interactive).toBe(STORE.light.btn)
    expect(theme.dark.palette.neutral).toBe(STORE.dark.bg)
    expect(theme.dark.palette.ink).toBe(STORE.dark.text)
    expect(theme.dark.palette.primary).toBe(STORE.dark.brand)
  })
  test("v2 greys and brand ramp carry the store colours", () => {
    const light = theme.light.v2Overrides ?? {}
    const css = read("ui/src/v2/styles/colors.css")
    expect(css).toContain("--v2-grey-100: #faf8f4ff")
    expect(css).toContain("--v2-grey-1200: #141110ff")
    expect(css).toContain("--v2-blue-700: #b25e43ff") // primary-btn
    expect(css).toContain("--v2-blue-800: #9a4c33ff") // brand-ink
    expect(light).toBeDefined()
  })
  test("white text on the primary button passes AA", () => {
    expect(ratio("#ffffff", STORE.light.btn)).toBeGreaterThanOrEqual(4.5)
  })
  test("fonts are the store fonts, bundled locally with their licences", () => {
    const theme_css = read("ui/src/styles/theme.css")
    expect(theme_css).toContain('"Plus Jakarta Sans"')
    expect(theme_css).toContain('"Source Serif 4"')
    for (const f of ["PlusJakartaSans-VF.woff2", "SourceSerif4-VF.woff2", "OFL-PlusJakartaSans.txt", "OFL-SourceSerif4.txt"]) expect(fs.existsSync(path.join(root, "app/public/assets", f))).toBe(true)
    const index_css = read("app/src/index.css")
    expect(index_css).not.toMatch(/url\(["']?https?:/) // never load a font from the network
  })
})

describe("i18n completeness (ID/EN)", () => {
  const dict = (file: string) => {
    const out = new Map<string, string>()
    for (const m of read(file).matchAll(/^\s*"([^"]+)":\s*\n?\s*"((?:[^"\\]|\\.)*)",?$/gm)) out.set(m[1], m[2])
    return out
  }
  const en = dict("app/src/i18n/en.ts")
  const id = dict("app/src/i18n/id.ts")

  test("every ezk.* key exists in both languages", () => {
    const keys = [...en.keys()].filter((k) => k.startsWith("ezk."))
    expect(keys.length).toBeGreaterThan(30)
    for (const k of keys) expect(id.has(k), `id.ts is missing ${k}`).toBe(true)
    for (const k of [...id.keys()].filter((k) => k.startsWith("ezk."))) expect(en.has(k), `en.ts is missing ${k}`).toBe(true)
  })

  test("no leftover upstream hosts or products in user-visible strings", () => {
    const bad = /opencode\.ai|OpenCode Zen|OpenCode Go|anomalyco|discord\.gg|Claude, GPT, Gemini/i
    for (const [k, v] of en) if (!k.startsWith("dialog.provider.opencode") && !k.startsWith("provider.connect.opencodeZen")) expect(v, `${k}: ${v}`).not.toMatch(bad)
  })

  test("the Indonesian copy is actually translated for the home screen", () => {
    expect(id.get("ezk.home.headline")).toBe("Mau dikerjakan apa hari ini?")
    expect(id.get("ezk.home.headline")).not.toBe(en.get("ezk.home.headline"))
    expect(id.get("ezk.model.auto.hint")).toBe("memilih model terbaik otomatis")
  })
})
