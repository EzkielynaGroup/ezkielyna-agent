// Ezkielyna Agent Wave B (E1): runs the hooks of one event and folds their answers into one outcome.
// Claude Code semantics: exit 0 = ok (stdout may be a JSON decision), exit 2 = block (stderr is the reason the model
// sees), anything else = a non-blocking error shown to the user. Matching hooks run in parallel; identical ones once.
import { spawn } from "node:child_process"
import { stopProcessTree } from "../process-tree"
import { childEnv } from "../safety/env"
import { HOOK_OUTPUT_CAP, matcherMatches, type Handler, type HookEvent, type HookGroup } from "./config"

export interface HookInput {
  session_id: string
  cwd: string
  permission_mode: string
  hook_event_name: HookEvent
  transcript_path?: string
  [key: string]: unknown
}

export interface HookOutcome {
  /** exit 2, `decision: "block"` or a PreToolUse deny */
  blocked: boolean
  reason?: string
  /** PreToolUse `permissionDecision` (deny > ask > allow across hooks) */
  decision?: "allow" | "deny" | "ask"
  updatedInput?: Record<string, unknown>
  /** text for the model: additionalContext, or plain stdout of UserPromptSubmit / SessionStart hooks */
  context: string[]
  /** text for the user: systemMessage and non-blocking errors */
  messages: string[]
  /** `continue: false`: stop the agent, with this reason for the user */
  stop?: string
  ran: number
}

export interface RunOptions {
  /** the tool id for tool events (matched against the group matcher) */
  matchValue?: string
  root: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

export async function runHooks(groups: HookGroup[], input: HookInput, opts: RunOptions): Promise<HookOutcome> {
  const handlers = dedupe(
    groups.filter((g) => g.event === input.hook_event_name && matcherMatches(g.matcher, opts.matchValue)).flatMap((g) => g.handlers),
  )
  const outcome: HookOutcome = { blocked: false, context: [], messages: [], ran: handlers.length }
  if (!handlers.length) return outcome
  const results = await Promise.all(handlers.map((h) => (h.type === "command" ? runCommand(h, input, opts) : runHttp(h, input, opts))))
  const reasons: string[] = []
  const rank = { allow: 0, ask: 1, deny: 2 } as const
  for (const r of results) {
    if (r.kind === "error") {
      outcome.messages.push(r.message)
      continue
    }
    if (r.kind === "block") {
      outcome.blocked = true
      if (r.reason) reasons.push(r.reason)
      continue
    }
    const json = r.json
    if (!json) {
      // plain stdout becomes context for the events where Claude does the same
      if (r.stdout.trim() && (input.hook_event_name === "UserPromptSubmit" || input.hook_event_name === "SessionStart")) outcome.context.push(r.stdout.trim())
      continue
    }
    if (typeof json.systemMessage === "string" && json.systemMessage.trim()) outcome.messages.push(json.systemMessage.trim())
    if (json.continue === false) outcome.stop = typeof json.stopReason === "string" ? json.stopReason : "Stopped by a hook"
    const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === "object" ? json.hookSpecificOutput : {}
    const decision = normaliseDecision(specific.permissionDecision ?? json.decision)
    const reason = [specific.permissionDecisionReason, json.reason].find((x) => typeof x === "string" && x.trim()) as string | undefined
    if (decision === "block") {
      outcome.blocked = true
      if (reason) reasons.push(reason)
    } else if (decision) {
      if (!outcome.decision || rank[decision] > rank[outcome.decision]) outcome.decision = decision
      if (decision === "deny") {
        outcome.blocked = true
        if (reason) reasons.push(reason)
      }
    }
    if (specific.updatedInput && typeof specific.updatedInput === "object") outcome.updatedInput = specific.updatedInput
    if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) outcome.context.push(specific.additionalContext.trim())
  }
  if (reasons.length) outcome.reason = reasons.join("\n")
  else if (outcome.blocked) outcome.reason = `Blocked by a ${input.hook_event_name} hook`
  return outcome
}

