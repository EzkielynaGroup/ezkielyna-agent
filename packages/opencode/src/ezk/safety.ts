// Ezkielyna Agent Wave B (S1/S2): process-wide safety state and the small adapters the hot files call.
//   - Permission.ask calls `layer()` for every pattern after the upstream ruleset answered;
//   - agent.ts calls `markDefaults()` once so the layer knows which rules are the built-in ask-first defaults;
//   - session/prompt.ts calls `viewAgent()` so Rencana (plan) also removes the edit tools from the prompt.
// With the modes/rules flags off every adapter is the identity: decisions and prompt bytes stay exactly as before.
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { loadFlags, stripJsonc, type EzkFlags } from "@opencode-ai/core/ezk/flags"
import { decide, type Decision } from "@opencode-ai/core/ezk/safety/decide"
import { DEFAULT_MODE, effectiveMode, parseMode, type Mode } from "@opencode-ai/core/ezk/safety/modes"
import { isProtectedPath } from "@opencode-ai/core/ezk/safety/protected"
import { loadRules, type Rule } from "@opencode-ai/core/ezk/safety/rules"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { projectTrusted } from "@/config/trust"
import { breakerTripped, resetClassifier } from "@/ezk/classifier-state"
import { isDefaultRule } from "./safety/defaults"

let flagsCache: { signature: string; value: EzkFlags } | undefined
/** Stat-only cache for global flags: edits take effect on the next permission check without reparsing unchanged files. */
export function flags(): EzkFlags {
  const signature = ["ezkielyna.jsonc", "ezkielyna.json"]
    .map((file) => {
      try {
        const stat = fs.statSync(path.join(Global.Path.config, file))
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return "missing"
      }
    })
    .concat(process.env.EZK_FEATURES ?? "")
    .join("|")
  if (flagsCache?.signature === signature) return flagsCache.value
  flagsCache = { signature, value: loadFlags([Global.Path.config]) }
  return flagsCache.value
}

/** Test hook: forget the cached flags. */
export function resetFlagsCache() {
  flagsCache = undefined
}

// --- per-session mode ---------------------------------------------------------------------------------------------

const sessionModes = new Map<string, Mode>()
const parents = new Map<string, string>()

/** Root used for "inside the project", remembered rules and trust: the git worktree, else the opened folder. */
export function projectRoot(directory: string, worktree?: string) {
  return worktree && worktree !== "/" ? worktree : directory
}

/** CLI `--permission-mode` (EZK_PERMISSION_MODE) > config `permission.mode` (project only when trusted) > owner default. */
export function configuredMode(directory: string, worktree?: string): Mode {
  const cli = parseMode(process.env.EZK_PERMISSION_MODE)
  if (cli) return cli
  const root = projectRoot(directory, worktree)
  const project = projectTrusted(directory, worktree)
    ? [path.join(root, ".ezkielyna"), root, ...(directory !== root ? [path.join(directory, ".ezkielyna"), directory] : [])]
    : []
  for (const dir of [...project, Global.Path.config]) {
    const mode = readConfigMode(dir)
    if (mode) return mode
  }
  return DEFAULT_MODE
}

function readConfigMode(dir: string): Mode | undefined {
  for (const file of ["ezkielyna.jsonc", "ezkielyna.json"]) {
    try {
      const parsed = JSON.parse(stripJsonc(fs.readFileSync(path.join(dir, file), "utf8")))
      const mode = parseMode(parsed?.permission?.mode)
      if (mode) return mode
    } catch {}
  }
  return
}

/** The mode the user picked for this session (subagents inherit their parent's). */
export function requestedMode(sessionID: string, directory: string, worktree?: string): Mode {
  for (let id: string | undefined = sessionID, depth = 0; id && depth < 8; id = parents.get(id), depth++) {
    const mode = sessionModes.get(id)
    if (mode) return mode
  }
  return processDefault ?? configuredMode(directory, worktree)
}

let processDefault: Mode | undefined
/** Without a session id (the TUI home screen, the desktop composer before the first message): the mode for new sessions. */
export function setMode(sessionID: string | undefined, mode: Mode) {
  if (sessionID) {
    sessionModes.set(sessionID, mode)
    resetClassifier(sessionID)
  }
  else processDefault = mode
}

export function setParent(sessionID: string, parentID: string | undefined) {
  if (parentID) parents.set(sessionID, parentID)
}

