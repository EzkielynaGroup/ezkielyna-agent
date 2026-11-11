export interface ToolCallPart {
  type: "tool-call"
  toolCallId: string
  toolName?: string
  [key: string]: unknown
}

export interface ToolResultPart {
  type: "tool-result"
  toolCallId: string
  toolName?: string
  output?: unknown
  [key: string]: unknown
}

export interface HistoryMessage {
  role: string
  content: unknown
}

function parts(message: HistoryMessage) {
  return Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : undefined
}

/** Pair every assistant tool call with exactly one result, repairing interrupted history before provider conversion. */
export function normalizeModelHistory<T extends HistoryMessage>(messages: T[], marker: string): T[] {
  const result: HistoryMessage[] = []
  const pending = new Map<string, ToolCallPart>()

  const flush = () => {
    if (!pending.size) return
    result.push({ role: "tool", content: [...pending.values()].map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      ...(call.toolName ? { toolName: call.toolName } : {}),
      output: { type: "text", value: marker },
    })) })
    pending.clear()
  }

  for (const message of messages) {
    const content = parts(message)
    if (message.role === "tool") {
      if (!content) continue
      const matched = content.filter((part): part is ToolResultPart =>
        part.type === "tool-result" && typeof part.toolCallId === "string" && pending.has(part.toolCallId),
      )
      for (const item of matched) pending.delete(item.toolCallId)
      if (matched.length) result.push({ ...message, content: matched })
      continue
    }

    flush()
    result.push(message)
    if (message.role !== "assistant" || !content) continue
    for (const part of content) {
      if (part.type !== "tool-call" || typeof part.toolCallId !== "string") continue
      pending.set(part.toolCallId, part as unknown as ToolCallPart)
    }
  }
  flush()
  return result as T[]
}

export const INTERRUPTED_BY_USER = "[interrupted by user]"
export const ABORTED = "[aborted]"
