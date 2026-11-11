// Ezkielyna Agent Wave B (S2): remembered permission rules, Claude-compatible.
// Files: `.ezkielyna/settings.json` (shared), `.ezkielyna/settings.local.json` (personal, git-ignored, where "always allow
// in this project" is saved), the same two under `.claude/`, and the user-level `settings.json` files.
// Order is deny > ask > allow and the first match wins, so a narrow allow can never carve a hole in a broad deny.
// Allow rules from project files only count once the folder is trusted; deny and ask rules always count (they only tighten).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stripJsonc } from "../flags"
import { allowMatches, denyMatches, splitCommand, unquoteToken } from "./bash"

export type Action = "allow" | "ask" | "deny"

export interface Rule {
  action: Action
  /** our permission name: bash, edit, read, webfetch, ... */
  permission: string
  /** the part inside the parentheses; undefined = the whole tool */
  specifier?: string
  /** the rule as written, for display */
  raw: string
  source: string
}

const TOOL_NAMES: Record<string, string> = {
  bash: "bash",
  shell: "bash",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  apply_patch: "edit",
  read: "read",
  webfetch: "webfetch",
  websearch: "websearch",
  glob: "glob",
  grep: "grep",
  task: "task",
  agent: "task",
  skill: "skill",
}

/** `Bash(bun test *)`, `Edit(src/**)`, `WebFetch(domain:example.com)` or a bare tool name. */
export function parseRule(raw: string, action: Action, source = "inline"): Rule | undefined {
  const match = /^\s*([A-Za-z_][\w.-]*)\s*(?:\((.*)\))?\s*$/s.exec(raw)
  if (!match) return
  const name = match[1]!
  const permission = TOOL_NAMES[name.toLowerCase()] ?? name
  const specifier = match[2]?.trim()
  return { action, permission, specifier: specifier === "" || specifier === "*" ? undefined : specifier, raw: raw.trim(), source }
}

export function formatBashRule(prefix: string) {
  return `Bash(${prefix})`
}

/**
 * Prefixes never saved as a project-wide "always allow": destructive commands, privilege changes, downloads and
 * interpreters (one approval of `python x.py` must not approve every Python program). They can still be allowed once.
 */
