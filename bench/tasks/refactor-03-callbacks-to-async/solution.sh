cat > src/store.ts <<'EOF'
import { readFile, writeFile } from "node:fs/promises"

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"))
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(data, null, 2))
}
EOF
cat > src/settings.ts <<'EOF'
import { readJson, writeJson } from "./store"

export type Settings = { theme: "light" | "dark"; fontSize: number }
export const DEFAULTS: Settings = { theme: "light", fontSize: 14 }

export async function loadSettings(file: string): Promise<Settings> {
  const value = await readJson(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return {}
    throw err
  })
  return { ...DEFAULTS, ...(value as Partial<Settings>) }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await writeJson(file, settings)
}
EOF
cat > src/settings.test.ts <<'EOF'
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadSettings, saveSettings } from "./settings"

test("round trip", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "settings-")), "s.json")
  expect(await loadSettings(file)).toEqual({ theme: "light", fontSize: 14 })
  await saveSettings(file, { theme: "dark", fontSize: 16 })
  expect(await loadSettings(file)).toEqual({ theme: "dark", fontSize: 16 })
})
EOF
