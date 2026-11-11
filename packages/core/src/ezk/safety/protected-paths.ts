// Ezkielyna Agent: the ONE list of protected paths. Used by
//   - the file tools (edit/write/apply_patch) and the shell tool: a write or mention asks even when a rule or a mode would allow it,
//   - the permission modes (core/src/ezk/safety/decide.ts): "Edit otomatis" never auto-approves these,
//   - the OS sandbox (SANDBOX_READONLY_NAMES below): they stay read-only inside every writable root.
// Why these: each one is a place where a write turns into later code execution or a changed instruction without a further
// prompt (git hooks, our and Claude/Codex settings with hooks, MCP/formatter/plugin definitions in the project config, CI
// workflows, editor tasks, instruction files, credentials).
// Matching is lexical AND on the real path (a committed symlink `docs -> .git` is seen), case-insensitive on every
// platform (macOS and Windows volumes are case-insensitive), and measured from the project (worktree) root.
import fs from "node:fs"
import path from "node:path"

/** Directories, protected at any depth. */
export const PROTECTED_DIRS = new Set([
  ".git",
  ".ezkielyna",
  ".claude",
  ".codex",
  ".agents",
  ".aws",
  ".ssh",
  ".gnupg",
  ".opencode",
  ".husky",
  ".vscode",
  ".idea",
])

/** Files, protected at any depth (lower case; compared case-insensitively). `.env` and `.env.*` are handled separately. */
export const PROTECTED_FILES = new Set([
  ".mcp.json",
  ".npmrc",
  "ezkielyna.json",
  "ezkielyna.jsonc",
  "opencode.json",
  "opencode.jsonc",
  "agents.md",
  "claude.md",
])

/** Multi-segment paths (lower case). */
export const PROTECTED_SEQUENCES: readonly (readonly string[])[] = [[".github", "workflows"]]

/**
 * What the OS sandbox keeps read-only inside every writable root (names only, no paths): the entries above that give code
 * execution or credentials. Editor folders, `.npmrc` and the instruction files are left out because shell tools legitimately
 * create them; the file tools still ask for those.
 */
export const SANDBOX_READONLY_NAMES: readonly string[] = [
  ".git",
  ".ezkielyna",
  ".claude",
  ".codex",
  ".agents",
  ".ssh",
  ".aws",
  ".gnupg",
  ".opencode",
  ".husky",
  ".mcp.json",
  "ezkielyna.json",
  "ezkielyna.jsonc",
  "opencode.json",
  "opencode.jsonc",
]

const envFile = (name: string) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example")

/**
 * Windows resolves more spellings to one file than the lexical check sees: trailing dots and spaces (`.git. `), NTFS
 * streams (`.env::$DATA`) and 8.3 short names (`.git` is `GIT~1`, `.github` is `GITHUB~1`). Normalise those to the long name.
 */
const SHORT_PREFIXES = new Map<string, string>()
for (const name of [...PROTECTED_DIRS, ...PROTECTED_FILES, ".env"]) SHORT_PREFIXES.set(name.replace(/[. ]/g, "").slice(0, 6).toUpperCase(), name)
for (const [first] of PROTECTED_SEQUENCES) SHORT_PREFIXES.set(first!.replace(/[. ]/g, "").slice(0, 6).toUpperCase(), first!)

function windowsSpelling(segment: string) {
  const clean = segment.replace(/:.*$/, "").replace(/[. ]+$/, "")
  const short = /^([^~]{1,6})~\d+(\.[^.]{0,3})?$/.exec(clean)
  const long = short ? SHORT_PREFIXES.get(short[1]!.toUpperCase()) : undefined
  return long ?? clean
}

