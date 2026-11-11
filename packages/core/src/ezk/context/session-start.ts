// Ezkielyna Agent v3 (A9): session-start context, sent once as a reminder (not in the system prompt).
//   - depth-2 project tree, at most 40 lines, respecting .gitignore
//   - toolchain versions (node/bun/python/go/cargo + package manager), each probe has a 1 s timeout, cached per session
//   - the project verify command (package.json scripts, Makefile, pytest, cargo test, go test) -> `ezk.verify`
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"

export const TREE_MAX_LINES = 40
export const PROBE_TIMEOUT_MS = 1000

export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string | undefined>

export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve(undefined)
        resolve((stdout || stderr || "").toString())
      })
    } catch {
      resolve(undefined)
    }
  })

// ---------- tree ----------

const ALWAYS_IGNORED = new Set([".git", "node_modules", ".DS_Store", "dist", "build", "target", "__pycache__", ".venv", "venv", ".next", ".turbo", ".cache", "coverage", ".idea", ".vscode"])

/** Tiny .gitignore reader: plain names and `dir/` patterns at any depth, `/name` anchored at root. Enough for a tree. */
export function readIgnore(dir: string): { names: Set<string>; anchored: Set<string>; globs: RegExp[] } {
  const names = new Set<string>()
  const anchored = new Set<string>()
  const globs: RegExp[] = []
  let text = ""
  try {
    text = fs.readFileSync(path.join(dir, ".gitignore"), "utf8")
  } catch {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith("!")) continue
    const clean = line.replace(/\/$/, "")
    if (clean.startsWith("/")) {
      anchored.add(clean.slice(1))
    } else if (/[*?[]/.test(clean)) {
      const re = clean.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")
      try {
        globs.push(new RegExp(`^${re}$`))
      } catch {}
    } else if (!clean.includes("/")) names.add(clean)
    else anchored.add(clean)
  }
  return { names, anchored, globs }
}

function listDir(dir: string): { name: string; dir: boolean }[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }))
  } catch {
    return []
  }
}

export function buildTree(root: string, maxLines = TREE_MAX_LINES): string {
  const ig = readIgnore(root)
  const ignored = (rel: string, name: string) =>
    ALWAYS_IGNORED.has(name) || ig.names.has(name) || ig.anchored.has(rel) || ig.globs.some((g) => g.test(name))
  const sortEntries = (list: { name: string; dir: boolean }[]) =>
    list.toSorted((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  const top = sortEntries(listDir(root).filter((e) => !ignored(e.name, e.name)))
  if (!top.length) return ""
  const lines: string[] = []
  const childBudget = Math.max(0, maxLines - top.length)
  const perDir = Math.min(6, Math.max(2, Math.floor(childBudget / Math.max(1, top.filter((e) => e.dir).length))))
  let used = top.length
  for (const e of top) {
    lines.push(e.dir ? `${e.name}/` : e.name)
    if (!e.dir || used >= maxLines) continue
    const kids = sortEntries(listDir(path.join(root, e.name)).filter((k) => !ignored(`${e.name}/${k.name}`, k.name)))
    const room = Math.min(perDir, maxLines - used)
    for (const k of kids.slice(0, room)) {
      lines.push(`  ${k.name}${k.dir ? "/" : ""}`)
      used++
    }
    if (kids.length > room && used < maxLines) {
      lines.push(`  … +${kids.length - room} more`)
      used++
    }
  }
  const out = lines.slice(0, maxLines)
  if (lines.length > maxLines) out[maxLines - 1] = `… (${lines.length - maxLines + 1} more lines)`
  return out.join("\n")
}

// ---------- toolchain ----------

export interface Toolchain {
  node?: string
  bun?: string
  python?: string
  go?: string
  cargo?: string
  packageManager?: { name: string; version?: string }
}

const firstVersion = (s: string | undefined) => s?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0]

export function detectPackageManager(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager?: string }
    const named = pkg.packageManager?.split("@")[0]
    if (named) return named
  } catch {}
  const has = (f: string) => fs.existsSync(path.join(root, f))
  if (has("bun.lock") || has("bun.lockb")) return "bun"
  if (has("pnpm-lock.yaml")) return "pnpm"
  if (has("yarn.lock")) return "yarn"
  if (has("package-lock.json")) return "npm"
  if (has("package.json")) return "npm"
  if (has("uv.lock")) return "uv"
  if (has("poetry.lock")) return "poetry"
  if (has("Cargo.lock") || has("Cargo.toml")) return "cargo"
  return undefined
}

const cache = new Map<string, Promise<Toolchain>>()
const MAX_CACHE = 200

