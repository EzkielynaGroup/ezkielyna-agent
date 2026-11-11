// X1 `ezkielyna exec --json`: translate the agent's bus events (the same ones `run --format json` prints raw) into
// Codex-compatible JSONL (codex-rs exec/src/exec_events.rs, R1 §5.1): thread.started, turn.started/completed/failed,
// item.started/updated/completed and error. Item types: agent_message, reasoning, command_execution, file_change,
// mcp_tool_call, web_search, todo_list, error. Pure: no I/O, so it is unit-tested with recorded event shapes.

export type CodexUsage = { input_tokens: number; cached_input_tokens: number; output_tokens: number }

export type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string
      type: "command_execution"
      command: string
      aggregated_output: string
      exit_code: number | null
      status: "in_progress" | "completed" | "failed" | "declined"
    }
  | { id: string; type: "file_change"; changes: { path: string; kind: "add" | "update" | "delete" }[]; status: "completed" | "failed" }
  | {
      id: string
      type: "mcp_tool_call"
      server: string
      tool: string
      arguments: unknown
      result: { content: { type: "text"; text: string }[] } | null
      error: { message: string } | null
      status: "in_progress" | "completed" | "failed"
    }
  | { id: string; type: "web_search"; query: string }
  | { id: string; type: "todo_list"; items: { text: string; completed: boolean }[] }
  | { id: string; type: "error"; message: string }

export type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.updated"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | { type: "error"; message: string }

/** Minimal shapes of the bus events this mapper reads (opencode SDK v2 event payloads). */
export type BusEvent = { type: string; properties?: any }

type Tokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }

export type StepInfo = { id: string; modelID: string; providerID: string; tokens: Tokens; cost: number }

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"])
const SHELL_TOOLS = new Set(["bash", "shell"])

export class CodexEventMapper {
  private next = 0
  private items = new Map<string, { id: string; last?: string; done: boolean }>()
  private steps = new Map<string, StepInfo>()
  private turnUsage: CodexUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
  /** text of the newest completed agent message (for --output-last-message and --output-schema) */
  lastMessage = ""
  errors: string[] = []

  constructor(private readonly sessionID: string) {}

  threadStarted(): CodexEvent {
    return { type: "thread.started", thread_id: this.sessionID }
  }

  turnStarted(): CodexEvent {
    this.turnUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
    return { type: "turn.started" }
  }

  turnCompleted(): CodexEvent {
    return { type: "turn.completed", usage: { ...this.turnUsage } }
  }

  turnFailed(message: string): CodexEvent {
    return { type: "turn.failed", error: { message } }
  }

  error(message: string): CodexEvent {
    return { type: "error", message }
  }

  /** completed provider steps (assistant messages) seen so far, for --max-turns and --max-budget */
  completedSteps() {
    return [...this.steps.values()]
  }

  map(event: BusEvent): CodexEvent[] {
    const p = event.properties ?? {}
    if (event.type === "message.updated") return this.message(p.info)
    if (event.type === "message.part.updated") return this.part(p.part)
    if (event.type === "session.error" && p.sessionID === this.sessionID && p.error) {
      const message = errorText(p.error)
      this.errors.push(message)
      return [{ type: "error", message }]
    }
    return []
  }

