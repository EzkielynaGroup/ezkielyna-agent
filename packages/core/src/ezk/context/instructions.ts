// Ezkielyna Agent v3 (C1): instruction hierarchy. Pure logic over an injected file system and path flavour, so every
// rule is unit-testable (including Windows paths) without touching the disk.
//
// Order (later = more specific = closer to the model's attention):
//   1. user       <userDir>/AGENTS.override.md, else AGENTS.md (+ CLAUDE.md); <home>/.claude/CLAUDE.md; <userDir>/rules/*.md
//   2. project    for every folder from the project root down to the cwd: AGENTS.override.md, else AGENTS.md + CLAUDE.md
//                 (+ <dir>/.ezkielyna/rules/*.md and <dir>/.claude/rules/*.md)
//   3. local      for every folder root -> cwd: AGENTS.local.md, CLAUDE.local.md (personal, normally git-ignored)
// Rules:
//   - `@path` imports, depth <= 4, only inside the project root or the user config dir, cycles ignored.
//   - rules/*.md may carry `paths:` globs in front-matter; those apply only when a matching file is in play.
//   - HTML comments are stripped (maintainer notes cost tokens and are not for the model).
//   - total output is capped at 32 KiB with a visible truncation note.
//   - when the folder is not trusted every project-level file (levels 2 and 3, project rules, project imports) is skipped.
import fs from "node:fs"
import nodePath from "node:path"
import { createHash } from "node:crypto"
import { isProtectedRelative } from "../safety/protected-paths"

export const MAX_INSTRUCTION_BYTES = 32 * 1024
export const MAX_IMPORT_DEPTH = 4

export type PathLib = Pick<typeof nodePath.posix, "join" | "resolve" | "dirname" | "relative" | "isAbsolute" | "sep" | "normalize">

export interface FsLike {
  /** UTF-8 content of a regular file, or undefined when it is missing/unreadable. */
  read(file: string): string | undefined
  /** Names (not paths) of the entries of a directory, or []. */
  list(dir: string): string[]
  /** Real path (symlinks resolved); identity when it cannot be resolved. */
  real(file: string): string
}

export const nodeFs: FsLike = {
  read(file) {
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || st.size > 4 * MAX_INSTRUCTION_BYTES) return undefined
      return fs.readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  },
  list(dir) {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
  real(file) {
    try {
      return fs.realpathSync(file)
    } catch {
      return file
    }
  },
}

export type Scope = "user" | "project" | "local" | "rule" | "import"

export interface InstructionFile {
  path: string
  scope: Scope
  content: string
}

export interface DiscoverOptions {
  /** Working directory of the session. */
  cwd: string
  /** Project root (git worktree). When cwd is outside it, only cwd is read. */
  root: string
  /** User config dir, e.g. ~/.config/ezkielyna. */
  userDir: string
  /** User home (for ~/.claude/CLAUDE.md and `~/` imports). Optional. */
  home?: string
  /** False = skip every project-level file. */
  trusted: boolean
  fs?: FsLike
  path?: PathLib
  maxBytes?: number
}

export interface Discovered {
  files: InstructionFile[]
  /** Final text parts, ready for the system prompt ("Instructions from: <path>\n<content>"). */
  parts: string[]
  truncated: boolean
  /** Project-level files that were not read because the folder is untrusted. */
  skippedUntrusted: boolean
}

/** Remove `<!-- ... -->` (outside fenced code). An unterminated opener is left alone. */
export function stripHtmlComments(text: string): string {
  const lines = text.split("\n")
  let fence = false
  const segments: string[] = []
  let buf: string[] = []
  const flush = () => {
    if (!buf.length) return
    const chunk = buf.join("\n")
    segments.push(fence ? chunk : chunk.replace(/<!--[\s\S]*?-->/g, ""))
    buf = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence) {
        buf.push(line)
        flush()
        fence = false
        continue
      }
      flush()
      fence = true
      buf.push(line)
      continue
    }
    buf.push(line)
  }
  flush()
  return segments.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Parse the tiny front-matter we need: `paths:` as inline list, quoted string or `- item` list. */