const RISKY = new Set(["rm", "rmdir", "sudo", "su", "doas", "dd", "mkfs", "chmod", "chown", "curl", "wget", "sh", "bash", "zsh", "fish", "dash", "ksh", "eval", "exec", "source", ".", "xargs", "find", "env", "ssh", "scp", "rsync", "kill", "killall", "pkill", "shutdown", "reboot", "npx", "bunx", "awk", "gawk", "nawk", "sed", "tar", "tee", "cp", "mv", "ln", "make", "docker", "podman", "pwsh", "powershell", "cmd", "osascript", "open", "timeout", "nice", "nohup", "time", "command", "builtin", "watch", "script", "nc", "ncat", "socat", "telnet"])
/** Interpreters and package runners: risky unless the rule names a concrete subcommand or script (`bun test *`, `python x.py *`). */
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "bun", "deno", "perl", "ruby", "php", "lua", "pnpm", "yarn", "npm"])
const PACKAGE_MANAGERS = new Set(["bun", "pnpm", "yarn", "npm"])
const RUNS_CODE = new Set(["x", "exec", "dlx", "eval", "repl", "create", "init", "publish", "link"])
const RISKY_GIT = new Set(["push", "reset", "clean", "checkout", "restore", "rebase", "config", "filter-branch", "gc", "prune", "submodule", "worktree", "remote", "stash", "rm", "mv", "am", "apply", "cherry-pick", "revert", "merge", "pull", "fetch", "clone"])
export function riskyPrefix(prefix: string) {
  const words = prefix
    .trim()
    .replace(/:\*$/, " *")
    .split(/\s+/)
    .filter((w) => w && w !== "*")
    .map(unquoteToken)
  if (!words.length) return true
  // a word cut by a wildcard (`py*`) or any other glob is not a literal command name
  if (/[*?[\]{}$`~]/.test(words[0]!)) return true
  const head = words[0]!.replace(/^.*\//, "").toLowerCase().replace(/\.exe$/, "")
  const second = words[1]
  if (RISKY.has(head)) return true
  if (head === "git") return !second || second.startsWith("-") || RISKY_GIT.has(second)
  if (INTERPRETERS.has(head)) {
    if (!second || second.startsWith("-") || RUNS_CODE.has(second)) return true
    if (PACKAGE_MANAGERS.has(head)) return second === "run" && words.length < 3
    // `python3 *` or `python -c` is open-ended, `python scripts/check.py *` names one file
    return !/\.[a-z]+$/i.test(second)
  }
  return ["npm publish", "bun publish", "cargo publish", "gh pr merge", "gh api"].some((p) => `${words.join(" ")} `.startsWith(`${p} `))
}

/** The `always` patterns an escalation prompt (`require_escalated`, `with_network`) may offer: none for a risky prefix. */
export function escalationAlways(escalation: string, prefix: string): string[] {
  return riskyPrefix(prefix) ? [] : [`${escalation}:${prefix} *`]
}

export interface MatchInput {
  permission: string
  /** what the tool asked about: a command segment, a path relative to the project root, a URL ... */
  pattern: string
  /** absolute project root, for `/path` rules */
  root?: string
}

/** deny > ask > allow, first match wins. undefined = no rule applies. */
export function evaluateRules(rules: Rule[], input: MatchInput): Rule | undefined {
  for (const action of ["deny", "ask", "allow"] as const) {
    const hit = rules.find((rule) => rule.action === action && ruleMatches(rule, input))
    if (hit) return hit
  }
  return
}

export function ruleMatches(rule: Rule, input: MatchInput): boolean {
  if (rule.permission !== input.permission && rule.permission !== "*") return false
  if (rule.specifier === undefined) return true
  if (input.permission === "bash") return bashRuleMatches(rule, input.pattern)
  if (input.permission === "edit" || input.permission === "read") return pathMatches(rule.specifier, input.pattern, input.root)
  if (input.permission === "webfetch" && rule.specifier.startsWith("domain:")) return domainMatches(rule.specifier.slice(7), input.pattern)
  return globRegex(rule.specifier, true).test(input.pattern)
}

/**
 * A bash pattern from the shell tool is one simple command, but split it again (defence in depth): every piece must be
 * allowed for an allow rule to count, while one matching piece is enough for deny and ask. Unparseable = no allow.
 */
function bashRuleMatches(rule: Rule, command: string) {
  const split = splitCommand(command)
  if (rule.action === "allow") return split.ok && split.segments.length > 0 && split.segments.every((segment) => allowMatches(rule.specifier!, segment))
  // a command we cannot split is still checked as one piece, so a deny rule keeps working on odd input
  const segments = split.ok ? split.segments : [{ text: command, tokens: command.trim().split(/\s+/), dynamic: true, writes: false }]
  return segments.some((segment) => denyMatches(rule.specifier!, segment))
}

function pathMatches(spec: string, pattern: string, root?: string) {
  const target = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
  if (spec.startsWith("//")) return root ? globRegex(spec.slice(1), false).test(path.resolve(root, target).replaceAll("\\", "/")) : false
  if (spec.startsWith("~/")) return root ? globRegex(path.join(os.homedir(), spec.slice(2)).replaceAll("\\", "/"), false).test(path.resolve(root, target).replaceAll("\\", "/")) : false
  const relative = spec.replace(/^\.?\//, "")
  // gitignore style: a pattern without a slash matches the file name at any depth
  if (!relative.includes("/")) return globRegex(relative, false).test(path.posix.basename(target)) || globRegex(relative, false).test(target)
  return globRegex(relative, false).test(target)
}

function domainMatches(spec: string, url: string) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return ""
    }
  })()
  if (!host) return false
  const domain = spec.toLowerCase()
  if (domain.startsWith("*.")) return host.endsWith(domain.slice(1))
  return host === domain
}

/** `**` crosses folders, `*` and `?` do not (unless `flat`, used for non-path specifiers). */
function globRegex(glob: string, flat: boolean, caseless = process.platform === "win32") {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*"
      i++
      if (glob[i + 1] === "/") i++
      continue
    }
    if (c === "*") out += flat ? ".*" : "[^/]*"
    else if (c === "?") out += flat ? "." : "[^/]"
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`, caseless ? "si" : "s")
}

// --- files ----------------------------------------------------------------------------------------------------------

export interface RuleSources {
  /** project root (git worktree, else the opened folder) */
  root: string
  /** the user's config folder (Global.Path.config) */
  userConfig: string
  trusted: boolean
  /** default os.homedir(), for ~/.claude/settings.json */
  home?: string
}

export const LOCAL_SETTINGS = path.join(".ezkielyna", "settings.local.json")

export function settingsFiles(src: RuleSources) {
  const home = src.home ?? os.homedir()
  return {
    user: [path.join(src.userConfig, "settings.json"), path.join(home, ".claude", "settings.json")],
    project: [
      path.join(src.root, ".ezkielyna", "settings.json"),
      path.join(src.root, ".claude", "settings.json"),
      path.join(src.root, ".claude", "settings.local.json"),
      path.join(src.root, LOCAL_SETTINGS),
    ],
  }
}

export function readSettings(file: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function rulesFrom(file: string, project: boolean, trusted: boolean): Rule[] {
  const permissions = readSettings(file).permissions
  if (!permissions || typeof permissions !== "object") return []
  return (["deny", "ask", "allow"] as const).flatMap((action) => {
    // an untrusted folder may tighten (deny/ask) but never loosen
    if (action === "allow" && project && !trusted) return []
    const list = Array.isArray(permissions[action]) ? permissions[action] : []
    return list.flatMap((raw: unknown) => {
      const rule = typeof raw === "string" ? parseRule(raw, action, file) : undefined
      return rule ? [rule] : []
    })
  })
}

export function loadRules(src: RuleSources): Rule[] {
  const files = settingsFiles(src)
  return [...files.user.flatMap((file) => rulesFrom(file, false, src.trusted)), ...files.project.flatMap((file) => rulesFrom(file, true, src.trusted))]
}

/** Save "always allow <rule> in this project" to `.ezkielyna/settings.local.json` and make sure git ignores that file. */
export function rememberRule(root: string, raw: string, action: Action = "allow") {
  const file = path.join(root, LOCAL_SETTINGS)
  const settings = readSettings(file)
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {}
  const list: string[] = Array.isArray(permissions[action]) ? permissions[action].filter((x: unknown) => typeof x === "string") : []
  if (!list.includes(raw)) list.push(raw)
  settings.permissions = { ...permissions, [action]: list }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
  ensureIgnored(root)
  return file
}

export function forgetRule(root: string, raw: string) {
  const file = path.join(root, LOCAL_SETTINGS)
  const settings = readSettings(file)
  const permissions = settings.permissions
  if (!permissions || typeof permissions !== "object") return false
  let removed = false
  for (const action of ["allow", "ask", "deny"]) {
    if (!Array.isArray(permissions[action])) continue
    const next = permissions[action].filter((x: unknown) => x !== raw)
    if (next.length !== permissions[action].length) removed = true
    permissions[action] = next
  }
  if (removed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
  return removed
}

/** `.ezkielyna/.gitignore` gets `settings.local.json`, so personal rules never land in a commit. */
export function ensureIgnored(root: string) {
  const file = path.join(root, ".ezkielyna", ".gitignore")
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  if (current.split(/\r?\n/).some((line) => line.trim() === "settings.local.json" || line.trim() === "/settings.local.json")) return
  fs.writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + "settings.local.json\n")
}
