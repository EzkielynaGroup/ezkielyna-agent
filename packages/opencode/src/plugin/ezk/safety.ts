// Ezkielyna Agent Wave B: internal plugin for permission modes (E1 hooks engine, S1 mode reminders, S2 denial list).
// Claude-compatible hook events mapped onto the plugin hooks:
//   PreToolUse -> tool.execute.before      PostToolUse -> tool.execute.after      UserPromptSubmit -> chat.message
//   SessionStart -> first chat.message     Stop / SubagentStop -> experimental.session.stop (session/prompt.ts)
//   PreCompact -> experimental.session.compacting      Notification -> permission.asked      SessionEnd -> session.deleted / dispose
// Every hook is skipped while the `hooks` flag is off; project hooks load only in trusted folders (core/src/ezk/hooks/config.ts).
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { CLAUDE_TOOL_NAMES, describeHooks, hooksFingerprint, loadHooks, skippedProjectHooks, type HookEvent, type HookGroup } from "@opencode-ai/core/ezk/hooks/config"
import { StopBreaker } from "@opencode-ai/core/ezk/hooks/breaker"
import type { HookOutcome } from "@opencode-ai/core/ezk/hooks/engine"
import { modeReminder, type Mode } from "@opencode-ai/core/ezk/safety/modes"
import { projectTrusted } from "@/config/trust"
import { PartID } from "@/session/schema"
import { currentMode, flags, projectRoot, recordDenied, setHookDecision, setParent } from "@/ezk/safety"

const CLAUDE_MODE: Record<Mode, string> = { ask: "default", acceptEdits: "acceptEdits", plan: "plan", safeAuto: "auto", full: "bypassPermissions" }

