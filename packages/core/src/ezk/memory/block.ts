// Ezkielyna Agent v1.1: the frozen memory block that goes into the system prompt, and the guidance for the tool.
// Frozen = computed once per session and never changed mid-session, so the provider's prompt cache stays valid.
import { LIMITS, type MemoryStore } from "./store"

/** Token estimate for the budget gate: 4 chars/token (English/code average). `pessimistic` uses 3.3 (dense non-English text). */
export const estimateTokens = (text: string, charsPerToken = 4) => Math.ceil(text.length / charsPerToken)

export function buildBlock(mem: string[], user: string[]): string {
  if (!mem.length && !user.length) return ""
  const lines = ["<memory>", "Notes from earlier sessions (frozen for this session)."]
  if (user.length) lines.push("About the user:", ...user.map((e) => `- ${e}`))
  if (mem.length) lines.push("Environment and projects:", ...mem.map((e) => `- ${e}`))
  lines.push("</memory>")
  return lines.join("\n")
}

export function snapshot(store: MemoryStore): string {
  return buildBlock(store.load("memory"), store.load("user"))
}

export const TOOL_DESCRIPTION =
  "Save durable notes for future sessions. store=user: who the user is, preferences, corrections. store=memory: stable facts about machine, projects, tools. " +
  "Short declarative facts only. Never save secrets, keys, passwords, card numbers, one-off task details, what was done, or guesses. " +
  `add | replace | remove (replace/remove: \`match\` = unique part of an entry). Limits: memory ${LIMITS.memory} chars, user ${LIMITS.user}. Applies next session.`
