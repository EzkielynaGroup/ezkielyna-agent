// Ezkielyna Agent Wave B (E1): Claude-compatible hook configuration.
// Read from the `hooks` section of the user's settings.json files (always) and of the project's `.ezkielyna/settings*.json`
// and `.claude/settings*.json` (only when the folder is trusted: a hook is a program that runs on the user's machine).
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { readSettings } from "../safety/rules"

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "Notification",
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** Hard limit per hook, whatever the config says (DESIGN-V3 rule 4: bounded everything). */
export const HOOK_TIMEOUT_MS = 60_000
/** Consecutive Stop/SubagentStop blocks before the breaker lets the agent stop anyway. */
export const STOP_BLOCK_LIMIT = 8
/** stdout/stderr kept per hook. */
export const HOOK_OUTPUT_CAP = 10_000

export type Handler =
  | { type: "command"; command: string; timeoutMs: number }
  | { type: "http"; url: string; headers: Record<string, string>; timeoutMs: number }

export interface HookGroup {
  event: HookEvent
  matcher?: string
  handlers: Handler[]
  /** the settings file it came from */
  source: string
  scope: "user" | "project"
}

export interface HookSources {
  root: string
  userConfig: string
  trusted: boolean
  home?: string
}

export function hookFiles(src: HookSources) {
  const home = src.home ?? os.homedir()
  return {
    user: [path.join(src.userConfig, "settings.json"), path.join(home, ".claude", "settings.json")],
    project: [
      path.join(src.root, ".ezkielyna", "settings.json"),
      path.join(src.root, ".ezkielyna", "settings.local.json"),
      path.join(src.root, ".claude", "settings.json"),
      path.join(src.root, ".claude", "settings.local.json"),
    ],
  }
}

export function loadHooks(src: HookSources): HookGroup[] {
  const files = hookFiles(src)
  const user = files.user.flatMap((file) => groupsFrom(file, "user"))
  // never read the project's hooks before the folder is trusted
  const project = src.trusted ? files.project.flatMap((file) => groupsFrom(file, "project")) : []
  return [...user, ...project]
}

/** Project hooks that exist but were skipped because the folder is not trusted (for the notice). */
export function skippedProjectHooks(src: HookSources) {
  if (src.trusted) return 0
  return hookFiles(src).project.reduce((n, file) => n + groupsFrom(file, "project").length, 0)
}

function groupsFrom(file: string, scope: HookGroup["scope"]): HookGroup[] {
  const hooks = readSettings(file).hooks
  if (!hooks || typeof hooks !== "object") return []
  return HOOK_EVENTS.flatMap((event) => {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    return list.flatMap((entry: any): HookGroup[] => {
      if (!entry || typeof entry !== "object") return []
      const handlers = (Array.isArray(entry.hooks) ? entry.hooks : []).flatMap(parseHandler)
      if (!handlers.length) return []
      const matcher = typeof entry.matcher === "string" && entry.matcher.trim() && entry.matcher.trim() !== "*" ? entry.matcher.trim() : undefined
      return [{ event, matcher, handlers, source: file, scope }]
    })
  })
}

function parseHandler(raw: any): Handler[] {
  if (!raw || typeof raw !== "object") return []
  const seconds = typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : 60
  const timeoutMs = Math.min(seconds * 1000, HOOK_TIMEOUT_MS)
  if ((raw.type ?? "command") === "command" && typeof raw.command === "string" && raw.command.trim())
    return [{ type: "command", command: raw.command, timeoutMs }]
  if (raw.type === "http" && typeof raw.url === "string" && /^https?:\/\//.test(raw.url)) {
    const headers = raw.headers && typeof raw.headers === "object" ? Object.fromEntries(Object.entries(raw.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : {}
    return [{ type: "http", url: raw.url, headers, timeoutMs }]
  }
  return []
}

/** Our tool ids and their Claude Code names, so `Edit|Write` and `edit` matchers both work. */
export const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  apply_patch: "MultiEdit",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  todowrite: "TodoWrite",
  skill: "Skill",
  lsp: "LSP",
}

/** Claude semantics: an exact name, a `|` list, or a regular expression; tested against our id and the Claude name. */
export function matcherMatches(matcher: string | undefined, value: string | undefined) {
  if (!matcher) return true
  if (!value) return false
  const names = [value, CLAUDE_TOOL_NAMES[value]].filter((x): x is string => !!x)
  if (/^[\w|.-]+$/.test(matcher)) {
    const options = matcher.split("|").map((x) => x.trim().toLowerCase())
    return names.some((name) => options.includes(name.toLowerCase()))
  }
  try {
    const regex = new RegExp(`^(?:${matcher})$`)
    return names.some((name) => regex.test(name))
  } catch {
    return false
  }
}

/** Stable id of the active set, so the first-run notice shows again only when hooks change. */
export function hooksFingerprint(groups: HookGroup[]) {
  const text = JSON.stringify(groups.map((g) => [g.event, g.matcher ?? "", g.source, g.handlers.map((h) => (h.type === "command" ? h.command : h.url))]))
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function describeHooks(groups: HookGroup[]) {
  return groups.flatMap((g) =>
    g.handlers.map((h) => ({
      event: g.event,
      matcher: g.matcher ?? "*",
      type: h.type,
      what: h.type === "command" ? h.command : h.url,
      source: g.source,
      scope: g.scope,
    })),
  )
}
