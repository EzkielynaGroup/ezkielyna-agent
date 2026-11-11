// C3 `ezkielyna uninstall [--purge] [--yes]`: remove what install.sh / install.ps1 put on this computer, and nothing else.
//   - the install folder (~/.ezkielyna, or %LOCALAPPDATA%\Ezkielyna on Windows; EZK_INSTALL_DIR overrides)
//   - the PATH lines install.sh appended to the shell profiles (the "# Ezkielyna Agent" block), or the user PATH entry on Windows
//   - with --purge: ~/.config/ezkielyna, ~/.local/share/ezkielyna, ~/.local/state/ezkielyna, ~/.cache/ezkielyna and the key in the OS keychain
// macOS moves folders to ~/.Trash (they can be put back); Linux and Windows delete exactly the listed paths. Everything is planned first
// (pure, unit-tested), shown, confirmed, then executed. This file imports no global state: it must not create the folders it is about to remove.
import fs from "node:fs"
import path from "node:path"
import { detectLang, type Lang } from "@opencode-ai/core/ezkielyna-errors"

export type Platform = NodeJS.Platform

export type PlanItem =
  | { kind: "dir"; path: string; what: string; purge: boolean }
  | { kind: "profile"; path: string; what: string; after: string; removed: string[] }
  | { kind: "winpath"; entry: string; what: string }
  | { kind: "keychain"; what: string }

export type Plan = {
  platform: Platform
  /** macOS only: folders are moved here instead of being deleted */
  trashDir?: string
  installDir: string
  items: PlanItem[]
  /** things that are left alone on purpose, said out loud */
  notes: string[]
}

export type PlanInput = {
  platform: Platform
  home: string
  env: Record<string, string | undefined>
  purge: boolean
  lang?: Lang
  /** injected for tests */
  exists?: (file: string) => boolean
  read?: (file: string) => string | undefined
}

const defaultExists = (file: string) => {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}
const defaultRead = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const PROFILES = [".zshrc", ".bashrc", ".bash_profile", ".profile"]
const MARK = "# Ezkielyna Agent"

export function installDirOf(input: Pick<PlanInput, "platform" | "home" | "env">) {
  const custom = input.env.EZK_INSTALL_DIR?.trim()
  if (custom) return path.resolve(custom)
  if (input.platform === "win32") return path.join(input.env.LOCALAPPDATA?.trim() || path.join(input.home, "AppData", "Local"), "Ezkielyna")
  return path.join(input.home, ".ezkielyna")
}

/** The folders --purge removes: the four XDG folders of the app (same defaults as xdg-basedir), each named "ezkielyna". */
export function purgeDirsOf(input: Pick<PlanInput, "home" | "env">) {
  const abs = (value: string | undefined) => (value && path.isAbsolute(value) ? value : undefined)
  const { home, env } = input
  return [
    path.join(abs(env.XDG_CONFIG_HOME) ?? path.join(home, ".config"), "ezkielyna"),
    path.join(abs(env.XDG_DATA_HOME) ?? path.join(home, ".local", "share"), "ezkielyna"),
    path.join(abs(env.XDG_STATE_HOME) ?? path.join(home, ".local", "state"), "ezkielyna"),
    path.join(abs(env.XDG_CACHE_HOME) ?? path.join(home, ".cache"), "ezkielyna"),
  ]
}

/** Never delete the root, the home folder or one of its parents, whatever EZK_INSTALL_DIR says. */
export function safeToRemove(dir: string, home: string): boolean {
  const target = path.resolve(dir)
  const base = path.resolve(home)
  if (target === path.parse(target).root || target === base) return false
  const rel = path.relative(target, base)
  return !(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) // not an ancestor of home
}

/** Remove the "# Ezkielyna Agent" + `export PATH=".../.ezkielyna/bin:$PATH"` pair install.sh appended (and the blank line it printed before). */
export function stripInstallerBlock(text: string, binDir: string): { text: string; removed: string[] } {
  const escaped = binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const exportLine = new RegExp(`^export PATH="(?:${escaped}|\\$HOME/\\.ezkielyna/bin|~/\\.ezkielyna/bin):\\$PATH"\\s*$`)
  const lines = text.split("\n")
  const out: string[] = []
  const removed: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.replace(/\r$/, "").trim() === MARK && exportLine.test((lines[i + 1] ?? "").replace(/\r$/, ""))) {
      removed.push(line.trim(), lines[i + 1]!.trim())
      if (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop() // the blank line before the block
      i++
      continue
    }
    out.push(line)
  }
  return { text: out.join("\n"), removed }
}

