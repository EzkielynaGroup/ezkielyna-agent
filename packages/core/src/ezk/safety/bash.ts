// Ezkielyna Agent Wave B (S2): shell command analysis for remembered rules and the read-only list.
// Fail-closed: anything this small parser does not fully understand (substitutions, variables, heredocs, unbalanced
// quotes, file-writing redirects) can never be allowed by a rule or by the read-only list; it simply asks.
import path from "node:path"

export interface Segment {
  /** normalised text: raw tokens joined by one space, redirects removed */
  text: string
  tokens: string[]
  /** contains `$…`, backticks, `<(…)`, a heredoc or a glob-free expansion the matcher cannot see through */
  dynamic: boolean
  /** writes to a file through `>`, `>>`, `&>` (`2>&1` and `/dev/null` do not count) */
  writes: boolean
}

export type Split = { ok: true; segments: Segment[] } | { ok: false; reason: string }

const SEPARATORS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n"]

/** Split a command line into independent simple commands: `a && b; c | d $(e)` gives a, b, c, d and e. */
export function splitCommand(input: string): Split {
  const segments: Segment[] = []
  const pending: { text: string; depth: number }[] = []
  const result = scan(input, segments, pending, 0)
  if (!result.ok) return result
  while (pending.length) {
    const next = pending.shift()!
    if (next.depth > 8) return { ok: false, reason: "nesting too deep" }
    const inner = scan(next.text, segments, pending, next.depth)
    if (!inner.ok) return inner
  }
  return { ok: true, segments }
}

function scan(input: string, out: Segment[], pending: { text: string; depth: number }[], depth: number) {
  let tokens: string[] = []
  let token = ""
  let started = false
  let dynamic = false
  let writes = false
  let redirect: string | undefined
  const flushToken = () => {
    if (!started) return
    if (redirect !== undefined) {
      if (redirect.startsWith(">") || redirect.startsWith("&>") || /^\d>/.test(redirect)) {
        if (!(token === "/dev/null" || /^&\d$/.test(token))) writes = true
      }
      redirect = undefined
    } else tokens.push(token)
    token = ""
    started = false
  }
  const flushSegment = () => {
    flushToken()
    if (redirect !== undefined) return false
    const words = tokens.filter((t) => t !== "(" && t !== ")" && t !== "{" && t !== "}")
    if (words.length) out.push({ text: words.join(" "), tokens: words, dynamic, writes })
    tokens = []
    dynamic = false
    writes = false
    return true
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === "\\") {
      if (i + 1 >= input.length) return { ok: false as const, reason: "trailing backslash" }
      if (input[i + 1] === "\n") {
        i++
        continue
      }
      token += c + input[i + 1]
      started = true
      i++
      continue
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return { ok: false as const, reason: "unbalanced quote" }
      token += input.slice(i, end + 1)
      started = true
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < input.length && input[j] !== '"'; j++) {
        if (input[j] === "\\") {
          j++
          continue
        }
        if (input[j] === "$" || input[j] === "`") dynamic = true
        if (input[j] === "$" && input[j + 1] === "(") {
          const close = matchParen(input, j + 1)
          if (close === -1) return { ok: false as const, reason: "unbalanced substitution" }
          pending.push({ text: input.slice(j + 2, close), depth: depth + 1 })
          j = close
        }
      }
      if (j >= input.length) return { ok: false as const, reason: "unbalanced quote" }
      token += input.slice(i, j + 1)
      started = true
      i = j
      continue
    }
    if (c === "`") {
      const end = input.indexOf("`", i + 1)
      if (end === -1) return { ok: false as const, reason: "unbalanced backtick" }
      pending.push({ text: input.slice(i + 1, end), depth: depth + 1 })
      dynamic = true
      token += input.slice(i, end + 1)
      started = true
      i = end
      continue
    }
    if (c === "$" || ((c === "<" || c === ">") && input[i + 1] === "(")) {
      dynamic = true
      const open = i + 1
      if (input[open] === "(") {
        const close = matchParen(input, open)
        if (close === -1) return { ok: false as const, reason: "unbalanced substitution" }
        pending.push({ text: input.slice(open + (input[open + 1] === "(" ? 2 : 1), close), depth: depth + 1 })
        token += input.slice(i, close + 1)
        started = true
        i = close
        continue
      }
      token += c
      started = true
      continue
    }
    if (c === "#" && !started) {
      const end = input.indexOf("\n", i)
      if (end === -1) break
      i = end - 1
      continue
    }
    const op = SEPARATORS.find((s) => input.startsWith(s, i))
    if (op && !(op === "&" && (input[i + 1] === ">" || token.endsWith(">")))) {
      if (!flushSegment()) return { ok: false as const, reason: "redirect without target" }
      i += op.length - 1
      continue
    }
    if (c === "(" || c === ")") {
      if (!flushSegment()) return { ok: false as const, reason: "redirect without target" }
      continue
    }
    if (c === "<" && input[i + 1] === "<") return { ok: false as const, reason: "heredoc" }
    if (c === ">" || c === "<" || (c === "&" && input[i + 1] === ">")) {
      const fd = /^\d$/.test(token) && started ? token : ""
      if (fd) {
        token = ""
        started = false
      } else flushToken()
      let j = i
      let op = fd
      while (j < input.length && /[<>&|]/.test(input[j]!)) op += input[j++]
      if (/^\d?>&\d?$/.test(op) && /\d/.test(input[j] ?? "")) {
        // `2>&1`: the target is the next digit
        redirect = op
        token = "&" + input[j]!
        started = true
        i = j
        continue
      }
      redirect = op
      i = j - 1
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushToken()
      continue
    }
    token += c
    started = true
  }
  if (!flushSegment()) return { ok: false as const, reason: "redirect without target" }
  return { ok: true as const }
}