export function parseFrontMatter(text: string): { paths?: string[]; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { body: text }
  const body = text.slice(m[0].length)
  const lines = m[1]!.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^paths\s*:/.test(l))
  if (idx < 0) return { body }
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "")
  const rest = lines[idx]!.replace(/^paths\s*:/, "").trim()
  let paths: string[] = []
  if (rest.startsWith("[")) {
    paths = rest.replace(/^\[|\]$/g, "").split(",").map(clean)
  } else if (rest) {
    paths = rest.split(",").map(clean)
  } else {
    for (const l of lines.slice(idx + 1)) {
      const item = l.match(/^\s*-\s+(.*)$/)
      if (!item) {
        if (l.trim() === "") continue
        break
      }
      paths.push(clean(item[1]!))
    }
  }
  paths = paths.filter(Boolean)
  return { paths: paths.length ? paths : undefined, body }
}

/** Glob -> RegExp over "/"-separated relative paths. Supports **, *, ?, {a,b}. A pattern without "/" matches at any depth. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "")
  const anyDepth = !g.includes("/")
  let out = ""
  let braces = 0
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++
        if (g[i + 1] === "/") {
          i++
          out += "(?:.*/)?"
        } else out += ".*"
      } else out += "[^/]*"
    } else if (c === "?") out += "[^/]"
    else if (c === "{") {
      braces++
      out += "(?:"
    } else if (c === "}" && braces > 0) {
      braces--
      out += ")"
    } else if (c === "," && braces > 0) out += "|"
    else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&")
  }
  while (braces-- > 0) out += ")"
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${out}$`)
}

export function matchesAny(globs: string[], relativePath: string): boolean {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
  return globs.some((g) => globToRegExp(g).test(rel))
}

const within = (p: PathLib, dir: string, file: string) => {
  const rel = p.relative(dir, file)
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel))
}

class Reader {
  readonly fs: FsLike
  readonly p: PathLib
  readonly home?: string
  /** total bytes inlined through `@imports`; fan-out stops at the output cap */
  importedBytes = 0
  readonly seen = new Set<string>()
  readonly hashes = new Set<string>()
  constructor(
    readonly o: DiscoverOptions,
    readonly roots: { project: string; user: string },
  ) {
    this.fs = o.fs ?? nodeFs
    this.p = o.path ?? nodePath
    this.home = o.home
  }

  /** Read one file, strip comments, resolve imports. `scope` decides which roots imports may use. */
  load(file: string, scope: Scope, depth = 0): string | undefined {
    const key = this.fs.real(this.p.resolve(file))
    if (depth === 0 && this.seen.has(key)) return undefined
    const raw = this.fs.read(file)
    if (raw === undefined) return undefined
    // a symlinked instruction file may not point outside the allowed roots
    const roots = this.allowedRoots(scope)
    const realFile = this.fs.real(this.p.resolve(file))
    if (realFile !== this.p.resolve(file) && !roots.some((r) => within(this.p, r, realFile) || within(this.p, this.fs.real(r), realFile))) return undefined
    let text = stripHtmlComments(raw)
    if (!text) return undefined
    text = this.inlineImports(text, file, scope, depth, new Set([key]))
    return text
  }

  allowedRoots(scope: Scope): string[] {
    // project instructions may only import from the project; the user folder holds provider settings and secrets
    return scope === "user" ? [this.roots.user] : [this.roots.project]
  }

  /** Imports inline instruction text only: markdown/text files that are neither protected nor secret-looking. */
  private importable(file: string, roots: string[]): boolean {
    if (!/\.(md|mdc|txt)$/i.test(file)) return false
    if (/^(\.env|\.npmrc|\.netrc|id_(rsa|dsa|ed25519|ecdsa)|credentials|secrets?)/i.test((file.split(/[\\/]/).pop() ?? ""))) return false
    const root = roots.find((r) => within(this.p, r, file) || within(this.p, this.fs.real(r), file))
    if (!root) return false
    const base = within(this.p, root, file) ? root : this.fs.real(root)
    return !isProtectedRelative(this.p.relative(base, file))
  }

  private resolveImport(token: string, from: string, scope: Scope): string | undefined {
    let target = token
    if (target.startsWith("~/") || target.startsWith("~\\")) {
      if (!this.home) return undefined
      target = this.p.join(this.home, target.slice(2))
    } else if (!this.p.isAbsolute(target)) {
      target = this.p.resolve(this.p.dirname(from), target)
    } else target = this.p.resolve(target)
    const realTarget = this.fs.real(target)
    const roots = this.allowedRoots(scope)
    const ok = (t: string) => roots.some((r) => within(this.p, r, t) || within(this.p, this.fs.real(r), t))
    // lexical AND real path must stay inside (a symlink may not smuggle a file in)
    if (!(ok(target) && ok(realTarget))) return undefined
    return this.importable(target, roots) && this.importable(realTarget, roots) ? target : undefined
  }

  inlineImports(text: string, from: string, scope: Scope, depth: number, stack: Set<string>): string {
    if (depth >= MAX_IMPORT_DEPTH) return text
    const lines = text.split("\n")
    let fence = false
    const out: string[] = []
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence
        out.push(line)
        continue
      }
      if (fence) {
        out.push(line)
        continue
      }
      // split on inline code so `@x` inside backticks is left alone
      const pieces = line.split(/(`[^`]*`)/)
      const rebuilt = pieces.map((piece) => {
        if (piece.startsWith("`")) return piece
        return piece.replace(/(^|\s)@([^\s]+)/g, (whole, lead: string, token: string) => {
          const trimmed = token.replace(/[.,;:!?)]+$/, "")
          const trailing = token.slice(trimmed.length)
          if (!/[./\\~]/.test(trimmed)) return whole // @mention, not a path
          const target = this.resolveImport(trimmed, from, scope)
          if (!target) return whole
          const key = this.fs.real(target)
          if (stack.has(key)) return whole
          const raw = this.fs.read(target)
          if (raw === undefined) return whole
          this.importedBytes += raw.length
          if (this.importedBytes > (this.o.maxBytes ?? MAX_INSTRUCTION_BYTES)) return whole
          const next = new Set(stack).add(key)
          const body = this.inlineImports(stripHtmlComments(raw), target, scope, depth + 1, next)
          if (!body) return whole
          return `${lead}${trimmed}${trailing}\n[imported from ${trimmed}]\n${body}\n[end import]`
        })
      })
      out.push(rebuilt.join(""))
    }
    return out.join("\n")
  }

  names(dir: string): string[] {
    return this.fs.list(dir)
  }
}

