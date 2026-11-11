import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSettings, saveSettings } from "./settings"
import { readJson, writeJson } from "./store"

const dir = () => mkdtempSync(path.join(tmpdir(), "settings-"))

test("round trip with promises", async () => {
  const file = path.join(dir(), "s.json")
  expect(await loadSettings(file)).toEqual({ theme: "light", fontSize: 14 })
  await saveSettings(file, { theme: "dark", fontSize: 16 })
  expect(await loadSettings(file)).toEqual({ theme: "dark", fontSize: 16 })
})

test("store helpers return promises and reject on bad json", async () => {
  const file = path.join(dir(), "x.json")
  await writeJson(file, { a: 1 })
  expect(await readJson(file)).toEqual({ a: 1 })
  writeFileSync(file, "{oops")
  await expect(readJson(file)).rejects.toThrow()
})
