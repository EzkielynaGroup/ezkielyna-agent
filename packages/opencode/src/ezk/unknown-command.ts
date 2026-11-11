// C2: `ezkielyna updgrade` used to be read as a folder to open ("Failed to change directory"). An argument that is neither a
// command nor an existing folder is a typo: say so, suggest the closest command, exit 2. Pure helpers; the CLI registers
// its command names once (cli-main.ts) and the default command (tui.ts) asks.
import fs from "node:fs"
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"

let known: readonly string[] = []

/** cli-main registers every top-level command name and alias (plus completion/help). */
export function registerCommandNames(names: readonly string[]) {
  known = names
}

export function commandNames() {
  return known
}

/** Command names (first word, aliases included) of yargs command modules. */
export function namesOf(commands: readonly { command?: unknown; aliases?: unknown }[]): string[] {
  const out = new Set<string>()
  for (const c of commands) {
    const raw = Array.isArray(c.command) ? c.command : [c.command]
    const aliases = Array.isArray(c.aliases) ? c.aliases : c.aliases ? [c.aliases] : []
    for (const item of [...raw, ...aliases]) {
      const word = String(item ?? "").trim().split(/\s+/)[0]
      if (word && word !== "$0" && !word.startsWith("[") && !word.startsWith("<")) out.add(word)
    }
  }
  return [...out]
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]!
}

/** The nearest command within a small distance (typos like updgrade, ugrade, docter), else undefined. */
export function closestCommand(input: string, names: readonly string[]): string | undefined {
  const word = input.toLowerCase()
  const limit = word.length <= 3 ? 1 : word.length <= 6 ? 2 : 3
  let best: { name: string; distance: number } | undefined
  for (const name of names) {
    const distance = editDistance(word, name.toLowerCase())
    if (distance <= limit && (!best || distance < best.distance)) best = { name, distance }
  }
  return best?.name
}

export function unknownCommandMessage(input: string, names: readonly string[] = known, lang: Lang = detectLang()): string {
  const near = closestCommand(input, names)
  return lang === "id"
    ? `Perintah "${input}" tidak dikenal.${near ? ` Maksud Anda "${near}"?` : ""} Jalankan ezkielyna --help`
    : `Unknown command "${input}".${near ? ` Did you mean "${near}"?` : ""} Run ezkielyna --help`
}

/** The positional of the default command is a folder to open only when it exists as one. */
export function isExistingFolder(resolved: string): boolean {
  try {
    return fs.statSync(resolved).isDirectory()
  } catch {
    return false
  }
}
