// Ezkielyna Agent v3 E3: subagents ON, lazily. Pure logic: when `task` joins the tool list, which model a subagent
// runs on, how Claude-style agent files map to our agent config, and the cap on what a subagent returns.
import { chainFor, type Allowed, type ModelPolicy } from "../model-policy"
import type { UxMessage } from "./types"

/** Tools that count as "reading/searching the code" for the lazy `task` trigger. */
export const READ_TOOLS = new Set(["read", "grep", "glob", "list", "lsp", "codesearch", "code_search"])

/**
 * Expose `task` for this provider step? Sticky over the visible history, so the tool list changes at most once per
 * session (one cache break) and short tasks keep the exact same prompt bytes:
 * - the user mentioned an agent (`@explore`), or `task` was already used;
 * - or one user turn already made `minReads` read/search calls.
 */
export function shouldExposeTask(messages: UxMessage[], minReads = 3) {
  let reads = 0
  for (const msg of messages) {
    if (msg.info.role === "user") {
      if (msg.parts.some((p) => p.type === "agent" || p.type === "subtask")) return true
      if (msg.parts.some((p) => p.type === "text" && !p.synthetic)) reads = 0
      continue
    }
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.tool === "task") return true
      if (READ_TOOLS.has(part.tool)) reads++
      if (reads >= minReads) return true
    }
  }
  return false
}

/** Subagents offered when `task` is exposed lazily. `general` (a full-tool writer) stays off: read-only by default. */
export const LAZY_DENIED_SUBAGENTS = ["general"]

export type Tier = "light" | "heavy"

/**
 * Model of a subagent tier for THIS key. Light = the cheapest allowed model of the light chain (by price when known,
 * else chain order), so Flash-only and Luna-only keys work too; heavy = the head of the heavy chain. Undefined = keep
 * the parent's model.
 */
export function subagentModel(input: {
  tier: Tier
  policy: ModelPolicy
  allowed: Allowed
  /** USD per 1M input tokens, when known */
  price?: (id: string) => number | undefined
}): string | undefined {
  if (!input.allowed.ids.size) return
  if (input.tier === "heavy") return chainFor(input.policy, "heavy", input.allowed)[0]
  const named = [...input.policy.chains.light, ...input.policy.flash].filter((id) => input.allowed.ids.has(id))
  const candidates = named.length ? [...new Set(named)] : [...input.allowed.ids].filter((id) => !input.allowed.aliases.includes(id))
  const priced = candidates.map((id, order) => ({ id, order, usd: input.price?.(id) }))
  const known = priced.filter((c) => typeof c.usd === "number" && c.usd > 0)
  if (known.length) return known.toSorted((a, b) => a.usd! - b.usd! || a.order - b.order)[0]!.id
  return named[0] ?? candidates[0] ?? chainFor(input.policy, "light", input.allowed)[0]
}

/** Model words in agent files: our tiers, Claude's names, or a concrete id. */
export function modelSpec(raw: unknown): { tier?: Tier; model?: string } {
  if (typeof raw !== "string" || !raw.trim()) return {}
  const v = raw.trim()
  const lower = v.toLowerCase()
  if (lower === "inherit") return {}
  if (["light", "flash", "haiku", "fast"].includes(lower)) return { tier: "light" }
  if (["heavy", "pro", "sonnet", "opus"].includes(lower)) return { tier: "heavy" }
  return { model: v }
}

type Action = "allow" | "ask" | "deny"

const CLAUDE_TOOLS: Record<string, string> = {
  read: "read",
  grep: "grep",
  glob: "glob",
  ls: "list",
  list: "list",
  bash: "bash",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  notebookedit: "edit",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  task: "task",
}