/** `rel` is relative to the project root (either slash style). */
export function isProtectedRelative(rel: string) {
  const segments = rel.split(/[\\/]+/).filter(Boolean).map((part) => windowsSpelling(part).toLowerCase())
  if (segments.some((part) => PROTECTED_DIRS.has(part) || PROTECTED_FILES.has(part) || envFile(part))) return true
  return PROTECTED_SEQUENCES.some((seq) =>
    segments.some((_, start) => seq.every((part, offset) => segments[start + offset] === part)),
  )
}

function windowsStyle(...values: string[]) {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\"))
}

/** realpath of the file, or of its nearest existing parent joined with the rest (new files do not exist yet). */
function realish(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    const parent = path.dirname(file)
    if (parent === file) return file
    return path.join(realish(parent), path.basename(file))
  }
}

function relativeInside(api: typeof path.posix, root: string, target: string) {
  const relative = api.relative(root, target).replaceAll("\\", "/")
  if (!relative || relative === ".." || relative.startsWith("../") || api.isAbsolute(relative)) return undefined
  return relative
}

/**
 * Lexical containment check with both POSIX and Windows path semantics, plus (on POSIX paths) the same check on the real
 * path so a symlink into a protected folder is caught. `projectRoot` should be the git worktree root when there is one.
 */
export function isProtectedPath(
  projectRoot: string,
  candidate: string,
  platform?: "win32" | "posix",
  /** real-path lookup, injectable so Windows junction handling is testable on any host */
  realOf?: (file: string) => string,
) {
  const win = platform === "win32" || (platform !== "posix" && windowsStyle(projectRoot, candidate))
  const api = win ? path.win32 : path.posix
  const root = api.resolve(projectRoot)
  const target = api.isAbsolute(candidate) ? api.resolve(candidate) : api.resolve(root, candidate)
  const lexical = relativeInside(api, root, target)
  if (lexical !== undefined && isProtectedRelative(lexical)) return true
  // a simulated Windows path on a POSIX host has no real file system to ask; real Windows follows junctions and symlinks too
  const lookup = realOf ?? (win && process.platform !== "win32" ? undefined : realish)
  if (!lookup) return false
  const real = relativeInside(api, lookup(root), lookup(target))
  return real !== undefined && isProtectedRelative(real)
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const BOUNDARY = "[\\\\/:.\"'`,;()\\s]"
const MENTION_NAMES = [
  ...[...PROTECTED_DIRS, ...PROTECTED_FILES, ...PROTECTED_SEQUENCES.map((seq) => seq.join("/"))].map(escapeRegex),
  `\\.env(?!\\.example(?:$|${BOUNDARY}))`, // .env and .env.* but not .env.example
]
const PROTECTED_SEGMENT = new RegExp(`(?:^|${BOUNDARY})(?:${MENTION_NAMES.join("|")})(?=$|${BOUNDARY})`, "i")

/** Conservative detector for shell redirect and command path tokens. */
export function protectedPathMentions(projectRoot: string, cwd: string, command: string, platform?: "win32" | "posix") {
  // Shell arguments may embed a path inside a script (for example, python -c "open('.git/config')").
  // Treat any explicit protected-segment mention conservatively; the shell's write intent is hard to parse.
  if (PROTECTED_SEGMENT.test(command)) return true
  const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s"'<>|;]+)/g) ?? []
  return tokens.some((token) => {
    const clean = token.replace(/^["'`]|["'`]$/g, "").replace(/^[0-9]*[<>]+/, "").replace(/[),;]+$/, "")
    if (!clean) return false
    const win = platform === "win32" || (platform !== "posix" && windowsStyle(projectRoot, cwd, clean))
    const api = win ? path.win32 : path.posix
    const resolved = api.isAbsolute(clean) ? clean : api.resolve(cwd, clean)
    return isProtectedPath(projectRoot, resolved, platform)
  })
}

/** The folder protected paths are measured from: the git worktree root when there is one, else the opened folder. */
export function protectedRoot(instance: { directory: string; worktree?: string }) {
  return instance.worktree && instance.worktree !== "/" ? instance.worktree : instance.directory
}