function folderChain(p: PathLib, root: string, cwd: string): string[] {
  const r = p.resolve(root)
  const c = p.resolve(cwd)
  if (!within(p, r, c)) return [c]
  const rel = p.relative(r, c)
  const chain = [r]
  if (rel) {
    let cur = r
    for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
      cur = p.join(cur, seg)
      chain.push(cur)
    }
  }
  return chain
}

/** Instruction files of one folder: override wins, otherwise AGENTS.md then CLAUDE.md (identical content is read once). */
function folderFiles(r: Reader, dir: string, names: string[]): string[] {
  const has = new Set(r.names(dir))
  const override = names.find((n) => /\.override\.md$/.test(n))
  if (override && has.has(override)) return [r.p.join(dir, override)]
  return names.filter((n) => !/\.override\.md$/.test(n) && has.has(n)).map((n) => r.p.join(dir, n))
}

function ruleFiles(r: Reader, dir: string): string[] {
  return r
    .names(dir)
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort()
    .map((n) => r.p.join(dir, n))
}

export interface RuleInfo {
  path: string
  scope: "user" | "project"
  /** undefined = always on */
  globs?: string[]
  body: string
}

function collectRules(r: Reader, o: DiscoverOptions, userDir: string): RuleInfo[] {
  const rules: RuleInfo[] = []
  const add = (file: string, scope: "user" | "project") => {
    const raw = r.fs.read(file)
    if (raw === undefined) return
    const fm = parseFrontMatter(raw)
    const bodyText = stripHtmlComments(fm.body)
    if (!bodyText) return
    // imports resolve relative to the rule file; re-run the shared import pass on the stripped body
    const loaded = r.inlineImports(bodyText, file, scope, 0, new Set([r.fs.real(file)]))
    rules.push({ path: file, scope, globs: fm.paths, body: loaded })
  }
  for (const f of ruleFiles(r, r.p.join(userDir, "rules"))) add(f, "user")
  if (o.trusted) {
    for (const dir of folderChain(r.p, o.root, o.cwd)) {
      for (const sub of [".ezkielyna/rules", ".claude/rules"]) for (const f of ruleFiles(r, r.p.join(dir, sub))) add(f, "project")
    }
  }
  return rules
}