const READ_ONLY: Record<string, Action> = { read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow" }

/** Permission words (Claude's `permissionMode` and our mode names). Never grants more than auto-edit from a file. */
export function permissionOverlay(mode: unknown): Record<string, Action> {
  const m = typeof mode === "string" ? mode.trim().toLowerCase() : ""
  if (["plan", "readonly", "read-only", "rencana"].includes(m)) return { edit: "deny", bash: "deny", webfetch: "deny" }
  if (["acceptedits", "auto-edit", "autoedit", "edit otomatis", "bypasspermissions", "dontask", "full"].includes(m))
    return { edit: "allow" }
  return {}
}

export interface AgentConfig {
  description?: string
  prompt?: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  steps?: number
  permission?: Record<string, Action | Record<string, Action>>
  options?: Record<string, unknown>
  [key: string]: unknown
}

/** Turn a `.claude/agents/<name>.md` front-matter + body into our agent config (read-only unless it lists more). */
export function fromClaudeAgent(data: Record<string, unknown>, body: string, providerID: string): AgentConfig {
  const listed = toolList(data.tools)
  const permission: Record<string, Action> = { "*": "deny" }
  if (!listed) Object.assign(permission, READ_ONLY)
  for (const name of listed ?? []) {
    const mapped = CLAUDE_TOOLS[name.toLowerCase()] ?? name.toLowerCase()
    // shell and network still ask first; edits ask unless the file says auto-edit
    permission[mapped] = mapped === "bash" || mapped === "webfetch" || mapped === "edit" ? "ask" : "allow"
  }
  Object.assign(permission, restrict(permissionOverlay(data.permissionMode), permission))
  const spec = modelSpec(data.model)
  const steps = positiveInt(data.maxTurns)
  return {
    description: typeof data.description === "string" ? data.description : undefined,
    prompt: body.trim(),
    mode: "subagent",
    ...(spec.model ? { model: spec.model.includes("/") ? spec.model : `${providerID}/${spec.model}` } : {}),
    ...(steps ? { steps } : {}),
    permission,
    options: { ...(spec.tier ? { ezkTier: spec.tier } : {}), ezkSource: "claude" },
  }
}

/** An overlay may only tighten tools the file did not list (a read-only file never gains edits from permissionMode). */
function restrict(overlay: Record<string, Action>, base: Record<string, Action>) {
  return Object.fromEntries(Object.entries(overlay).filter(([tool, action]) => action === "deny" || tool in base))
}

/**
 * Our own `.ezkielyna/agents/*.md` already load through the config; this adds the ezk keys on top: `model: light|heavy`
 * (resolved per key at run time), `maxTurns` (= steps) and `permissionMode`. Returns a patched copy.
 */
export function normalizeAgent(agent: AgentConfig): AgentConfig {
  const options = { ...agent.options }
  const spec = modelSpec(agent.model)
  const next: AgentConfig = { ...agent, options }
  if (spec.tier) {
    delete next.model
    options.ezkTier = spec.tier
  }
  const steps = positiveInt(options.maxTurns)
  if (steps && next.steps === undefined) next.steps = steps
  const overlay = permissionOverlay(options.permissionMode)
  if (Object.keys(overlay).length) next.permission = { ...agent.permission, ...overlay }
  return next
}

function toolList(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
  if (typeof raw === "string") return raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
  return undefined
}

const positiveInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : typeof v === "string" && /^\d+$/.test(v) && +v > 0 ? +v : undefined)

/** Bound what a subagent hands back to its parent: about `tokens` tokens (4 characters each), head + tail kept. */
export function capResult(text: string, tokens: number) {
  const max = Math.max(400, tokens * 4)
  if (text.length <= max) return text
  const marker = `\n[... ${text.length - max} characters cut: subagent results are capped at about ${tokens} tokens ...]\n`
  const keep = max - marker.length
  return text.slice(0, Math.ceil(keep * 0.75)) + marker + text.slice(text.length - Math.floor(keep * 0.25))
}

/** Explorer prompt used when the subagents flag is on (the user's own explore prompt wins). */
export function explorePrompt(turns: number) {
  return [
    "You are a fast, read-only code explorer working for another agent. You cannot edit files or run commands that change anything.",
    `You have at most ${turns} turns. In each turn, run several grep, glob and read calls in parallel instead of one at a time.`,
    "Start broad (glob for file names, grep for symbols and strings), then read only the relevant ranges.",
    "",
    "Answer with a short list, one finding per line, in exactly this form:",
    "path/to/file.ts:12-40 one line saying what is there and why it matters",
    "",
    "Use paths relative to the project root and real line ranges you have seen. Put the most relevant lines first.",
    "End with one sentence that answers the question. No other text, at most 2000 tokens. If you found nothing, say so.",
  ].join("\n")
}

export const PLANNER_DESCRIPTION =
  "Read-only planner for bigger changes: studies the relevant code and returns a step-by-step implementation plan with the files to touch. Use it before multi-file work."

export const PLANNER_PROMPT = [
  "You are a read-only planning agent working for another agent. You cannot edit files or run commands that change anything.",
  "Study the code needed for the task (search and read in parallel), then return a concrete plan:",
  "1. the goal in one sentence;",
  "2. numbered steps, each naming the files (path:start-end) and what changes there;",
  "3. how to verify the result (tests or commands to run);",
  "4. risks or open questions.",
  "Keep it under 2000 tokens. No code longer than a few lines.",
].join("\n")
