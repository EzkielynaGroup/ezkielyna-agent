import { readJson, writeJson } from "./store"

export type Settings = { theme: "light" | "dark"; fontSize: number }
export const DEFAULTS: Settings = { theme: "light", fontSize: 14 }

export function loadSettings(file: string, cb: (err: Error | null, settings?: Settings) => void) {
  readJson(file, (err, value) => {
    if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return cb(null, { ...DEFAULTS })
    if (err) return cb(err)
    cb(null, { ...DEFAULTS, ...(value as Partial<Settings>) })
  })
}

export function saveSettings(file: string, settings: Settings, cb: (err: Error | null) => void) {
  writeJson(file, settings, (err) => cb(err))
}