function matchParen(input: string, open: number) {
  let depth = 0
  let quote: string | undefined
  for (let i = open; i < input.length; i++) {
    const c = input[i]!
    if (quote) {
      if (c === "\\" && quote === '"') i++
      else if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === "\\") i++
    else if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i
  }
  return -1
}

/** Environment names that change what a command does; an assignment to one of these is never unwrapped. */
const DANGEROUS_ENV = /^(PATH|LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|BUN_\w*|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|GIT_\w*|SHELL|BASH_ENV|ENV|PROMPT_COMMAND|IFS|HOME|npm_config_\w*)$/i

const WRAPPERS = new Set(["env", "timeout", "nice", "nohup", "time", "npx", "bunx"])

/**
 * The command as written, then each form with one wrapper removed (`timeout 5 npx vitest run` gives
 * `timeout 5 npx vitest run`, `npx vitest run`, `vitest run`). `undefined` when a wrapper cannot be parsed safely.
 */
export function unwrapLayers(tokens: string[]): string[][] | undefined {
  const layers = [tokens]
  let rest = tokens
  for (let guard = 0; guard < 8; guard++) {
    const next = unwrapOnce(rest)
    if (next === undefined) return
    if (next === rest) return layers
    if (!next.length) return
    layers.push(next)
    rest = next
  }
  return
}

function unwrapOnce(tokens: string[]): string[] | undefined {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
    if (DANGEROUS_ENV.test(tokens[i]!.split("=")[0]!)) return
    i++
  }
  if (i > 0) return tokens.slice(i)
  const head = tokens[0]
  if (!head || !WRAPPERS.has(head)) return tokens
  const args = tokens.slice(1)
  if (head === "env") {
    let j = 0
    for (; j < args.length; j++) {
      const a = args[j]!
      if (a === "-i" || a === "--ignore-environment" || a === "-") continue
      if (a === "-u" || a === "--unset") {
        j++
        continue
      }
      if (a.startsWith("-")) return
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        if (DANGEROUS_ENV.test(a.split("=")[0]!)) return
        continue
      }
      break
    }
    return args.slice(j)
  }
  if (head === "timeout") {
    let j = 0
    for (; j < args.length && args[j]!.startsWith("-"); j++) {
      if (args[j] === "-s" || args[j] === "-k" || args[j] === "--signal" || args[j] === "--kill-after") j++
    }
    if (!/^\d+(\.\d+)?[smhd]?$/.test(args[j] ?? "")) return
    return args.slice(j + 1)
  }
  if (head === "nice") {
    if (args[0] === "-n") return /^-?\d+$/.test(args[1] ?? "") ? args.slice(2) : undefined
    if (/^-\d+$/.test(args[0] ?? "")) return args.slice(1)
    return args
  }
  if (head === "nohup" || head === "time") return args
  // npx / bunx: drop their own flags (`-y`, `--yes`, `--bun`); a `--package=x` or `-p x` form changes what runs, so stop.
  let j = 0
  for (; j < args.length && args[j]!.startsWith("-"); j++) {
    if (!["-y", "--yes", "--bun", "--no-install", "-q", "--quiet", "--silent"].includes(args[j]!)) return
  }
  return args.slice(j)
}

// --- rule matching ------------------------------------------------------------------------------------------------

/**
 * Claude-style bash rule pattern: `*` matches anything; a trailing ` *` also matches no arguments (`git log *` covers
 * `git log`); the space is significant (`ls *` does not cover `lsof`, `ls*` does); `:*` is an alias of ` *`.
 */
