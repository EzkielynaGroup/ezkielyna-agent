// Ezkielyna Agent Wave B (S1 + S2): the one decision that sits on top of the normal permission rules.
// It runs after the upstream ruleset gave its answer for one (permission, pattern) and may:
//   - tighten: a remembered deny/ask rule, plan mode (no edits, read-only shell);
//   - relax, only when the ask came from the built-in ask-first defaults (never a user's or agent's own ask/deny):
//     the mode (Edit otomatis, Otomatis-aman, Penuh), a remembered allow rule, or the extended read-only command list.
// Untrusted folders never relax: the mode is forced to "ask" and allow rules are not loaded for them.
import fs from "node:fs"
import path from "node:path"
import { isReadOnly } from "./bash"
import { effectiveMode, type Mode } from "./modes"
import { isProtectedPath, within } from "./protected"
import { evaluateRules, type Action, type Rule } from "./rules"

export interface DecideInput {
  /** the mode the user picked for this session (before trust is applied) */
  mode: Mode
  trusted: boolean
  permission: string
  pattern: string
  /** what the upstream ruleset said, and whether that rule is one of the ask-first defaults */
  base: { action: Action; fromDefaults: boolean }
  rules: Rule[]
  /** absolute project root used for "inside the project" */
  root: string
  /** the folder tool patterns are relative to (instance worktree) */
  worktree: string
  flags: { modes: boolean; rules: boolean }
}

export interface Decision {
  action: Action
  /** short machine reason: base, rule, plan, mode, readonly */
  reason: "base" | "rule" | "plan" | "mode" | "readonly"
  rule?: string
}

export function decide(input: DecideInput): Decision {
  const mode = input.flags.modes ? effectiveMode(input.mode, input.trusted) : "ask"
  const base = input.base
  if (base.action === "deny") return { action: "deny", reason: "base" }

  const useRules = input.flags.rules || mode === "safeAuto"
  const hit = useRules ? evaluateRules(input.rules, { permission: input.permission, pattern: input.pattern, root: input.root }) : undefined
  if (hit?.action === "deny") return { action: "deny", reason: "rule", rule: hit.raw }

  // plan is read-only before anything else may ask: approving a prompt must not let a changing command through
  if (mode === "plan") {
    if (input.permission === "edit") return { action: "deny", reason: "plan" }
    if (input.permission === "bash" && !isReadOnly(input.pattern, { trusted: input.trusted })) return { action: "deny", reason: "plan" }
  }

  if (hit?.action === "ask") return { action: "ask", reason: "rule", rule: hit.raw }

  if (base.action === "allow") return { action: "allow", reason: "base" }
  // only the built-in ask-first defaults may be relaxed; an ask the user or the agent wrote stays an ask
  if (!base.fromDefaults || !input.trusted) return { action: "ask", reason: "base" }

  // A remembered rule or a mode never opens a protected path (git hooks, project settings that run hooks, config that defines
  // commands...): even a bare "Edit" rule asks for those. Penuh (full) is the user's explicit "no guard rails" choice; the
  // file tools still force a prompt for protected paths there (ezk/safety/protected-paths).
  if (mode !== "full" && input.permission === "edit" && protectedEdit(input)) return { action: "ask", reason: "base" }

  if (hit?.action === "allow") return { action: "allow", reason: "rule", rule: hit.raw }
  if (input.flags.rules && input.permission === "bash" && isReadOnly(input.pattern, { trusted: true }))
    return { action: "allow", reason: "readonly" }
  if (mode === "full") return { action: "allow", reason: "mode" }
  // web_search sends only the query to our own gateway (no file access): it runs without asking in the relaxed modes
  if ((mode === "acceptEdits" || mode === "safeAuto") && input.permission === "web_search") return { action: "allow", reason: "mode" }
  if ((mode === "acceptEdits" || mode === "safeAuto") && input.permission === "edit" && editInsideProject(input))
    return { action: "allow", reason: "mode" }
  return { action: "ask", reason: "base" }
}

/** The edited file is, lexically or after resolving symlinks, a protected path (measured from the project root). */
function protectedEdit(input: DecideInput) {
  const file = path.resolve(input.worktree, input.pattern)
  const root = realpath(input.root)
  return isProtectedPath(path.relative(input.root, file)) || isProtectedPath(path.relative(root, realpath(file)))
}

/** The edited file resolves (symlinks included) inside the project root and is not a protected path. */
function editInsideProject(input: DecideInput) {
  const file = path.resolve(input.worktree, input.pattern)
  const root = realpath(input.root)
  const real = realpath(file)
  if (!within(file, input.root) || !within(real, root)) return false
  return !isProtectedPath(path.relative(root, real))
}

/** realpath of the file, or of its nearest existing parent joined with the rest (new files do not exist yet). */
function realpath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    const parent = path.dirname(file)
    if (parent === file) return file
    return path.join(realpath(parent), path.basename(file))
  }
}