export function discoverInstructions(o: DiscoverOptions): Discovered {
  const p = o.path ?? nodePath
  const reader = new Reader(o, { project: p.resolve(o.root), user: p.resolve(o.userDir) })
  const files: InstructionFile[] = []
  const push = (file: string, scope: Scope) => {
    const content = reader.load(file, scope)
    if (!content) return
    const hash = createHash("sha256").update(content).digest("hex")
    if (reader.hashes.has(hash)) return // AGENTS.md symlinked/duplicated as CLAUDE.md
    reader.hashes.add(hash)
    reader.seen.add(reader.fs.real(p.resolve(file)))
    files.push({ path: p.resolve(file), scope, content })
  }

  // 1. user
  for (const f of folderFiles(reader, o.userDir, ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"])) push(f, "user")
  if (o.home) push(p.join(o.home, ".claude", "CLAUDE.md"), "user")

  const rules = collectRules(reader, o, o.userDir)
  for (const rule of rules.filter((x) => !x.globs && x.scope === "user"))
    files.push({ path: p.resolve(rule.path), scope: "rule", content: rule.body })

  // 2 + 3. project and local
  if (o.trusted) {
    const chain = folderChain(p, o.root, o.cwd)
    for (const dir of chain) for (const f of folderFiles(reader, dir, ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"])) push(f, "project")
    for (const rule of rules.filter((x) => !x.globs && x.scope === "project"))
      files.push({ path: p.resolve(rule.path), scope: "rule", content: rule.body })
    for (const dir of chain) for (const f of folderFiles(reader, dir, ["AGENTS.local.md", "CLAUDE.local.md"])) push(f, "local")
  }

  const cap = o.maxBytes ?? MAX_INSTRUCTION_BYTES
  const parts: string[] = []
  let used = 0
  let truncated = false
  let omitted = 0
  const enc = new TextEncoder()
  for (const f of files) {
    const part = `Instructions from: ${f.path}\n${f.content}`
    const size = enc.encode(part).length + 2
    if (truncated) {
      omitted++
      continue
    }
    if (used + size <= cap) {
      parts.push(part)
      used += size
      continue
    }
    truncated = true
    const room = cap - used - 200
    if (room > 200) {
      let cut = part.slice(0, room)
      while (enc.encode(cut).length > room) cut = cut.slice(0, -64)
      parts.push(`${cut}\n[truncated]`)
    } else omitted++
  }
  if (truncated) {
    parts.push(
      `[ezkielyna: instructions truncated at ${Math.round(cap / 1024)} KiB${omitted ? `; ${omitted} more file(s) not included` : ""}. Shorten AGENTS.md or move details into rules/*.md or on-demand files.]`,
    )
  }
  return { files, parts, truncated, skippedUntrusted: !o.trusted }
}

/**
 * Path-scoped rules that apply because `file` is in play (read/edited). Rules without `paths:` are already part of the
 * session text and are not returned here. `file` may be absolute or relative to the root.
 */
export function rulesForFile(o: DiscoverOptions, file: string): InstructionFile[] {
  const p = o.path ?? nodePath
  const reader = new Reader(o, { project: p.resolve(o.root), user: p.resolve(o.userDir) })
  const abs = p.isAbsolute(file) ? p.resolve(file) : p.resolve(o.root, file)
  const rel = p.relative(p.resolve(o.root), abs)
  if (rel.startsWith("..") || p.isAbsolute(rel)) return []
  return collectRules(reader, o, o.userDir)
    .filter((r) => r.globs && matchesAny(r.globs, rel))
    .map((r) => ({ path: p.resolve(r.path), scope: "rule" as const, content: r.body }))
}