function normaliseDecision(value: unknown): "allow" | "deny" | "ask" | "block" | undefined {
  if (value === "allow" || value === "approve") return "allow"
  if (value === "deny") return "deny"
  if (value === "ask") return "ask"
  if (value === "block") return "block"
  return
}

function dedupe(handlers: Handler[]) {
  const seen = new Set<string>()
  return handlers.filter((h) => {
    const key = h.type === "command" ? `c:${h.command}` : `h:${h.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Result = { kind: "ok"; stdout: string; json?: Record<string, any> } | { kind: "block"; reason: string } | { kind: "error"; message: string }

const cap = (text: string) => (text.length > HOOK_OUTPUT_CAP ? text.slice(0, HOOK_OUTPUT_CAP) + "\n[hook output truncated]" : text)

function parseJson(text: string): Record<string, any> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return
  }
}

/**
 * Hook commands run through the platform shell: `sh` on macOS/Linux, `cmd.exe` on Windows. cmd does not expand `$VAR`, so the
 * two variables Claude-style hook files use are rewritten to cmd's `%VAR%`.
 */
export function hookShellCommand(command: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return command
  return command.replace(/\$\{?(CLAUDE_PROJECT_DIR|EZK_PROJECT_DIR)\}?/g, "%$1%")
}

/** Extra advice when a hook fails on Windows because it is a `.sh` script. */
export function hookWindowsHint(command: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32" || !/\.sh(?:["'\s]|$)/i.test(command)) return ""
  return "\nOn Windows hooks run in cmd.exe; a .sh script needs `bash script.sh` (Git for Windows) or a .cmd/.ps1 file."
}

function runCommand(h: Extract<Handler, { type: "command" }>, input: HookInput, opts: RunOptions): Promise<Result> {
  return new Promise((resolve) => {
    const env = childEnv(opts.env ?? process.env, { CLAUDE_PROJECT_DIR: opts.root, EZK_PROJECT_DIR: opts.root })
    const child = spawn(hookShellCommand(h.command), { shell: true, cwd: opts.root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let done = false
    const finish = (r: Result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
        else stopProcessTree(child) // taskkill /T /F: child.kill would end only cmd.exe and leave the script running
      } catch {}
      finish({ kind: "error", message: `Hook timed out after ${Math.round(h.timeoutMs / 1000)}s: ${h.command}` })
    }, h.timeoutMs)
    child.stdout.on("data", (d) => (stdout = cap(stdout + d)))
    child.stderr.on("data", (d) => (stderr = cap(stderr + d)))
    child.on("error", (e) => finish({ kind: "error", message: `Hook failed to start: ${h.command}: ${e.message}${hookWindowsHint(h.command)}` }))
    child.on("close", (code) => {
      if (code === 0) return finish({ kind: "ok", stdout, json: parseJson(stdout) })
      if (code === 2) return finish({ kind: "block", reason: stderr.trim() })
      finish({ kind: "error", message: `Hook exited with ${code}: ${h.command}${stderr.trim() ? `\n${stderr.trim()}` : ""}${hookWindowsHint(h.command)}` })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

async function runHttp(h: Extract<Handler, { type: "http" }>, input: HookInput, opts: RunOptions): Promise<Result> {
  try {
    const res = await (opts.fetch ?? fetch)(h.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...h.headers },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(h.timeoutMs),
    })
    const text = cap(await res.text())
    if (!res.ok) return { kind: "error", message: `Hook ${h.url} answered HTTP ${res.status}` }
    return { kind: "ok", stdout: text, json: parseJson(text) }
  } catch (e) {
    return { kind: "error", message: `Hook ${h.url} failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Per-session count of consecutive Stop blocks; past the limit the agent is allowed to stop. */
export { StopBreaker } from "./breaker"