/** `;`-separated Windows PATH without the install bin folder (case-insensitive, trailing backslash ignored). */
export function removeFromWindowsPath(value: string, binDir: string): { value: string; removed: boolean } {
  const norm = (entry: string) => entry.trim().replace(/[\\/]+$/, "").toLowerCase()
  const parts = value.split(";").filter(Boolean)
  const kept = parts.filter((entry) => norm(entry) !== norm(binDir))
  return { value: kept.join(";"), removed: kept.length !== parts.length }
}

const T = {
  en: {
    program: "the program and its saved versions",
    profile: (n: number) => `the ${n} PATH line(s) the installer added`,
    winpath: "the entry in your user PATH",
    config: "settings",
    data: "sign-in, sessions and saved data",
    state: "state",
    cache: "cache",
    keychain: "the API key saved in the system keychain",
    notInstalled: (dir: string) => `No Ezkielyna Agent install found at ${dir}.`,
    unsafe: (dir: string) => `Refusing to remove ${dir}: it is your home folder, a parent of it, or the root.`,
    foreignPath: (file: string) => `${file} has a PATH line for Ezkielyna that the installer did not add; remove it yourself if you want.`,
    keep: "Your settings, sign-in and sessions are kept. Add --purge to delete them too.",
  },
  id: {
    program: "program dan versi tersimpannya",
    profile: (n: number) => `${n} baris PATH yang ditambahkan installer`,
    winpath: "entri di PATH pengguna Anda",
    config: "pengaturan",
    data: "data masuk, sesi, dan data tersimpan",
    state: "status",
    cache: "cache",
    keychain: "kunci API yang tersimpan di keychain sistem",
    notInstalled: (dir: string) => `Instalasi Ezkielyna Agent tidak ditemukan di ${dir}.`,
    unsafe: (dir: string) => `Menolak menghapus ${dir}: itu folder home Anda, induknya, atau root.`,
    foreignPath: (file: string) => `${file} punya baris PATH untuk Ezkielyna yang tidak ditambahkan installer; hapus sendiri jika mau.`,
    keep: "Pengaturan, data masuk, dan sesi Anda dibiarkan. Tambahkan --purge untuk menghapusnya juga.",
  },
}

export function planUninstall(input: PlanInput): Plan {
  const lang = input.lang ?? detectLang(input.env)
  const t = T[lang]
  const exists = input.exists ?? defaultExists
  const read = input.read ?? defaultRead
  const installDir = installDirOf(input)
  const binDir = path.join(installDir, "bin")
  const plan: Plan = {
    platform: input.platform,
    installDir,
    items: [],
    notes: [],
    ...(input.platform === "darwin" ? { trashDir: path.join(input.home, ".Trash") } : {}),
  }

  const looksInstalled = ["bin", "versions", "current"].some((name) => exists(path.join(installDir, name)))
  if (!safeToRemove(installDir, input.home)) plan.notes.push(t.unsafe(installDir))
  else if (!looksInstalled) plan.notes.push(t.notInstalled(installDir))
  else plan.items.push({ kind: "dir", path: installDir, what: t.program, purge: false })

  if (input.platform === "win32") {
    if (looksInstalled && safeToRemove(installDir, input.home)) plan.items.push({ kind: "winpath", entry: binDir, what: t.winpath })
  } else {
    for (const name of PROFILES) {
      const file = path.join(input.home, name)
      const text = read(file)
      if (text === undefined) continue
      const stripped = stripInstallerBlock(text, binDir)
      if (stripped.removed.length) plan.items.push({ kind: "profile", path: file, what: t.profile(stripped.removed.length / 2), after: stripped.text, removed: stripped.removed })
      else if (/\.ezkielyna\/bin/.test(text) || text.includes(binDir)) plan.notes.push(t.foreignPath(file))
    }
  }

  if (input.purge) {
    const [config, data, state, cache] = purgeDirsOf(input)
    for (const [dir, what] of [[config, t.config], [data, t.data], [state, t.state], [cache, t.cache]] as const) {
      if (path.basename(dir!) === "ezkielyna" && exists(dir!) && safeToRemove(dir!, input.home)) plan.items.push({ kind: "dir", path: dir!, what, purge: true })
    }
    plan.items.push({ kind: "keychain", what: t.keychain })
  } else if (plan.items.length) plan.notes.push(t.keep)
  return plan
}