/** Cached per session id (or per directory when no session id is known). */
export function detectToolchain(root: string, opts: { sessionID?: string; exec?: Exec; trusted?: boolean; platform?: NodeJS.Platform } = {}): Promise<Toolchain> {
  const key = `${opts.sessionID ?? ""}\0${root}\0${opts.trusted ? "t" : "u"}`
  const hit = cache.get(key)
  if (hit) return hit
  const exec = opts.exec ?? defaultExec
  // Never run a tool inside the repo unless the folder is trusted: version managers and `yarnPath` (.yarnrc.yml) load
  // repo-controlled code. Plain `--version` probes run from the temp folder; the package-manager probe needs trust.
  const probe = (cmd: string, args: string[], inRepo = false) =>
    exec(cmd, args, { cwd: inRepo ? root : os.tmpdir(), timeoutMs: PROBE_TIMEOUT_MS }).then(firstVersion)
  const pmName = detectPackageManager(root)
  const win = (opts.platform ?? process.platform) === "win32"
  // On Windows `npm`, `pnpm` and `yarn` are .cmd shims that execFile cannot start (and a shell would run repo-chosen text),
  // and Python is `python`, not `python3`. A missing version is simply left out of the context.
  const shim = win && ["npm", "pnpm", "yarn", "npx"].includes(pmName ?? "")
  const job = (async (): Promise<Toolchain> => {
    const [node, bun, python, go, cargo, pm] = await Promise.all([
      probe("node", ["--version"]),
      probe("bun", ["--version"]),
      probe(win ? "python" : "python3", ["--version"]),
      probe("go", ["version"]),
      probe("cargo", ["--version"]),
      pmName && !shim && opts.trusted === true && !["node", "bun", "cargo"].includes(pmName) ? probe(pmName, ["--version"], true) : Promise.resolve(undefined),
    ])
    const pmVersion = pmName === "bun" ? bun : pmName === "cargo" ? cargo : pm
    return { node, bun, python, go, cargo, ...(pmName ? { packageManager: { name: pmName, version: pmVersion } } : {}) }
  })()
  cache.set(key, job)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
  return job
}

export function resetSessionStartCache() {
  cache.clear()
  verifyCache.clear()
}

// ---------- verify ----------

export interface VerifyStep {
  kind: "test" | "typecheck" | "lint"
  command: string
}
export interface Verify {
  source: "package.json" | "Makefile" | "pytest" | "cargo" | "go"
  steps: VerifyStep[]
  /** All steps joined with " && ", cheapest first (typecheck, lint, test). */
  command: string
}

const verifyCache = new Map<string, Verify | null>()

function runner(pm: string | undefined, script: string) {
  const name = pm ?? "npm"
  if (script === "test") return name === "yarn" ? "yarn test" : `${name} test`
  return name === "yarn" ? `yarn ${script}` : `${name} run ${script}`
}

function make(source: Verify["source"], steps: VerifyStep[]): Verify | undefined {
  if (!steps.length) return undefined
  const order = { typecheck: 0, lint: 1, test: 2 } as const
  const sorted = steps.toSorted((a, b) => order[a.kind] - order[b.kind])
  return { source, steps: sorted, command: sorted.map((s) => s.command).join(" && ") }
}

export function detectVerify(root: string): Verify | undefined {
  const cached = verifyCache.get(root)
  if (cached !== undefined) return cached ?? undefined
  const found = detectVerifyUncached(root)
  verifyCache.set(root, found ?? null)
  return found
}

function detectVerifyUncached(root: string): Verify | undefined {
  const exists = (f: string) => fs.existsSync(path.join(root, f))
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8")
    } catch {
      return ""
    }
  }
  if (exists("package.json")) {
    try {
      const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const pm = detectPackageManager(root)
      const pick = (names: string[]) => names.find((n) => typeof scripts[n] === "string" && scripts[n]!.trim())
      const steps: VerifyStep[] = []
      const test = pick(["test", "test:unit"])
      // `echo "Error: no test specified" && exit 1` is the npm init placeholder, not a test
      if (test && !/no test specified/.test(scripts[test]!)) steps.push({ kind: "test", command: runner(pm, test) })
      const tc = pick(["typecheck", "type-check", "check-types", "tsc"])
      if (tc) steps.push({ kind: "typecheck", command: runner(pm, tc) })
      const lint = pick(["lint"])
      if (lint) steps.push({ kind: "lint", command: runner(pm, lint) })
      const v = make("package.json", steps)
      if (v) return v
    } catch {}
  }
  if (exists("Makefile")) {
    const mk = read("Makefile")
    const target = (n: string) => new RegExp(`^${n}\\s*:`, "m").test(mk)
    const steps: VerifyStep[] = []
    if (target("test")) steps.push({ kind: "test", command: "make test" })
    else if (target("check")) steps.push({ kind: "test", command: "make check" })
    if (target("lint")) steps.push({ kind: "lint", command: "make lint" })
    const v = make("Makefile", steps)
    if (v) return v
  }
  if (exists("Cargo.toml")) return make("cargo", [{ kind: "test", command: "cargo test" }])
  const hasPytest =
    exists("pytest.ini") ||
    exists("conftest.py") ||
    /\[tool\.pytest/.test(read("pyproject.toml")) ||
    /\[tool:pytest\]|\[pytest\]/.test(read("setup.cfg") + read("tox.ini"))
  if (hasPytest) return make("pytest", [{ kind: "test", command: "pytest -q" }])
  if (exists("go.mod")) return make("go", [{ kind: "test", command: "go test ./..." }])
  return undefined
}

// ---------- reminder ----------

export function formatToolchain(t: Toolchain): string {
  const parts: string[] = []
  for (const k of ["node", "bun", "python", "go", "cargo"] as const) if (t[k]) parts.push(`${k} ${t[k]}`)
  if (t.packageManager) parts.push(`package manager: ${t.packageManager.name}${t.packageManager.version ? ` ${t.packageManager.version}` : ""}`)
  return parts.join(", ")
}

export async function buildSessionStart(root: string, opts: { sessionID?: string; exec?: Exec; trusted?: boolean } = {}): Promise<string | undefined> {
  const [tree, tools] = [buildTree(root), await detectToolchain(root, opts)]
  const verify = detectVerify(root)
  const sections: string[] = []
  if (tree) sections.push(`Project tree (depth 2, git-ignored paths hidden):\n${tree}`)
  const tc = formatToolchain(tools)
  if (tc) sections.push(`Toolchain: ${tc}`)
  if (verify) sections.push(`Verify command: ${verify.command}`)
  if (!sections.length) return undefined
  return ["<session_start_context>", ...sections, "</session_start_context>"].join("\n")
}