/** Claude hook scripts read `tool_input.file_path`; ours are camelCase. Both spellings are sent, and mapped back. */
const SNAKE: Record<string, string> = { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" }
const CAMEL = Object.fromEntries(Object.entries(SNAKE).map(([k, v]) => [v, k]))

export const breaker = new StopBreaker()

export async function EzkSafetyPlugin(input: PluginInput): Promise<Hooks> {
  const directory = input.directory
  const worktree = input.worktree
  const root = projectRoot(directory, worktree)
  const started = new Set<string>()
  const told = new Map<string, Mode>()
  const asked = new Map<string, { sessionID: string; permission: string; patterns: string[] }>()
  let cache: { at: number; groups: HookGroup[] } | undefined

  const groups = () => {
    if (!flags().hooks.enabled) return []
    if (cache && Date.now() - cache.at < 3000) return cache.groups
    cache = { at: Date.now(), groups: loadHooks({ root, userConfig: Global.Path.config, trusted: projectTrusted(directory, worktree) }) }
    return cache.groups
  }

  const fire = async (event: HookEvent, sessionID: string, extra: Record<string, unknown>, matchValue?: string): Promise<HookOutcome | undefined> => {
    const active = groups()
    if (!active.some((g) => g.event === event)) return
    const { runHooks } = await import("@opencode-ai/core/ezk/hooks/engine")
    const outcome = await runHooks(active, {
      session_id: sessionID,
      cwd: directory,
      permission_mode: CLAUDE_MODE[currentMode(sessionID, directory, worktree).effective],
      hook_event_name: event,
      transcript_path: "",
      ...extra,
    }, { root, matchValue })
    if (outcome.messages.length) void toast(outcome.messages.join("\n"), outcome.blocked ? "warning" : "info")
    return outcome
  }

  const toast = (message: string, variant: "info" | "warning") =>
    (input.client as any)?.tui?.showToast?.({ body: { message: message.slice(0, 500), variant } })?.catch?.(() => {})

  const synthetic = (out: { message: { id: string; sessionID: string }; parts: unknown[] }, text: string) =>
    out.parts.push({ id: PartID.ascending(), messageID: out.message.id, sessionID: out.message.sessionID, type: "text", synthetic: true, text })

  return {
    async "chat.message"(inp, out) {
      const sessionID = inp.sessionID
      const userText = out.parts.map((p: any) => (p.type === "text" && !p.synthetic ? p.text : "")).join("\n").trim()
      if (userText) breaker.reset(sessionID)
      if (userText && flags().safety.classifier) {
        const { recordUserMessage } = await import("@/ezk/classifier")
        recordUserMessage(sessionID, userText)
      }

      // S1: tell the model about the mode in an appended reminder (never the system prompt), only when it changes
      if (flags().modes.enabled) {
        const mode = currentMode(sessionID, directory, worktree).effective
        if (told.get(sessionID) !== mode && !(mode === "ask" && !told.has(sessionID))) synthetic(out, modeReminder(mode))
        told.set(sessionID, mode)
      }

      if (!flags().hooks.enabled) return
      if (!started.has(sessionID)) {
        started.add(sessionID)
        const start = await fire("SessionStart", sessionID, { source: "startup" })
        if (start?.context.length) synthetic(out, `<system-reminder>\n${start.context.join("\n\n")}\n</system-reminder>`)
      }
      if (!userText) return
      const submit = await fire("UserPromptSubmit", sessionID, { prompt: userText })
      if (!submit) return
      if (submit.blocked || submit.stop) throw new Error(`Prompt blocked by a hook: ${submit.reason ?? submit.stop}`)
      if (submit.context.length) synthetic(out, `<system-reminder>\n${submit.context.join("\n\n")}\n</system-reminder>`)
    },

    async "tool.execute.before"(inp, out) {
      if (!out) return
      const outcome = await fire("PreToolUse", inp.sessionID, { tool_name: claudeName(inp.tool), tool_input: withSnake(out.args), tool_use_id: inp.callID }, inp.tool)
      if (!outcome) return
      if (outcome.blocked || outcome.stop) {
        setHookDecision(inp.callID, undefined)
        throw new Error(`Blocked by a PreToolUse hook: ${outcome.reason ?? outcome.stop}`)
      }
      if (outcome.updatedInput) {
        for (const key of Object.keys(out.args ?? {})) delete out.args[key]
        Object.assign(out.args, fromSnake(outcome.updatedInput))
      }
      setHookDecision(inp.callID, outcome.decision === "allow" || outcome.decision === "ask" ? outcome.decision : undefined)
    },

    async "tool.execute.after"(inp, out) {
      setHookDecision(inp.callID, undefined)
      if (!out) return // failed tools (e.g. a failed subtask) call the hook without an output object
      const outcome = await fire(
        "PostToolUse",
        inp.sessionID,
        { tool_name: claudeName(inp.tool), tool_input: withSnake(inp.args), tool_response: { output: out.output?.slice?.(0, 10_000), title: out.title }, tool_use_id: inp.callID },
        inp.tool,
      )
      if (!outcome) return
      const notes = [...(outcome.blocked && outcome.reason ? [outcome.reason] : []), ...outcome.context]
      if (notes.length) out.output = `${out.output ?? ""}\n\n<hook-feedback>\n${notes.join("\n\n")}\n</hook-feedback>`
    },

    async "experimental.session.stop"(inp, out) {
      if (!flags().hooks.enabled) return
      const event: HookEvent = inp.parentID ? "SubagentStop" : "Stop"
      const outcome = await fire(event, inp.sessionID, { stop_hook_active: breaker.active(inp.sessionID) })
      if (!outcome?.blocked || outcome.stop) {
        breaker.reset(inp.sessionID)
        return
      }
      if (!breaker.block(inp.sessionID)) {
        void toast(`A ${event} hook blocked ${breaker.limit} times in a row, so the agent stopped anyway.`, "warning")
        breaker.reset(inp.sessionID)
        return
      }
      out.continue = `<system-reminder>\nA ${event} hook asked you to keep working before you finish:\n${outcome.reason}\n</system-reminder>`
    },

    async "experimental.session.compacting"(inp, out) {
      const outcome = await fire("PreCompact", inp.sessionID, { trigger: "auto", custom_instructions: "" })
      if (outcome?.context.length) out.context.push(...outcome.context)
    },

    async event({ event }) {
      const e = event as { type: string; properties: any }
      if (e.type === "session.created") setParent(e.properties?.info?.id ?? e.properties?.sessionID, e.properties?.info?.parentID)
      if (e.type === "permission.asked") {
        const p = e.properties
        asked.set(p.id, { sessionID: p.sessionID, permission: p.permission, patterns: p.patterns ?? [] })
        if (asked.size > 200) asked.delete(asked.keys().next().value!)
        void fire("Notification", p.sessionID, { message: `Ezkielyna Agent needs your permission to use ${p.permission}`, notification_type: "permission_prompt" })
      }
      if (e.type === "permission.replied") {
        const p = e.properties
        const request = asked.get(p.requestID)
        asked.delete(p.requestID)
        if (request && p.reply === "reject")
          for (const pattern of request.patterns) recordDenied({ sessionID: request.sessionID, permission: request.permission, pattern, why: "user" })
      }
      if (e.type === "session.deleted") {
        const id = e.properties?.info?.id ?? e.properties?.sessionID
        if (id && started.delete(id)) void fire("SessionEnd", id, { reason: "other" })
      }
    },

    async dispose() {
      await Promise.all([...started].map((id) => fire("SessionEnd", id, { reason: "exit" })))
      started.clear()
    },
  }
}

const claudeName = (tool: string) => CLAUDE_TOOL_NAMES[tool] ?? tool

function withSnake(args: unknown) {
  if (!args || typeof args !== "object") return args
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  for (const [k, v] of Object.entries(SNAKE)) if (k in out) out[v] = out[k]
  return out
}

function fromSnake(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [CAMEL[k] ?? k, v]))
}

// --- first-run notice ---------------------------------------------------------------------------------------------

const seenFile = () => path.join(Global.Path.state, "ezk-hooks-seen.json")

export function hooksStatus(directory: string, worktree?: string) {
  const root = projectRoot(directory, worktree)
  const trusted = projectTrusted(directory, worktree)
  const enabled = flags().hooks.enabled
  const active = enabled ? loadHooks({ root, userConfig: Global.Path.config, trusted }) : []
  const fingerprint = hooksFingerprint(active)
  const seen = readSeen()
  return {
    enabled,
    trusted,
    hooks: describeHooks(active),
    skippedProjectHooks: enabled ? skippedProjectHooks({ root, userConfig: Global.Path.config, trusted }) : 0,
    fingerprint,
    noticeNeeded: active.length > 0 && seen[root] !== fingerprint,
  }
}

export function acknowledgeHooks(directory: string, worktree: string | undefined, fingerprint: string) {
  const seen = readSeen()
  seen[projectRoot(directory, worktree)] = fingerprint
  fs.mkdirSync(path.dirname(seenFile()), { recursive: true })
  fs.writeFileSync(seenFile(), JSON.stringify(seen, null, 2) + "\n", { mode: 0o600 })
}

function readSeen(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFile(), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}