export function describePlan(plan: Plan, lang: Lang = "en"): string {
  const how = plan.trashDir ? (lang === "id" ? "dipindah ke Tempat Sampah" : "moved to the Trash") : lang === "id" ? "dihapus" : "deleted"
  const lines = [lang === "id" ? "Ezkielyna Agent akan menghapus:" : "Ezkielyna Agent will remove:"]
  for (const item of plan.items) {
    if (item.kind === "dir") lines.push(`  ${item.path}  (${item.what}; ${how})`)
    else if (item.kind === "profile") lines.push(`  ${item.path}  (${item.what}: ${item.removed.filter((x) => x.startsWith("export")).join(" ")})`)
    else if (item.kind === "winpath") lines.push(`  ${item.entry}  (${item.what})`)
    else lines.push(`  ${item.what}`)
  }
  for (const note of plan.notes) lines.push(note)
  return lines.join("\n")
}

export type Deps = {
  /** macOS: move to the Trash. Returns the new location. */
  trash?: (from: string, trashDir: string) => string
  remove?: (dir: string) => void
  writeFile?: (file: string, text: string) => void
  deleteSecret?: () => void
  /** Windows: read/write the user PATH (PowerShell) */
  readUserPath?: () => string
  writeUserPath?: (value: string) => void
  /** Windows: remove the install folder after this process has exited (a running .exe cannot delete itself) */
  removeAfterExit?: (dir: string) => void
  log: (line: string) => void
}

export function moveToTrash(from: string, trashDir: string): string {
  fs.mkdirSync(trashDir, { recursive: true })
  const base = path.basename(from).replace(/^\./, "") || "ezkielyna"
  let target = path.join(trashDir, base)
  for (let n = 2; fs.existsSync(target); n++) target = path.join(trashDir, `${base} ${n}`)
  fs.renameSync(from, target)
  return target
}

/** Executes the plan item by item; one failure is reported and does not stop the rest. Returns the number of failures. */
export function executePlan(plan: Plan, deps: Deps, lang: Lang = "en"): number {
  let failures = 0
  const say = (en: string, id: string) => deps.log(lang === "id" ? id : en)
  const attempt = (label: string, fn: () => void) => {
    try {
      fn()
    } catch (error) {
      failures++
      say(`Could not remove ${label}: ${(error as Error).message}`, `Gagal menghapus ${label}: ${(error as Error).message}`)
    }
  }
  for (const item of plan.items) {
    if (item.kind === "dir") {
      attempt(item.path, () => {
        if (plan.trashDir) {
          const moved = (deps.trash ?? moveToTrash)(item.path, plan.trashDir)
          say(`Moved to the Trash: ${item.path} (now ${moved})`, `Dipindah ke Tempat Sampah: ${item.path} (sekarang ${moved})`)
        } else if (plan.platform === "win32" && deps.removeAfterExit && item.path === plan.installDir) {
          deps.removeAfterExit(item.path)
          say(`Will be deleted when this command ends: ${item.path}`, `Akan dihapus setelah perintah ini selesai: ${item.path}`)
        } else {
          ;(deps.remove ?? ((dir: string) => fs.rmSync(dir, { recursive: true, force: true })))(item.path)
          say(`Deleted: ${item.path}`, `Dihapus: ${item.path}`)
        }
      })
    } else if (item.kind === "profile") {
      attempt(item.path, () => {
        ;(deps.writeFile ?? ((file: string, text: string) => fs.writeFileSync(file, text)))(item.path, item.after)
        say(`Removed the PATH lines from ${item.path}`, `Baris PATH dihapus dari ${item.path}`)
      })
    } else if (item.kind === "winpath") {
      attempt("the user PATH entry", () => {
        if (!deps.readUserPath || !deps.writeUserPath) throw new Error("PowerShell is not available")
        const next = removeFromWindowsPath(deps.readUserPath(), item.entry)
        if (next.removed) deps.writeUserPath(next.value)
        say(next.removed ? `Removed ${item.entry} from your user PATH` : `${item.entry} was not in your user PATH`, next.removed ? `${item.entry} dihapus dari PATH pengguna` : `${item.entry} tidak ada di PATH pengguna`)
      })
    } else {
      attempt("the keychain entry", () => {
        deps.deleteSecret?.()
        say("Removed the API key from the system keychain (if there was one)", "Kunci API dihapus dari keychain sistem (jika ada)")
      })
    }
  }
  return failures
}
