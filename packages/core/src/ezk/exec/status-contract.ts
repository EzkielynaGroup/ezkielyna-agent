// JSON shape of GET /ezk/status: the few facts the desktop chips and the cost line need that no other route reports.
export type SandboxState = { active: boolean; kind: "bwrap" | "seatbelt" | "none"; reason?: string }

export type StatusResponse = {
  /** True state: the sandbox would really wrap a command in this session right now (tool found, mode allows it). */
  sandbox: SandboxState
  /** The web search tool is offered (feature on and a key is saved). */
  webSearch: boolean
  /** The background tasks feature is on. */
  exec: boolean
  /** Prices of the model, when known. perMtok is USD per 1M tokens after the group ratio. */
  price?: { model: string; groupRatio: number; perMtok: { input: number; output: number; cachedInput: number } }
  /** The context window the app uses for this model (model metadata `agentContext`). */
  agentContext?: number
}
