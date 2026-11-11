import type { ModelPolicy } from "./model-policy"

export const TARGET_WINDOW_RATIO = 0.9
export const RECENT_USER_TOKEN_BUDGET = 20_000

export function compactionThreshold(window: number | undefined, fallback: number) {
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return fallback
  return Math.floor(window * TARGET_WINDOW_RATIO)
}

export function modelCompactionThreshold(policy: Pick<ModelPolicy, "models">, modelID: string, fallback: number) {
  return compactionThreshold(policy.models[modelID]?.agentContext, fallback)
}

export function toolResultMarker(output: string) {
  const normalized = output.replace(/(?:\r\n|\r|\n)+$/, "")
  const lines = normalized.length ? normalized.split(/\r\n|\r|\n/).length : 0
  return `[output dibuang saat ringkasan: ${lines} baris]`
}

/** Keep the newest outputs intact and clear the oldest first until the target budget is met. */
export function clearOldToolResults<T>(input: {
  items: readonly T[]
  output: (item: T) => string
  replace: (item: T, marker: string) => T
  protected?: (item: T) => boolean
  keepTokens: number
  minimumFreedTokens?: number
  estimate?: (text: string) => number
}) {
  const estimate = input.estimate ?? ((text: string) => Math.ceil(text.length / 4))
  const sizes = input.items.map((item) => (input.protected?.(item) ? 0 : estimate(input.output(item))))
  const preserve = new Set<number>()
  let kept = 0
  for (let i = input.items.length - 1; i >= 0; i--) {
    if (input.protected?.(input.items[i]!)) continue
    if (preserve.size > 0 && kept + sizes[i]! > input.keepTokens) break
    preserve.add(i)
    kept += sizes[i]!
  }
  const candidates = input.items.flatMap((item, index) =>
    !preserve.has(index) && !input.protected?.(item) && sizes[index]! > 0 ? [index] : [],
  )
  const freed = candidates.reduce((sum, index) => {
    const marker = toolResultMarker(input.output(input.items[index]!))
    return sum + Math.max(0, sizes[index]! - estimate(marker))
  }, 0)
  if (freed < (input.minimumFreedTokens ?? 0)) return { items: [...input.items], cleared: 0, freedTokens: 0 }
  const selected = new Set(candidates)
  return {
    items: input.items.map((item, index) => (selected.has(index) ? input.replace(item, toolResultMarker(input.output(item))) : item)),
    cleared: candidates.length,
    freedTokens: freed,
  }
}

/** Choose recent user text newest-first, then restore chronological order without modifying its bytes. */
export function recentUserMessages<T>(input: {
  messages: readonly T[]
  isUser: (message: T) => boolean
  text: (message: T) => string
  budget?: number
  estimate?: (text: string) => number
}) {
  const budget = input.budget ?? RECENT_USER_TOKEN_BUDGET
  const estimate = input.estimate ?? ((text: string) => Math.ceil(text.length / 4))
  const selected: T[] = []
  let total = 0
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]!
    if (!input.isUser(message)) continue
    const text = input.text(message)
    if (!text) continue
    const size = estimate(text)
    if (total > 0 && total + size > budget) break
    selected.push(message)
    total += size
    if (total >= budget) break
  }
  return selected.reverse()
}

export function recipePrompt(input: {
  conversation: string
  focus?: string
  previousSummary?: string
  recentUsers: readonly string[]
  context: readonly string[]
}) {
  const focus = input.focus?.trim()
  const recent = input.recentUsers.length
    ? `<recent-user-messages>\n${input.recentUsers.join("\n\n")}\n</recent-user-messages>`
    : ""
  const context = input.context.filter(Boolean).join("\n\n")
  return [
    "Create a stable handoff summary for the next agent. Do not add timestamps, transient status, or details that are not supported by the supplied context.",
    focus ? `User focus for this summary: ${focus}` : "",
    "Preserve the recent user messages verbatim in the summary where relevant. Use exactly these headings and concise bullets:",
    "## Goal\n## Decisions\n## Files Touched\n## Open TODOs\n## Errors Seen\n## Next Step",
    input.previousSummary ? `Prior summary to carry forward:\n${input.previousSummary}` : "",
    `Conversation history:\n<conversation>\n${input.conversation}\n</conversation>`,
    recent,
    context ? `Context to restore after compaction:\n${context}` : "",
    "Use exact paths, commands, identifiers, and error messages. Mark unknown fields as (none). Do not continue the task or address questions in the conversation.",
  ].filter(Boolean).join("\n\n")
}

export function compactionIneffective(beforeTokens: number, afterTokens: number) {
  if (!Number.isFinite(beforeTokens) || beforeTokens <= 0 || !Number.isFinite(afterTokens)) return true
  return afterTokens > beforeTokens * 0.8
}
