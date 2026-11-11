import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSettings, saveSettings } from "./settings"

test("round trip with callbacks", (done) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "settings-")), "s.json")
  loadSettings(file, (err, initial) => {
    expect(err).toBeNull()
    expect(initial).toEqual({ theme: "light", fontSize: 14 })
    saveSettings(file, { theme: "dark", fontSize: 16 }, (saveErr) => {
      expect(saveErr).toBeNull()
      loadSettings(file, (_, loaded) => {
        expect(loaded).toEqual({ theme: "dark", fontSize: 16 })
        done()
      })
    })
  })
})