  private message(info: any): CodexEvent[] {
    if (!info || info.sessionID !== this.sessionID || info.role !== "assistant" || !info.time?.completed) return []
    if (this.steps.has(info.id)) return []
    const tokens: Tokens = info.tokens ?? {}
    this.steps.set(info.id, { id: info.id, modelID: info.modelID, providerID: info.providerID, tokens, cost: info.cost ?? 0 })
    const read = tokens.cache?.read ?? 0
    this.turnUsage.input_tokens += (tokens.input ?? 0) + read + (tokens.cache?.write ?? 0)
    this.turnUsage.cached_input_tokens += read
    this.turnUsage.output_tokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0)
    if (!info.error) return []
    const message = errorText(info.error)
    if (/abort/i.test(message)) return []
    this.errors.push(message)
    return [{ type: "item.completed", item: { id: this.id(`err:${info.id}`), type: "error", message } }]
  }

  private part(part: any): CodexEvent[] {
    if (!part || part.sessionID !== this.sessionID) return []
    if ((part.type === "text" || part.type === "reasoning") && part.time?.end && !part.synthetic) {
      const text = String(part.text ?? "").trim()
      if (!text || this.items.get(part.id)?.done) return []
      const id = this.id(part.id)
      this.items.get(part.id)!.done = true
      if (part.type === "reasoning") return [{ type: "item.completed", item: { id, type: "reasoning", text } }]
      this.lastMessage = text
      return [{ type: "item.completed", item: { id, type: "agent_message", text } }]
    }
    if (part.type === "tool") return this.tool(part)
    return []
  }

  private tool(part: any): CodexEvent[] {
    const state = part.state ?? {}
    // "pending" is the model still streaming the arguments; the item starts once the tool runs
    if (state.status === "pending") return []
    const known = this.items.get(part.id)
    if (known?.done) return []
    const finished = state.status === "completed" || state.status === "error"
    const id = this.id(part.id)
    const entry = this.items.get(part.id)!
    const item = toItem(id, part.tool, state)
    if (!item) return []
    if (finished) {
      entry.done = true
      if (item.type === "file_change" || item.type === "todo_list" || item.type === "web_search") return [{ type: "item.completed", item }]
      return [...(known ? [] : [{ type: "item.started" as const, item: { ...item, ...inProgress(item) } }]), { type: "item.completed", item }]
    }
    if (item.type === "file_change" || item.type === "todo_list" || item.type === "web_search") return []
    const snapshot = JSON.stringify(item)
    if (!known) {
      entry.last = snapshot
      return [{ type: "item.started", item }]
    }
    if (entry.last === snapshot) return []
    entry.last = snapshot
    return [{ type: "item.updated", item }]
  }

  private id(key: string) {
    const found = this.items.get(key)
    if (found) return found.id
    const id = `item_${this.next++}`
    this.items.set(key, { id, done: false })
    return id
  }
}

function inProgress(item: CodexItem) {
  if (item.type === "command_execution") return { status: "in_progress" as const, exit_code: null, aggregated_output: "" }
  if (item.type === "mcp_tool_call") return { status: "in_progress" as const, result: null, error: null }
  return {}
}

function toItem(id: string, tool: string, state: any): CodexItem | undefined {
  const input = state.input ?? {}
  const metadata = state.metadata ?? {}
  const done = state.status === "completed"
  const failed = state.status === "error"
  if (SHELL_TOOLS.has(tool)) {
    const exit = typeof metadata.exit === "number" ? metadata.exit : null
    const declined = failed && /reject|denied|permission/i.test(String(state.error ?? ""))
    return {
      id,
      type: "command_execution",
      command: String(input.command ?? ""),
      aggregated_output: String(metadata.output ?? state.output ?? (failed ? (state.error ?? "") : "")),
      exit_code: exit,
      status: declined ? "declined" : failed || (done && exit !== null && exit !== 0) ? "failed" : done ? "completed" : "in_progress",
    }
  }
  if (EDIT_TOOLS.has(tool)) {
    if (!done && !failed) return { id, type: "file_change", changes: [], status: "completed" }
    return { id, type: "file_change", changes: fileChanges(tool, input, metadata), status: failed ? "failed" : "completed" }
  }
  if (tool === "todowrite") {
    const todos: any[] = Array.isArray(input.todos) ? input.todos : []
    return { id, type: "todo_list", items: todos.map((t) => ({ text: String(t.content ?? ""), completed: t.status === "completed" })) }
  }
  if (tool === "websearch") return { id, type: "web_search", query: String(input.query ?? "") }
  return {
    id,
    type: "mcp_tool_call",
    server: "ezkielyna",
    tool,
    arguments: input,
    result: done ? { content: [{ type: "text", text: String(state.output ?? "") }] } : null,
    error: failed ? { message: String(state.error ?? "failed") } : null,
    status: done ? "completed" : failed ? "failed" : "in_progress",
  }
}

function fileChanges(tool: string, input: any, metadata: any): { path: string; kind: "add" | "update" | "delete" }[] {
  if (tool === "apply_patch" && Array.isArray(metadata.files)) {
    return metadata.files.map((f: any) => ({
      path: String(f.relativePath ?? f.filePath ?? ""),
      kind: f.type === "add" ? "add" : f.type === "delete" ? "delete" : "update",
    }))
  }
  const file = String(input.filePath ?? input.path ?? metadata.filepath ?? "")
  if (!file) return []
  return [{ path: file, kind: tool === "write" && metadata.exists === false ? "add" : "update" }]
}

function errorText(error: any): string {
  if (typeof error === "string") return error
  return String(error?.data?.message ?? error?.message ?? error?.name ?? "unknown error")
}