export function bashPatternRegex(pattern: string) {
  const p = pattern.trim().replace(/:\*$/, " *")
  const trailing = p.endsWith(" *")
  const body = trailing ? p.slice(0, -2) : p
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}${trailing ? "( .*)?" : ""}$`, "s")
}

/** Literal words of a pattern before its first wildcard (`npx vitest *` gives `npx vitest`). */
function literalWords(pattern: string) {
  const p = pattern.trim().replace(/:\*$/, " *")
  const star = p.indexOf("*")
  const literal = star === -1 ? p : p.slice(0, star)
  const words = literal.split(/\s+/).filter(Boolean)
  // a word cut by the star (`ls*`) is only a prefix, not a full word
  if (star !== -1 && star > 0 && !/\s$/.test(literal)) words.pop()
  return words
}

/** How many leading tokens are wrappers (and their arguments) before the real command of this layer. */
function wrapperHead(layer: string[]) {
  const next = unwrapOnce(layer)
  if (next === undefined || next === layer) return 1
  return layer.length - next.length + 1
}

/**
 * Does an allow rule approve this segment? It must match one unwrapped layer, and its literal words must cover that
 * layer's wrappers plus the real command, so `timeout *` or `npx *` never approve whatever they wrap.
 */
export function allowMatches(pattern: string, segment: Segment) {
  if (segment.dynamic || segment.writes) return false
  const layers = unwrapLayers(segment.tokens)
  if (!layers) return false
  const regex = bashPatternRegex(pattern)
  const words = literalWords(pattern)
  if (pattern.trim() === "*") return true
  return layers.some((layer) => {
    if (!regex.test(layer.join(" "))) return false
    const head = wrapperHead(layer)
    return words.length >= head && layer.slice(0, head).every((t, i) => words[i] === t)
  })
}

/** Shell words that only introduce a command (`then rm x`, `command rm x`); dropped before deny/ask matching. */
const LEADING_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time", "command", "builtin", "exec", "coproc", "{", "}"])

/** What the shell sees after quote removal: `r''m`, `'rm'`, `"rm"` and `\rm` all become `rm`. Best effort, never expands. */
export function unquoteToken(token: string) {
  let out = ""
  for (let i = 0; i < token.length; i++) {
    const c = token[i]!
    if (c === "\\") {
      if (i + 1 < token.length) out += token[++i]
    } else if (c === "'") {
      const end = token.indexOf("'", i + 1)
      if (end === -1) out += token.slice(i + 1)
      else out += token.slice(i + 1, end)
      i = end === -1 ? token.length : end
    } else if (c === '"') {
      let j = i + 1
      for (; j < token.length && token[j] !== '"'; j++) {
        if (token[j] === "\\" && j + 1 < token.length) j++
        out += token[j]
      }
      i = j
    } else out += c
  }
  return out
}

const GIT_PAIR_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"])

/** Drops leading shell keywords (and `command -p` style flags), and git's global options before the subcommand. */
function cleanHead(tokens: string[]) {
  let rest = tokens
  for (let guard = 0; guard < 16; guard++) {
    const head = rest[0]
    if (head !== undefined && LEADING_KEYWORDS.has(head)) {
      rest = rest.slice(1)
      if (head === "command" || head === "builtin" || head === "exec") while (rest[0]?.startsWith("-") && rest[0] !== "--") rest = rest.slice(1)
      continue
    }
    if (head === "git") {
      let j = 1
      while (j < rest.length && rest[j]!.startsWith("-")) {
        const o = rest[j]!
        j += GIT_PAIR_OPTIONS.has(o) ? 2 : 1
      }
      if (j > 1) rest = ["git", ...rest.slice(j)]
    }
    break
  }
  return rest
}

/** Every form of a segment a deny/ask rule should be tried against: raw, unquoted, keyword-stripped, unwrapped. */
export function denyLayers(tokens: string[]): string[][] {
  const out: string[][] = [...(unwrapLayers(tokens) ?? [tokens])]
  let rest = tokens.map(unquoteToken)
  for (let guard = 0; guard < 8; guard++) {
    rest = cleanHead(rest)
    if (!rest.length) break
    out.push(rest)
    const next = unwrapOnce(rest)
    if (next === undefined || next === rest || !next.length) break
    rest = next
  }
  return out
}

/** Deny and ask rules match any layer, so `rm *` also catches `timeout 5 rm -rf x` and `'rm' -rf x`; best effort. */
export function denyMatches(pattern: string, segment: Segment) {
  const regex = bashPatternRegex(pattern)
  return denyLayers(segment.tokens).some((layer) => regex.test(layer.join(" ")))
}

// --- built-in read-only list -------------------------------------------------------------------------------------

export interface ReadOnlyContext {
  trusted: boolean
}

/**
 * The extended built-in read-only commands (run without asking when the rules flag is on): `ls`, `pwd`, `rg`, and
 * `cat`/`head`/`tail` on paths inside the project, plus `git status/diff/log` in trusted projects only.
 */
export function isReadOnly(command: string, ctx: ReadOnlyContext) {
  const split = splitCommand(command)
  if (!split.ok || !split.segments.length) return false
  return split.segments.every((segment) => readOnlySegment(segment, ctx))
}

const PLAIN = /^[A-Za-z0-9_./@%+=,:-]+$/

/** A path token the read-only list can trust: plain characters only (no globs, braces, quotes, `~`, `$`). */
function plainArg(arg: string) {
  return PLAIN.test(arg)
}

function readOnlySegment(segment: Segment, ctx: ReadOnlyContext) {
  if (segment.dynamic || segment.writes) return false
  const [cmd, ...args] = segment.tokens
  // any quote, glob, brace, home or variable character makes the real file unknowable: ask
  // (`rg` takes a free-form pattern, so it only checks its path arguments below)
  if (cmd !== "rg" && segment.tokens.some((t) => /[*?\[\]{}$`'"\\]/.test(t) || t.startsWith("~"))) return false
  const flags = args.filter((a) => a.startsWith("-"))
  const paths = args.filter((a) => !a.startsWith("-"))
  if (cmd === "pwd") return args.every((a) => a === "-L" || a === "-P")
  if (cmd === "ls") return paths.every(insideProject)
  if (cmd === "cat") return flags.every((f) => /^-[AbeEnstTuv]+$/.test(f)) && paths.every(readablePath)
  if (cmd === "head" || cmd === "tail") {
    if (flags.some((f) => /^-[^-]*[fF]/.test(f) || f.startsWith("--follow") || f === "--retry")) return false
    const files = args.filter((a, i) => !a.startsWith("-") && !/^-[nc]$/.test(args[i - 1] ?? "") && !/^\+?\d+$/.test(a))
    return files.every(readablePath)
  }
  if (cmd === "rg") {
    if (args.some((a) => /^(--pre|--pre-glob|--hostname-bin|--search-zip|-z|-f|--file|--ignore-file|--no-ignore|--hidden|-u+)(=|$)/.test(a) || /^-[a-zA-Z]*[zfu]/.test(a)))
      return false
    const explicitPattern = args.some((a) => a === "-e" || a.startsWith("--regexp"))
    const positional = args.filter((a, i) => !a.startsWith("-") && !/^-(e|g|t|T|m|A|B|C|j|M)$|^--(regexp|glob|type|type-not|max-count|context|after-context|before-context|threads|max-columns)$/.test(args[i - 1] ?? ""))
    return (explicitPattern ? positional : positional.slice(1)).every((a) => plainArg(a) && insideProject(a))
  }
  if (cmd === "git") {
    if (!ctx.trusted) return false
    const [sub, ...rest] = args
    if (!["status", "diff", "log"].includes(sub ?? "")) return false
    if (rest.some((a) => /^(--output|--ext-diff|--textconv|-o$|--exec|--upload-pack|--receive-pack|--no-index)/.test(a))) return false
    // path arguments (after `--` or plain words that are not flags) must stay inside the project and not be secrets
    const dd = rest.indexOf("--")
    return rest.every((a, i) => {
      if (a.startsWith("-") && (dd === -1 || i < dd)) return true
      if (a === "--") return true
      const isRevision = (dd === -1 || i < dd) && /^[A-Za-z0-9_-]+(\.{2,3}[A-Za-z0-9_-]+)?([~^]\d*)*$/.test(a)
      return isRevision || (insideProject(a) && readablePath(a))
    })
  }
  return false
}

function unquoted(value: string) {
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) return value.slice(1, -1)
  return value
}

/** Relative, no `..`, no home or absolute path: stays inside the folder the command runs in. */
export function insideProject(arg: string) {
  const value = unquoted(arg)
  if (!value) return true
  if (value.startsWith("~") || path.isAbsolute(value) || /^[a-z]:/i.test(value)) return false
  return !value.split(/[\\/]+/).includes("..")
}

const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(\.json)?|secrets?(\..*)?|id_(rsa|dsa|ed25519|ecdsa).*|.*\.(pem|key|p12|pfx|keystore|kdbx))$/i
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".git", ".ezkielyna", ".claude", ".codex", ".config", ".kube", ".docker"])

function readablePath(arg: string) {
  if (!plainArg(arg) || !insideProject(arg)) return false
  const parts = arg.split(/[\\/]+/).filter(Boolean)
  const base = parts.at(-1) ?? ""
  if (base.toLowerCase() === ".env.example") return !parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))
  return !SECRET_NAME.test(base) && !parts.some((p) => SECRET_DIRS.has(p.toLowerCase()))
}
