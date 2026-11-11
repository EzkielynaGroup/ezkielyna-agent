// Ezkielyna Agent v3 U3: plan approval. Pure logic: when to show the card, plan.md -> todos, and the reminder that
// re-injects the approved plan after compaction (an appended message, never the system prompt: cache rule).
import type { UxMessage } from "./types"

export type ApprovalMode = "auto" | "ask"
export const isApprovalMode = (v: unknown): v is ApprovalMode => v === "auto" || v === "ask"

export interface PendingPlan {
  /** the plan agent's final reply */
  messageID: string
  text: string
}

/**
 * The plan agent just finished: the newest message is a completed, error-free reply of the `plan` agent with text,
 * and no newer user message exists. Clients show the approval card for it (once per messageID).
 */
export function pendingPlan(messages: UxMessage[], planAgent = "plan"): PendingPlan | undefined {
  const last = messages.at(-1)
  if (!last || last.info.role !== "assistant" || last.info.agent !== planAgent) return
  if (!last.info.time.completed || last.info.error || last.info.summary === true) return
  if (!last.info.finish || ["tool-calls", "unknown"].includes(last.info.finish)) return
  const text = last.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => String(p.text ?? ""))
    .join("\n")
    .trim()
  if (!text) return
  return { messageID: last.info.id, text }
}

export interface PlanTodo {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

const MAX_TODOS = 20

/** Steps of a markdown plan: numbered items first, else checkboxes, else top-level bullets. Code blocks are skipped. */
export function planTodos(markdown: string): PlanTodo[] {
  const lines = withoutCodeBlocks(markdown).split("\n")
  const pick = (re: RegExp) => lines.flatMap((line) => (re.test(line) ? [clean(line.replace(re, ""))] : [])).filter(Boolean)
  const numbered = pick(/^\s{0,3}\d{1,3}[.)]\s+/)
  const boxes = pick(/^\s{0,3}[-*+]\s+\[[ xX]?\]\s+/)
  const bullets = pick(/^[-*+]\s+/)
  const steps = numbered.length >= 2 ? numbered : boxes.length >= 1 ? boxes : bullets.length >= 2 ? bullets : numbered
  return steps.slice(0, MAX_TODOS).map((content) => ({ content, status: "pending", priority: "medium" }))
}

const withoutCodeBlocks = (text: string) => text.replace(/```[\s\S]*?```/g, "")

/** One readable line: no markdown emphasis, links reduced to their text, at most 200 characters. */
function clean(line: string) {
  const text = line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

const MAX_PLAN_CHARS = 8_000

const capPlan = (plan: string) =>
  plan.length > MAX_PLAN_CHARS ? `${plan.slice(0, MAX_PLAN_CHARS)}\n[plan cut at ${MAX_PLAN_CHARS} characters; full text in plan.md]` : plan

/** Synthetic text sent with the approval: the plan the build agent must carry out. */
export function approvalInstruction(plan: string, mode: ApprovalMode) {
  return [
    "<system-reminder>",
    "The user approved the plan below (saved as plan.md for this session). Carry it out now, step by step.",
    "The todo list was created from it: mark each step in_progress when you start it and completed when it is done.",
    mode === "auto"
      ? "File edits inside the project folder run without asking; commands and network access still ask."
      : "The user wants to confirm each step: every edit and command asks first.",
    "",
    "<plan>",
    capPlan(plan.trim()),
    "</plan>",
    "</system-reminder>",
  ].join("\n")
}

/** Visible text of the approval message, in the user's language. */
export function approvalText(mode: ApprovalMode, lang: "en" | "id" = "en") {
  if (lang === "id") return mode === "auto" ? "Rencana disetujui. Jalankan (Edit otomatis)." : "Rencana disetujui. Jalankan, tanya tiap langkah."
  return mode === "auto" ? "Plan approved. Carry it out (auto-edit)." : "Plan approved. Carry it out, asking at each step."
}

/** Reminder that brings the approved plan back after compaction dropped the approval message from the history. */
export function planReminder(plan: string) {
  return [
    "<system-reminder>",
    "Earlier in this session the user approved the plan below (plan.md). The conversation was compacted; keep following this plan",
    "and keep the todo list in sync with it.",
    "",
    "<plan>",
    capPlan(plan.trim()),
    "</plan>",
    "</system-reminder>",
  ].join("\n")
}

export interface ApprovedPlan {
  /** the user message that carried the approval (to know whether it is still in the visible history) */
  messageID: string
  plan: string
  mode: ApprovalMode
  at: number
}

/**
 * Whether to append the plan reminder to this model request: there is an approved plan, and the approval message is
 * no longer part of the (compaction-filtered) history the model sees.
 */
export function needsPlanReminder(messages: UxMessage[], approved: ApprovedPlan | undefined) {
  if (!approved || !messages.length) return false
  const compacted = messages.some((m) => m.parts.some((p) => p.type === "compaction"))
  return compacted && !messages.some((m) => m.info.id === approved.messageID)
}
