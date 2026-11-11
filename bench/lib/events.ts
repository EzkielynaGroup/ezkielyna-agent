// Turns the agent's JSONL output into bench metrics. Two formats are understood:
//   - `ezkielyna run --format json`: {type: step_start|step_finish|tool_use|text|error, part}
//   - `ezkielyna exec --json` (Codex-compatible): thread.started, turn.started/completed/failed,
//     item.started/updated/completed with items agent_message, command_execution, file_change, mcp_tool_call, error.

export type Tokens = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number }

export type Metrics = {
  /** Model calls (one per step_finish). For exec output this is approximated, see measureExec. */
  turns: number
  tokens: Tokens
  /** Cost reported by the agent's own events (0 when the agent has no client-side prices). */
  cost: number
  cacheHitRatio: number | null
  toolCalls: number
  toolErrors: { tool: string; error: string }[]
  /** Subset of toolErrors from file-editing tools (edit, write, apply_patch, ...). */
  editFailures: number
  errors: string[]
  /** All assistant text, used to grade Q&A tasks. */
  answer: string
}

export const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])

export function parseLines(stdout: string) {
  return stdout.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) return []
    try {
      return [JSON.parse(trimmed) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

export function measure(events: Record<string, unknown>[]): Metrics {
  const codex = events.some((event) => typeof event.type === "string" && /^(thread|turn|item)\./.test(event.type))
  return codex ? measureExec(events as ExecEvent[]) : measureRun(events as RunEvent[])
}

function measureRun(events: RunEvent[]): Metrics {
  const steps = events.filter((event) => event.type === "step_finish").map((event) => event.part ?? {})
  const tools = events.filter((event) => event.type === "tool_use").map((event) => event.part ?? {})
  const sum = (pick: (tokens: RunTokens) => number | undefined) =>
    steps.reduce((total, step) => total + (pick(step.tokens ?? {}) ?? 0), 0)
  const tokens = {
    input: sum((tokens) => tokens.input),
    output: sum((tokens) => tokens.output),
    reasoning: sum((tokens) => tokens.reasoning),
    cache_read: sum((tokens) => tokens.cache?.read),
    cache_write: sum((tokens) => tokens.cache?.write),
  }
  const toolErrors = tools
    .filter((tool) => tool.state?.status === "error")
    .map((tool) => ({ tool: tool.tool ?? "?", error: String(tool.state?.error ?? "").slice(0, 300) }))
  return {
    turns: steps.length,
    tokens,
    cost: steps.reduce((total, step) => total + (step.cost ?? 0), 0),
    cacheHitRatio: hitRatio(tokens),
    toolCalls: tools.length,
    toolErrors,
    editFailures: toolErrors.filter((item) => EDIT_TOOLS.has(item.tool)).length,
    errors: events
      .filter((event) => event.type === "error")
      .map((event) => {
        const error = event.error as { name?: string; data?: { message?: string } } | undefined
        return String(error?.data?.message ?? error?.name ?? JSON.stringify(event.error)).slice(0, 300)
      }),
    answer: events
      .filter((event) => event.type === "text")
      .map((event) => event.part?.text ?? "")
      .join("\n\n"),
  }
}

// Codex events report usage per turn (input_tokens includes cached_input_tokens) and do not mark model calls, so
// "turns" is approximated as the completed tool items plus the agent messages, the closest observable proxy.
function measureExec(events: ExecEvent[]): Metrics {
  const items = events.filter((event) => event.type === "item.completed").map((event) => event.item ?? {})
  const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {})
  const sum = (pick: (u: ExecUsage) => number | undefined) => usage.reduce((total, u) => total + (pick(u) ?? 0), 0)
  const cached = sum((u) => u.cached_input_tokens)
  const tokens = {
    input: Math.max(0, sum((u) => u.input_tokens) - cached),
    output: sum((u) => u.output_tokens),
    reasoning: sum((u) => u.reasoning_output_tokens),
    cache_read: cached,
    cache_write: 0,
  }
  const toolItems = items.filter(
    (item) =>
      item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "error" && item.type !== "todo_list",
  )
  const toolErrors = toolItems
    .filter((item) => item.status === "failed" || item.status === "declined")
    .map((item) => ({
      tool: item.type === "file_change" ? "apply_patch" : String(item.tool ?? item.type ?? "?"),
      error: String(item.error ?? item.aggregated_output ?? item.status).slice(0, 300),
    }))
  const messages = items.filter((item) => item.type === "agent_message")
  return {
    turns: toolItems.length + messages.length,
    tokens,
    cost: sum((u) => u.cost_usd ?? u.cost),
    cacheHitRatio: hitRatio(tokens),
    toolCalls: toolItems.length,
    toolErrors,
    editFailures: toolErrors.filter((item) => item.tool === "apply_patch" || EDIT_TOOLS.has(item.tool)).length,
    errors: [
      ...events.filter((event) => event.type === "error").map((event) => String(event.message ?? "error")),
      ...events
        .filter((event) => event.type === "turn.failed")
        .map((event) => String(event.error?.message ?? "turn failed")),
      ...items.filter((item) => item.type === "error").map((item) => String(item.message ?? "error")),
    ].map((message) => message.slice(0, 300)),
    answer: messages.map((item) => item.text ?? "").join("\n\n"),
  }
}

function hitRatio(tokens: Tokens) {
  const prompt = tokens.input + tokens.cache_read
  return prompt > 0 ? tokens.cache_read / prompt : null
}

/** Router decisions from the local decision log (EZK_FEATURES=+router.log writes <data>/ezk/router.log.jsonl). */
export function summarizeRouter(log: string) {
  const records = parseLines(log) as { event?: string; tier?: string; model?: string; reason?: string }[]
  const count = (key: (record: (typeof records)[number]) => string | undefined) =>
    records.reduce<Record<string, number>>((out, record) => {
      const value = key(record)
      if (value) out[value] = (out[value] ?? 0) + 1
      return out
    }, {})
  return {
    decisions: records.filter((record) => (record.event ?? "decision") === "decision").length,
    fallbacks: records.filter((record) => record.event === "fallback").length,
    escalations: records.filter((record) => record.event === "escalation").length,
    models: count((record) => record.model),
    tiers: count((record) => record.tier),
    /** The model of the last decision, used to price the run when the agent picked models itself (ezk-auto). */
    lastModel: records.at(-1)?.model,
  }
}

type RunTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
type RunEvent = {
  type: string
  error?: unknown
  part?: {
    text?: string
    tool?: string
    cost?: number
    tokens?: RunTokens
    state?: { status?: string; error?: unknown }
  }
}
type ExecUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  cost?: number
  cost_usd?: number
}
type ExecEvent = {
  type: string
  message?: string
  error?: { message?: string }
  usage?: ExecUsage
  item?: {
    type?: string
    status?: string
    text?: string
    tool?: string
    message?: string
    error?: unknown
    aggregated_output?: string
  }
}