/** What applies right now (untrusted folders are forced to ask), or "ask" when the modes flag is off. */
export function currentMode(sessionID: string, directory: string, worktree?: string) {
  const trusted = projectTrusted(directory, worktree)
  const requested = requestedMode(sessionID, directory, worktree)
  return { requested, effective: flags().modes.enabled ? effectiveMode(requested, trusted) : ("ask" as Mode), trusted }
}

// --- recently denied ----------------------------------------------------------------------------------------------

export interface Denied {
  at: number
  sessionID: string
  permission: string
  pattern: string
  why: "rule" | "plan" | "user" | "config"
  rule?: string
}
const denied: Denied[] = []
const DENIED_LIMIT = 30

export function recordDenied(entry: Omit<Denied, "at">) {
  denied.unshift({ ...entry, at: Date.now() })
  denied.length = Math.min(denied.length, DENIED_LIMIT)
}

export function recentlyDenied() {
  return [...denied]
}

// --- hook decisions for one tool call (PreToolUse permissionDecision) ----------------------------------------------

const hookDecisions = new Map<string, "allow" | "ask">()
export function setHookDecision(callID: string, decision: "allow" | "ask" | undefined) {
  if (decision) hookDecisions.set(callID, decision)
  else hookDecisions.delete(callID)
  if (hookDecisions.size > 500) hookDecisions.delete(hookDecisions.keys().next().value!)
}

// --- the permission layer -----------------------------------------------------------------------------------------

let rulesCache: { key: string; at: number; rules: Rule[] } | undefined
function rulesFor(root: string, trusted: boolean) {
  const key = `${root}\0${trusted}`
  if (rulesCache && rulesCache.key === key && Date.now() - rulesCache.at < 1000) return rulesCache.rules
  rulesCache = { key, at: Date.now(), rules: loadRules({ root, userConfig: Global.Path.config, trusted }) }
  return rulesCache.rules
}
export function invalidateRules() {
  rulesCache = undefined
}

/** Permission.ask: the final action for one pattern. Identity when the modes, rules and hooks flags are off. */
export function layer(input: {
  sessionID: string
  permission: string
  pattern: string
  rule: PermissionV1.Rule
  directory: string
  worktree: string
  callID?: string
}): Decision {
  const f = flags()
  const base = { action: input.rule.action, fromDefaults: isDefaultRule(input.rule) }
  if (!f.modes.enabled && !f.rules.enabled && !f.hooks.enabled) return { action: base.action, reason: "base" }
  const root = projectRoot(input.directory, input.worktree)
  const mode = currentMode(input.sessionID, input.directory, input.worktree)
  const raw = input.callID ? hookDecisions.get(input.callID) : undefined
  // a hook "allow" never opens a protected path (Claude Code 2.1.77 rule)
  const hook = raw === "allow" && input.permission === "edit" && isProtectedPath(path.relative(root, path.resolve(input.worktree, input.pattern))) ? undefined : raw
  const result = decide({
    // S5: a tripped classifier breaker puts the session back to ask-first until the user picks a mode again
    mode: mode.requested === "safeAuto" && breakerTripped(input.sessionID) ? "ask" : mode.requested,
    trusted: mode.trusted,
    permission: input.permission,
    pattern: input.pattern,
    // a PreToolUse hook "allow" counts like an ask-first default being relaxed, "ask" like an explicit ask rule
    base: hook === "allow" && base.action === "ask" && base.fromDefaults && mode.trusted ? { action: "allow", fromDefaults: true } : hook === "ask" && base.action === "allow" ? { action: "ask", fromDefaults: false } : base,
    rules: f.rules.enabled || mode.requested === "safeAuto" ? rulesFor(root, mode.trusted) : [],
    root,
    worktree: input.worktree,
    flags: { modes: f.modes.enabled, rules: f.rules.enabled },
  })
  if (result.action === "deny" && result.reason !== "base")
    recordDenied({ sessionID: input.sessionID, permission: input.permission, pattern: input.pattern, why: result.reason === "plan" ? "plan" : "rule", rule: result.rule })
  return result
}

/** Rencana (plan): the edit tools leave the prompt. Returns the same object when nothing changes (identity when off). */
export function viewAgent<T extends { permission: PermissionV1.Rule[] }>(agent: T, sessionID: string, directory: string, worktree: string): T {
  if (!flags().modes.enabled) return agent
  if (currentMode(sessionID, directory, worktree).effective !== "plan") return agent
  return { ...agent, permission: [...agent.permission, { permission: "edit", pattern: "*", action: "deny" }] }
}
