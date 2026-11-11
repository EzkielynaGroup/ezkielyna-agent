// U4 `/context`: what fills the model's context window, by part, as tokens and % of the model's real window.
// Sizes come from the last request actually sent for the session (recorded at the LLM boundary). Tokens are estimated
// at 4 characters per token, then scaled to the gateway's measured prompt tokens of the last turn when that is known.
export const CHARS_PER_TOKEN = 4

export type ContextPart = "system" | "tools" | "instructions" | "memory" | "messages"

export type ContextRequest = {
  /** the final system messages sent (memory included) */
  system: string[]
  /** the system parts before plugins ran, used to find the AGENTS.md / CLAUDE.md instruction blocks */
  baseSystem: string[]
  /** tool name -> definition as sent (description + JSON schema) */
  tools: Record<string, unknown>
  messages: unknown[]
  memoryBlock?: string
  modelID: string
  /** the model's context window in tokens */
  window: number
}

/**
 * What /context needs from a request, without holding the request itself: character counts of the big parts (tools,
 * messages) and the system strings (a few KB), never the message or tool objects. Recorded once per provider request.
 */
export type ContextSizes = {
  system: string[]
  instructionChars: number
  toolsChars: number
  messagesChars: number
  memoryBlock?: string
  modelID: string
  window: number
}

export type ContextBreakdown = {
  modelID: string
  window: number
  used: number
  usedPct: number
  /** "measured" when scaled to the gateway's token count, "estimated" otherwise */
  source: "measured" | "estimated"
  rows: { part: ContextPart; tokens: number; pct: number }[]
}

export function sizeRequest(request: ContextRequest): ContextSizes {
  return {
    system: [...request.system],
    instructionChars: request.baseSystem.filter((s) => s.startsWith("Instructions from: ")).reduce((sum, s) => sum + s.length, 0),
    toolsChars: Object.entries(request.tools).reduce((sum, [name, def]) => sum + name.length + size(def), 0),
    messagesChars: size(request.messages),
    memoryBlock: request.memoryBlock,
    modelID: request.modelID,
    window: request.window,
  }
}

export function contextBreakdown(input: ContextRequest | ContextSizes, measuredPromptTokens?: number): ContextBreakdown {
  const request = "toolsChars" in input ? input : sizeRequest(input)
  const systemChars = request.system.reduce((sum, s) => sum + s.length, 0)
  const instructionChars = request.instructionChars
  const memoryChars = request.memoryBlock && request.system.some((s) => s.includes(request.memoryBlock!)) ? request.memoryBlock.length : 0
  const chars: Record<ContextPart, number> = {
    system: Math.max(0, systemChars - instructionChars - memoryChars),
    tools: request.toolsChars,
    instructions: instructionChars,
    memory: memoryChars,
    messages: request.messagesChars,
  }
  const estimated = Object.values(chars).reduce((sum, c) => sum + c / CHARS_PER_TOKEN, 0)
  const scale = measuredPromptTokens && estimated > 0 ? measuredPromptTokens / estimated : 1
  const rows = (Object.keys(chars) as ContextPart[]).map((part) => {
    const tokens = Math.round((chars[part] / CHARS_PER_TOKEN) * scale)
    return { part, tokens, pct: percent(tokens, request.window) }
  })
  const used = rows.reduce((sum, r) => sum + r.tokens, 0)
  return {
    modelID: request.modelID,
    window: request.window,
    used,
    usedPct: percent(used, request.window),
    source: measuredPromptTokens ? "measured" : "estimated",
    rows,
  }
}

function percent(tokens: number, window: number) {
  return window > 0 ? Math.round((tokens / window) * 1000) / 10 : 0
}

/** JSON length, skipping functions (tool executors) and cycles. */
export function size(value: unknown) {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "function") return undefined
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return undefined
          seen.add(v)
        }
        return v
      })?.length ?? 0
    )
  } catch {
    return 0
  }
}

/** Keeps the last request (as sizes, see ContextSizes) per session, for /context. Bounded. */
export class RequestLog {
  private items = new Map<string, ContextRequest | ContextSizes>()
  constructor(private readonly max = 32) {}
  record(sessionID: string, request: ContextRequest | ContextSizes) {
    this.items.delete(sessionID)
    this.items.set(sessionID, request)
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!)
  }
  get(sessionID: string) {
    return this.items.get(sessionID)
  }
  forget(sessionID: string) {
    this.items.delete(sessionID)
  }
}
