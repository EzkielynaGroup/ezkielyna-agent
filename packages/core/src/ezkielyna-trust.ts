// Ezkielyna Agent: project trust. Opening a folder that someone else wrote must not be able to run code, widen
// permissions or redirect the user's API key just because the folder contains a config file. An untrusted project can
// still set harmless preferences (model, instructions, theme ...); everything else in its config, and its whole
// `.ezkielyna/` directory (plugins, custom tools, agents, commands), is ignored until the user runs `ezkielyna trust`.
import fs from "node:fs"
import path from "node:path"

/** Keys an untrusted project config may keep. Everything else is dropped (allow-list, so new upstream keys stay off by default). */
export const SAFE_PROJECT_KEYS = ["$schema", "model", "small_model", "default_agent", "theme", "snapshot", "compaction", "username", "logLevel"] as const

/**
 * `instructions` entries pull files into the system prompt, which then goes to the gateway: only plain relative paths that stay inside the
 * project count. `~/...`, absolute paths, `..` segments and URLs (fetched when the folder opens) are dropped.
 */
export function safeInstructionEntry(entry: unknown): boolean {
  if (typeof entry !== "string" || entry.trim() === "") return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry)) return false // http(s):, file:, C:\ ...
  if (entry.startsWith("~") || entry.startsWith("/") || entry.startsWith("\\")) return false
  return !entry.split(/[\\/]+/).includes("..")
}

export function filterUntrustedConfig<T extends Record<string, unknown>>(config: T): { config: Partial<T>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if ((SAFE_PROJECT_KEYS as readonly string[]).includes(key)) kept[key] = value
    else if (key === "instructions" && Array.isArray(value)) {
      const ok = value.filter(safeInstructionEntry)
      if (ok.length) kept[key] = ok
      if (ok.length !== value.length) dropped.push("instructions (unsafe entries)")
    } else dropped.push(key)
  }
  return { config: kept as Partial<T>, dropped }
}

type Options = { env?: Record<string, string | undefined>; file: string }

function readList(file: string): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"))
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

const within = (dir: string, root: string) => {
  const rel = path.relative(root, dir)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function isProjectTrusted(projectDir: string, opts: Options): boolean {
  if ((opts.env ?? process.env).EZK_TRUST_PROJECT === "1") return true
  const real = (() => {
    try {
      return fs.realpathSync(projectDir)
    } catch {
      return path.resolve(projectDir)
    }
  })()
  return readList(opts.file).some((root) => within(real, root))
}

export function trustProject(projectDir: string, opts: Options): string {
  const real = fs.realpathSync(projectDir)
  const list = readList(opts.file)
  if (!list.includes(real)) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true })
    fs.writeFileSync(opts.file, JSON.stringify([...list, real], null, 2) + "\n", { mode: 0o600 })
  }
  return real
}

export function untrustProject(projectDir: string, opts: Options): boolean {
  const real = fs.realpathSync(projectDir)
  const list = readList(opts.file)
  if (!list.includes(real)) return false
  fs.writeFileSync(opts.file, JSON.stringify(list.filter((x) => x !== real), null, 2) + "\n", { mode: 0o600 })
  return true
}

/** Remove an exact entry from the trusted list (also works for a folder that was deleted or moved). */
export function forgetTrustedEntry(entry: string, opts: Options): boolean {
  const list = readList(opts.file)
  if (!list.includes(entry)) return false
  fs.writeFileSync(opts.file, JSON.stringify(list.filter((x) => x !== entry), null, 2) + "\n", { mode: 0o600 })
  return true
}
