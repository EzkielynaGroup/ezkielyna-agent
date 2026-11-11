// C5: the first-run screens follow LANG / LC_ALL like doctor and account: id_* gives Indonesian, anything else English, and
// one language per label (no "Auto (Pintar)" in an English screen).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { EZK_AUTO_MODEL_NAME } from "@opencode-ai/core/ezk/contracts"
import { gettingStartedStrings, homeStrings, keyDialogStrings, tuiLang } from "../../src/ezk/locale"

const keep = { EZK_LANG: process.env.EZK_LANG, LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES, LANG: process.env.LANG }
afterEach(() => {
  for (const [k, v] of Object.entries(keep)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
function locale(value: string) {
  delete process.env.EZK_LANG
  delete process.env.LC_MESSAGES
  process.env.LC_ALL = value
  process.env.LANG = value
}

const INDONESIAN = /\b(kunci|Tanyakan|Jalankan|Perbaiki|Selamat|Masukkan|Mulai|Dapatkan|Pintar|Tempel|Masuk)\b/
const flat = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(flat)
      : typeof value === "function"
        ? [String((value as (x: string) => string)("https://x"))]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(flat)
          : []

describe("TUI locale (C5)", () => {
  test("LANG / LC_ALL id_* gives Indonesian, the same rule as doctor and account", () => {
    locale("id_ID.UTF-8")
    expect(tuiLang()).toBe("id")
    expect(homeStrings().ask).toBe("Tanyakan apa saja…")
    expect(homeStrings().run).toBe("Jalankan perintah…")
    expect(keyDialogStrings().title).toContain("Selamat datang")
    expect(keyDialogStrings().placeholder).toBe("Kunci API")
    locale("en_US.UTF-8")
    expect(tuiLang()).toBe("en")
    expect(homeStrings().ask).toBe("Ask anything…")
    expect(keyDialogStrings().title).toBe("Welcome to Ezkielyna Agent: enter your API key")
    expect(keyDialogStrings().placeholder).toBe("API key")
  })

  test("LC_ALL wins over LANG, EZK_LANG wins over both", () => {
    locale("en_US.UTF-8")
    process.env.LANG = "id_ID.UTF-8"
    expect(tuiLang()).toBe("en")
    process.env.EZK_LANG = "id"
    expect(tuiLang()).toBe("id")
  })

  test("an English screen has no Indonesian words and an Indonesian screen has no English leftovers", () => {
    for (const text of [...flat(homeStrings("en")), ...flat(keyDialogStrings("en")), ...flat(gettingStartedStrings("en"))]) expect(text).not.toMatch(INDONESIAN)
    const id = [...flat(homeStrings("id")), ...flat(keyDialogStrings("id")), ...flat(gettingStartedStrings("id"))].join("\n")
    for (const english of ["Ask anything", "Run a command", "Welcome", "Paste your", "Get a key", "Enter API key", "Getting started"]) expect(id).not.toContain(english)
  })

  test("the key dialog keeps the key URL and the sk- rule in both languages", () => {
    for (const lang of ["en", "id"] as const) {
      expect(keyDialogStrings(lang).paste).toContain("sk-")
      expect(keyDialogStrings(lang).invalid("https://api.ezkielyna.store/keys")).toContain("sk-")
      expect(keyDialogStrings(lang).invalid("https://api.ezkielyna.store/keys")).toContain("https://api.ezkielyna.store/keys")
      expect(gettingStartedStrings(lang).get).toContain("api.ezkielyna.store/keys")
    }
  })

  test("the Auto model has one name per language, never a mix", () => {
    expect(EZK_AUTO_MODEL_NAME.en).toBe("Auto (smart)")
    expect(EZK_AUTO_MODEL_NAME.id).toBe("Otomatis (Pintar)")
    expect(EZK_AUTO_MODEL_NAME.en).not.toMatch(INDONESIAN)
    expect(EZK_AUTO_MODEL_NAME.id).not.toContain("Auto")
  })

  test("the components use the table: no hard-coded English prompt, dialog title or label is left", () => {
    const SRC = path.join(import.meta.dir, "../../src")
    const read = (file: string) => fs.readFileSync(path.join(SRC, file), "utf8")
    expect(read("component/prompt/index.tsx")).not.toContain("`Ask anything…")
    expect(read("component/prompt/index.tsx")).not.toContain("`Run a command…")
    expect(read("component/dialog-provider.tsx")).not.toContain('title="Welcome to Ezkielyna Agent')
    expect(read("component/dialog-provider.tsx")).not.toContain("Paste your Ezkielyna API key")
    expect(read("routes/home.tsx")).not.toContain("Fix a TODO in the codebase")
    expect(read("ezk/commands.tsx")).not.toContain('title: "Auto model (Pintar)"')
  })
})
